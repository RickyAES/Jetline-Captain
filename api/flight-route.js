// Jetline Captain — on-demand public callsign-to-airport lookup.
// Returns only the route needed for the current UI. Does NOT infer HKT-SIN from proximity.
'use strict';
const SOURCE='https://api.adsbdb.com/v0/callsign/';
function airportCode(a){
  if(!a||typeof a!=='object')return '';
  for(const v of [a.iata_code,a.icao_code]){
    const code=String(v||'').trim().toUpperCase();
    if(/^[A-Z0-9]{3,4}$/.test(code))return code;
  }
  return '';
}
module.exports=async function handler(req,res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).json({error:'GET required'});
  const callsign=String(req.query?.callsign||'').trim().toUpperCase();
  if(!/^[A-Z]{2,4}[0-9][A-Z0-9]{0,5}$/.test(callsign))
    return res.status(400).json({error:'Invalid flight callsign'});
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),6000);
  try{
    const r=await fetch(SOURCE+encodeURIComponent(callsign),{
      method:'GET',signal:ctl.signal,headers:{Accept:'application/json'}
    });
    if(r.status===404){
      res.setHeader('Cache-Control','public, s-maxage=300');
      return res.status(200).json({callsign,found:false,source:'ADSBdb'});
    }
    if(!r.ok){
      res.setHeader('Cache-Control','no-store');
      return res.status(503).json({error:'Route data source unavailable'});
    }
    const payload=await r.json();
    const route=payload?.response?.flightroute;
    if(!route || typeof route!=='object'){
      res.setHeader('Cache-Control','public, s-maxage=300');
      return res.status(200).json({callsign,found:false,source:'ADSBdb'});
    }
    const reported=String(route.callsign_icao||route.callsign||'').trim().toUpperCase();
    if(reported && reported!==callsign && String(route.callsign||'').trim().toUpperCase()!==callsign){
      res.setHeader('Cache-Control','no-store');
      return res.status(200).json({callsign,found:false,source:'ADSBdb'});
    }
    const origin=airportCode(route.origin),destination=airportCode(route.destination);
    if(!origin||!destination){
      res.setHeader('Cache-Control','public, s-maxage=300');
      return res.status(200).json({callsign,found:false,source:'ADSBdb'});
    }
    res.setHeader('Cache-Control','public, s-maxage=900, stale-while-revalidate=900');
    return res.status(200).json({
      callsign,found:true,origin,destination,
      originName:String(route.origin?.name||'').slice(0,90),
      destinationName:String(route.destination?.name||'').slice(0,90),
      route:origin+'-'+destination,source:'ADSBdb',
      note:'Published callsign route; may differ from the itinerary flown today.'
    });
  }catch(e){
    res.setHeader('Cache-Control','no-store');
    return res.status(503).json({error:e?.name==='AbortError'?'Route lookup timed out':'Route lookup unavailable'});
  }finally{clearTimeout(timer);}
};
