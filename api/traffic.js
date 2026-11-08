// Vercel serverless function: /api/traffic?lat=...&lon=...&r=25
// Data: adsb.lol ODbL 1.0. For production-scale use contact the data provider.
// Coverage is crowd-sourced and is NOT live ATC or runway clearance data.
export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const lat=Number(req.query.lat),lon=Number(req.query.lon),radius=Number(req.query.r||25);
  if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180||
     !Number.isFinite(radius)||radius<1||radius>35)return res.status(400).json({error:'Invalid coordinates or radius'});
  const upstream=`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`;
  try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),8000);
    let response;
    try{response=await fetch(upstream,{signal:controller.signal,headers:{'Accept':'application/json'}})}
    finally{clearTimeout(timeout)}
    if(!response.ok)throw new Error('ADSB provider HTTP '+response.status);
    const data=await response.json();
    const aircraft=(Array.isArray(data.ac)?data.ac:[]).filter(a=>
      Number.isFinite(+a.lat)&&Number.isFinite(+a.lon)&&Number(a.seen_pos??0)<120
    ).slice(0,220).map(a=>({
      hex:String(a.hex||'').slice(0,16),flight:String(a.flight||'').trim().slice(0,16),
      lat:Number(a.lat),lon:Number(a.lon),
      alt_baro:a.alt_baro==='ground'?'ground':(Number.isFinite(+a.alt_baro)?Number(a.alt_baro):null),
      gs:Number.isFinite(+a.gs)?Number(a.gs):0,
      track:Number.isFinite(+a.track)?Number(a.track):0,
      seen_pos:Number.isFinite(+a.seen_pos)?Number(a.seen_pos):0
    }));
    res.setHeader('Cache-Control','public, s-maxage=18, stale-while-revalidate=25');
    return res.status(200).json({aircraft,provider:'adsb.lol',license:'ODbL-1.0',observedAt:Date.now()});
  }catch(e){
    res.setHeader('Cache-Control','no-store');
    return res.status(503).json({error:'Live traffic temporarily unavailable',aircraft:[]});
  }
}
