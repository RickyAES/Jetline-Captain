// Jetline Captain v100 — published callsign route + departure/arrival country.
// Paste into api/flight-route.js in GitHub. This replaces the existing function;
// it does not add another serverless-function slot to Vercel Hobby.
'use strict';
const URL='https://api.adsbdb.com/v0/callsign/';
const safe=(x,n=95)=>typeof x==='string'?x.trim().slice(0,n):'';
const airportCode=(a)=>{
  if(!a||typeof a!=='object')return '';
  for(const x of [a.iata_code,a.icao_code]){
    const s=safe(x,6).toUpperCase();
    if(/^[A-Z0-9]{3,4}$/.test(s))return s;
  }
  return '';
};
module.exports=async function handler(req,res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).json({error:'GET required'});
  const callsign=safe(req.query?.callsign,16).toUpperCase();
  if(!/^[A-Z0-9]{2,4}[0-9][A-Z0-9]{0,5}$/.test(callsign))return res.status(400).json({error:'Invalid flight callsign'});
  const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),7500);
  try{
    const response=await fetch(URL+encodeURIComponent(callsign),{headers:{Accept:'application/json'},signal:ctl.signal});
    if(!response.ok){
      if(response.status===404){res.setHeader('Cache-Control','public,s-maxage=240');return res.status(200).json({callsign,found:false,source:'ADSBdb'});}
      return res.status(503).json({error:'Route provider temporarily unavailable'});
    }
    const payload=await response.json(), route=payload?.response?.flightroute;
    if(!route||typeof route!=='object'){
      res.setHeader('Cache-Control','public,s-maxage=240');
      return res.status(200).json({callsign,found:false,source:'ADSBdb'});
    }
    const reported=[route.callsign,route.callsign_icao,route.callsign_iata].map(x=>safe(x,16).toUpperCase());
    if(!reported.includes(callsign))return res.status(200).json({callsign,found:false,source:'ADSBdb'});
    const origin=airportCode(route.origin), destination=airportCode(route.destination);
    if(!origin||!destination)return res.status(200).json({callsign,found:false,source:'ADSBdb'});
    res.setHeader('Cache-Control','public,s-maxage=900,stale-while-revalidate=900');
    return res.status(200).json({
      callsign,found:true,origin,destination,
      originName:safe(route.origin?.name),destinationName:safe(route.destination?.name),
      originCountry:safe(route.origin?.country_name,70),destinationCountry:safe(route.destination?.country_name,70),
      originCountryCode:safe(route.origin?.country_iso_name,2).toUpperCase(),
      destinationCountryCode:safe(route.destination?.country_iso_name,2).toUpperCase(),
      route:origin+'-'+destination,source:'ADSBdb',
      note:'Published callsign route; not confirmation of the itinerary flown today.'
    });
  }catch(err){return res.status(503).json({error:err?.name==='AbortError'?'Route lookup timed out':'Route lookup unavailable'});}
  finally{clearTimeout(timer);}
};
