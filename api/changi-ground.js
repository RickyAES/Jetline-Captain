// Jetline Captain v7 — read-only WSSS ground-position adapter.
// Source: ADSB.lol open ADS-B positions (ODbL 1.0), NOT Flightradar24.
// Do not use for airport operations or claim physical gate occupancy.
const LAT=1.3501, LON=103.9947, MAX_KM=8.5;
const distanceKm=(a,b)=>{
  const d2r=Math.PI/180,dl=(a[0]-b[0])*d2r,dn=(a[1]-b[1])*d2r;
  const v=Math.sin(dl/2)**2+Math.cos(a[0]*d2r)*Math.cos(b[0]*d2r)*Math.sin(dn/2)**2;
  return 12742*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)));
};
export default async function handler(req,res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','public, s-maxage=25, stale-while-revalidate=10');
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  try{
    // Max distance in nautical miles: 10 nm covers MAX_KM 8.5 km.
    const upstream=await fetch('https://api.adsb.lol/v2/lat/1.3501/lon/103.9947/dist/10',{
      headers:{'Accept':'application/json'},signal:AbortSignal.timeout(9000),redirect:'error'
    });
    if(!upstream.ok)throw new Error('ADS-B source HTTP '+upstream.status);
    const response=await upstream.json();
    if(!Array.isArray(response?.ac))throw new Error('ADS-B response missing aircraft array');
    const out=[];const dedupe=new Set();
    for(const a of response.ac){
      if(!a||a.alt_baro!=='ground')continue;
      const lat=Number(a.lat),lon=Number(a.lon),seen=Number(a.seen_pos);
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(seen)||seen<0||seen>60)continue;
      const km=distanceKm([LAT,LON],[lat,lon]);if(km>MAX_KM)continue;
      const hex=String(a.hex||'').toLowerCase().replace(/[^0-9a-f]/g,'').slice(0,8);
      if(!hex||dedupe.has(hex))continue;dedupe.add(hex);
      const speed=Number(a.gs),track=Number(a.track);
      out.push({hex,callsign:String(a.flight||'').trim().slice(0,16),registration:String(a.r||'').slice(0,16),type:String(a.t||'').slice(0,12),
       lat,lon,speedKt:Number.isFinite(speed)?Math.max(0,Math.min(450,speed)):null,
       heading:Number.isFinite(track)?((track%360)+360)%360:null,seenPos:Math.round(seen*10)/10,km:Math.round(km*100)/100,
       onGround:true,gate:null,confirmedParked:false});
    }
    out.sort((a,b)=>a.km-b.km);
    return res.status(200).json({airport:'WSSS',source:'ADSB.lol · ODbL 1.0',asOf:new Date().toISOString(),
      groundCount:out.length,aircraft:out.slice(0,175),note:'Observed on-ground transponders near Changi. No gate or parking confirmation; ground coverage incomplete.'});
  }catch(e){
    return res.status(502).json({error:'ADS_B_GROUND_UNAVAILABLE',message:String(e.message).slice(0,150)});
  }
}
