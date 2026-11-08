// Jetline Captain /api/radar — live volunteer ADS-B positions, NOT simulator traffic.
// Endpoint: /api/radar?airport=WSSS or /api/radar?airport=EGLL&lat=...&lon=...
'use strict';
const AIRPORTS = require('../airports.json');
const SOURCE='https://api.adsb.lol';
// Runway geometry: CAAS AIP. This is a display-only synthetic grouping,
// not an operational airport or a source of ATC clearances.
const SG_AIRFIELDS={
 WSSS:{name:'Changi',lat:1.3501,lon:103.9947,groundRadiusKm:8.5,nearRadiusKm:24},
 WSSL:{name:'Seletar',lat:1.4169,lon:103.8677,groundRadiusKm:2.8,nearRadiusKm:12},
 WSAP:{name:'Paya Lebar',lat:1.3604,lon:103.9095,groundRadiusKm:4.3,nearRadiusKm:14}
};
const SG_OVERVIEW={name:'Singapore Airports',lat:1.3600,lon:103.9300};
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
  const known=icao==='SGALL'?SG_OVERVIEW:(SG_AIRFIELDS[icao]||null)|| (Object.prototype.hasOwnProperty.call(AIRPORTS,icao)?AIRPORTS[icao]:null);
  let airport=known;
  if(!known){
    // Worldwide airport locations are supplied from the public-domain international
    // airport directory on the radar page. This is a display-only geographic query.
    const lat=Number(req.query?.lat),lon=Number(req.query?.lon);
    const name=String(req.query?.name||icao).replace(/[<>]/g,'').slice(0,80);
    const allowed=/^[A-Z0-9]{3,5}$/.test(icao)
      && Number.isFinite(lat)&&Number.isFinite(lon)
      && lat>=-85&&lat<=85&&lon>=-180&&lon<=180;
    if(allowed)airport={lat,lon,name};
  }
  if(!airport)return res.status(400).json({error:'Unknown airport or invalid airport coordinates.'});
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
    const coverage={reportedAircraft:payload.ac.length,withPosition:0,freshPosition:0,
      groundSignal:0,groundWithPosition:0,groundNearChangi:0,taxiing:0,stopped:0,
      nearbyAirborne:0,groundNoPosition:0,sgGround:0,sgTaxiing:0,sgStopped:0,sgClimbing:0,sgDescending:0};
    // ADS-B v2 feeds can report `now` in milliseconds; normalize before constructing ISO dates.
    const rawNow=Number(payload.now);
    const nowMs=Number.isFinite(rawNow)&&rawNow>0?(rawNow>1e11?rawNow:rawNow*1000):Date.now();
    if(Date.now()-nowMs>180000)throw new Error('Stale aircraft feed');
    for(const a of payload.ac){
      const groundSignal=a.alt_baro==='ground';
      if(groundSignal)coverage.groundSignal++;
      if(!Number.isFinite(a.lat)||!Number.isFinite(a.lon)){
        if(groundSignal)coverage.groundNoPosition++;
        continue;
      }
      coverage.withPosition++;
      const dist=distanceKm(airport.lat,airport.lon,a.lat,a.lon);
      if(dist>100.0001)continue;
      const age=Number(a.seen_pos??a.seen??0);
      if(Number.isFinite(age)&&age>120)continue; // do not show stale positions as live
      coverage.freshPosition++;
      const callsign=String(a.flight||'').trim().toUpperCase().slice(0,14);
      const onGround=groundSignal;
      if(onGround)coverage.groundWithPosition++;
      const speedKt=a.gs!=null&&Number.isFinite(Number(a.gs))?Math.round(Number(a.gs)):null;
      // Surface ADS-B includes stationary aircraft. Previous 1-35kt condition hid
      // aircraft holding short or stopped on the apron. Include all recent on-ground
      // observations near WSSS; do not imply that 'stopped' means ready to depart.
      // This radius is an APPROXIMATE airport area, not a surveyed taxiway polygon.
      const altFt=a.alt_baro!=null&&Number.isFinite(Number(a.alt_baro))?Math.round(Number(a.alt_baro)):null;
      const rawRate=a.baro_rate??a.geom_rate;
      const verticalRateFpm=rawRate!=null&&Number.isFinite(Number(rawRate))?Math.round(Number(rawRate)):null;
      // Nearest Singapore airfield is approximate association, not verified
      // departure/arrival destination. Do NOT infer taxiway or clearance status.
      const nearAirfields=Object.entries(SG_AIRFIELDS).map(([code,field])=>({code,field,km:distanceKm(field.lat,field.lon,a.lat,a.lon)}));
      // Outside Singapore, associate low-altitude/ground positions with the selected
      // airport only when geographically nearby. This is an approximation, never
      // a confirmed airport departure, stand or runway assignment.
      if(icao!=='SGALL'&&!SG_AIRFIELDS[icao])nearAirfields.push({code:icao,field:{name:airport.name,groundRadiusKm:airport.type==='large_airport'?7:4.5,nearRadiusKm:21},km:dist});
      nearAirfields.sort((x,y)=>x.km-y.km);
      const near=nearAirfields[0],nearAirport=near?.code||null;
      const groundAtAirport=!!(onGround&&near&&near.km<=near.field.groundRadiusKm&&Number.isFinite(age)&&age<=100);
      const groundAtChangi=groundAtAirport&&nearAirport==='WSSS';
      const taxiing=groundAtAirport&&Number.isFinite(speedKt)&&speedKt>2&&speedKt<=45;
      const stopped=groundAtAirport&&Number.isFinite(speedKt)&&speedKt<=2;
      const groundUnknown=groundAtAirport&&!Number.isFinite(speedKt);
      const nearbyAirfield=!!(near&&near.km<=near.field.nearRadiusKm&&altFt!==null&&altFt<=8000);
      let trafficPhase='AIRBORNE';
      if(groundAtAirport){
        trafficPhase=taxiing?'TAXIING':stopped?'STOPPED':groundUnknown?'ON GROUND':'GROUND ROLL';
      }else if(!onGround&&nearbyAirfield&&verticalRateFpm!==null){
        trafficPhase=verticalRateFpm<=-250?'DESCENDING':verticalRateFpm>=250?'CLIMBING':'AIRBORNE';
      }else if(onGround){trafficPhase='GROUND POSITION UNASSOCIATED';}
      const groundState=groundAtAirport
        ? (taxiing?'TAXIING (REPORTED MOVEMENT)':stopped?'STOPPED (PARKED / HOLDING UNKNOWN)':groundUnknown?'ON GROUND · SPEED UNKNOWN':'GROUND ROLL')
        : '';
      if(groundAtChangi)coverage.groundNearChangi++;
      if(taxiing&&groundAtChangi)coverage.taxiing++;
      if(stopped&&groundAtChangi)coverage.stopped++;
      if(icao==='WSSS'&&!onGround&&dist<=10)coverage.nearbyAirborne++;
      if(groundAtAirport){coverage.sgGround++;if(taxiing)coverage.sgTaxiing++;if(stopped)coverage.sgStopped++;}
      if(trafficPhase==='CLIMBING')coverage.sgClimbing++;
      if(trafficPhase==='DESCENDING')coverage.sgDescending++;
      aircraft.push({
        hex:String(a.hex||'').slice(0,14),callsign,
        lat:a.lat,lon:a.lon,km:Math.round(dist*10)/10,
        heading:Number.isFinite(Number(a.track))?Math.round(Number(a.track)):null,
        altFt,verticalRateFpm,
        speedKt,onGround,taxiing,groundAtChangi,stopped,groundUnknown,groundState,
        groundAtAirport,nearAirport,nearAirportName:near?.field.name||null,
        nearAirportKm:near?Math.round(near.km*10)/10:null,
        trafficPhase,phaseEstimated:trafficPhase==='CLIMBING'||trafficPhase==='DESCENDING',
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
      aircraft,groundCoverage:coverage,
      coverage:'Volunteer ADS-B coverage: only positioned reports displayed. Climbing/descending near airports suggests possible departure/arrival, not confirmed itinerary or runway clearance.'
    });
  }catch(err){
    res.setHeader('Cache-Control','no-store');
    return res.status(503).json({error:err?.name==='AbortError'?'Flight data request timed out.':'Flight data temporarily unavailable.'});
  }finally{clearTimeout(timer)}
};
