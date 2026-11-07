// Jetline Captain /api/radar — live volunteer ADS-B positions, NOT simulator traffic.
// Endpoint: /api/radar?airport=WSSS  (known airports in airports.json only)
'use strict';
const AIRPORTS = require('../airports.json');
const SOURCE='https://api.adsb.lol';
function distanceKm(lat1,lon1,lat2,lon2){
  const radians=Math.PI/180;
  const a=Math.sin((lat2-lat1)*radians/2)**2+
    Math.cos(lat1*radians)*Math.cos(lat2*radians)*Math.sin((lon2-lon1)*radians/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(a)));
}
module.exports=async function handler(req,res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const icao=String(req.query?.airport||'WSSS').trim().toUpperCase();
  const known=Object.prototype.hasOwnProperty.call(AIRPORTS,icao)?AIRPORTS[icao]:null;
  let airport=known;
  if(!known){
    // Extra regional airfields supplied by the server's OurAirports catalogue.
    // Region bounds prevent this public endpoint being used for arbitrary global queries.
    const lat=Number(req.query?.lat),lon=Number(req.query?.lon);
    const name=String(req.query?.name||icao).replace(/[<>]/g,'').slice(0,80);
    const allowed= /^(?:[A-Z0-9][A-Z0-9-]{1,18})$/.test(icao)
      && Number.isFinite(lat)&&Number.isFinite(lon)
      && ((lat>=5.0&&lat<=21.0&&lon>=97.0&&lon<=106.0)
        || (lat>=-12.0&&lat<=7.0&&lon>=94.0&&lon<=143.0)
        || (lat>=1.0&&lat<=1.6&&lon>=103.5&&lon<=104.2));
    if(allowed)airport={lat,lon,name};
  }
  if(!airport)return res.status(400).json({error:'Unknown airport or invalid regional coordinates.'});
  // The provider point endpoint's radius unit is *nautical miles*.
  // Request ~101.9 km (55 nautical miles), then enforce an EXACT 100.0 km haversine radius below.
  const url=`${SOURCE}/v2/point/${airport.lat}/${airport.lon}/55`;
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),9500);
  try{
    const response=await fetch(url,{signal:ctl.signal,headers:{'Accept':'application/json','User-Agent':'JetlineCaptainRadar/1.0'}});
    if(!response.ok){
      res.setHeader('Cache-Control','no-store');
      return res.status(response.status===429?429:502).json({error:response.status===429?'Flight data rate limit reached; retry later.':'Live aircraft provider unavailable ('+response.status+').' });
    }
    const payload=await response.json();
    if(!Array.isArray(payload.ac))throw new Error('Unexpected aircraft feed response');
    const aircraft=[];
    // ADS-B v2 feeds can report `now` in milliseconds; normalize before constructing ISO dates.
    const rawNow=Number(payload.now);
    const nowMs=Number.isFinite(rawNow)&&rawNow>0?(rawNow>1e11?rawNow:rawNow*1000):Date.now();
    if(Date.now()-nowMs>180000)throw new Error('Stale aircraft feed');
    for(const a of payload.ac){
      if(!Number.isFinite(a.lat)||!Number.isFinite(a.lon))continue;
      const dist=distanceKm(airport.lat,airport.lon,a.lat,a.lon);
      if(dist>100.0001)continue;
      const age=Number(a.seen_pos??a.seen??0);
      if(Number.isFinite(age)&&age>120)continue; // do not show stale positions as live
      const callsign=String(a.flight||'').trim().toUpperCase().slice(0,14);
      const onGround=a.alt_baro==='ground';
      const speedKt=a.gs!=null&&Number.isFinite(Number(a.gs))?Math.round(Number(a.gs)):null;
      const taxiing=icao==='WSSS'&&onGround&&Number.isFinite(speedKt)&&speedKt>=1&&speedKt<=35&&dist<=6&&(!Number.isFinite(age)||age<=40);
      aircraft.push({
        hex:String(a.hex||'').slice(0,14),callsign,
        lat:a.lat,lon:a.lon,km:Math.round(dist*10)/10,
        heading:Number.isFinite(Number(a.track))?Math.round(Number(a.track)):null,
        altFt:a.alt_baro!=null&&Number.isFinite(Number(a.alt_baro))?Math.round(Number(a.alt_baro)):null,
        speedKt,onGround,taxiing,
        ageSec:Number.isFinite(age)?Math.max(0,Math.round(age)):null,
        type:String(a.t||'').trim().slice(0,16),
        registration:String(a.r||'').trim().slice(0,16),
        airline:callsign.startsWith('SIA')?'Singapore Airlines':null
      });
    }
    aircraft.sort((a,b)=>a.km-b.km);
    res.setHeader('Cache-Control','public, s-maxage=50, stale-while-revalidate=30');
    return res.status(200).json({
      airport:{icao,name:airport.name,lat:airport.lat,lon:airport.lon},
      radiusKm:100,asOf:new Date(nowMs).toISOString(),
      fetchedAt:new Date().toISOString(),provider:'adsb.lol',license:'ODbL-1.0',
      aircraft,coverage:'Volunteer ADS-B coverage; some flights may be missing or delayed.'
    });
  }catch(err){
    res.setHeader('Cache-Control','no-store');
    return res.status(503).json({error:err?.name==='AbortError'?'Flight data request timed out.':'Flight data temporarily unavailable.'});
  }finally{clearTimeout(timer)}
};
