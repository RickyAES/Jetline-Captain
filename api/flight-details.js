// Jetline Captain: optional live flight-status enrichment.
// A FlightAware AeroAPI key is a SERVER-SIDE environment variable on Vercel.
// Do not put it in index.html or config.js. Requests may be billed by provider.
'use strict';
const BASE='https://aeroapi.flightaware.com/aeroapi';
function txt(v,max=24){return typeof v==='string'?v.trim().slice(0,max):'';}
function time(v){
  if(!v || typeof v!=='string')return null;
  const n=Date.parse(v);
  return Number.isFinite(n)?new Date(n).toISOString():null;
}
function airportCode(o){
  const a=typeof o==='string'?o:o?.code_iata||o?.code_icao||o?.code_lid||o?.airport_code||'';
  const v=txt(a,6).toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(v)?v:'';
}
function flightMoment(f){
  return Date.parse(f.actual_off||f.estimated_off||f.scheduled_off||f.actual_out||f.estimated_out||f.scheduled_out||'')||NaN;
}
module.exports=async function handler(req,res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const callsign=txt(req.query?.callsign,14).toUpperCase();
  if(!/^[A-Z]{2,4}[0-9][A-Z0-9]{0,5}$/.test(callsign))return res.status(400).json({error:'Invalid flight callsign'});
  const key=process.env.FLIGHTAWARE_AEROAPI_KEY;
  if(!key){
    res.setHeader('Cache-Control','public, s-maxage=300');
    return res.status(200).json({callsign,status:'not_configured',source:'FlightAware AeroAPI',message:'Set FLIGHTAWARE_AEROAPI_KEY in Vercel environment variables to enable schedule lookups.'});
  }
  const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),8000);
  try{
    // Limit to a short current-day window. Never show a different day's scheduled flight as if it is current.
    const now=Date.now();
    const params=new URLSearchParams({start:new Date(now-24*3600000).toISOString(),end:new Date(now+12*3600000).toISOString(),max_pages:'1'});
    const response=await fetch(`${BASE}/flights/${encodeURIComponent(callsign)}?${params}`,{
      signal:ac.signal,headers:{'Accept':'application/json','x-apikey':key}
    });
    if(response.status===404){
      res.setHeader('Cache-Control','public, s-maxage=180');
      return res.status(200).json({callsign,status:'not_found',source:'FlightAware AeroAPI'});
    }
    if(!response.ok){
      res.setHeader('Cache-Control','no-store');
      return res.status(503).json({error:response.status===401||response.status===403?'Flight-status API permission or key error':response.status===429?'Flight-status API rate limited':'Flight-status API unavailable'});
    }
    const data=await response.json();
    if(!Array.isArray(data?.flights))throw new Error('Invalid flight status response');
    const nearby=data.flights.filter(f=>{
      const when=flightMoment(f);
      return Number.isFinite(when)&&Math.abs(when-now)<30*3600000;
    });
    nearby.sort((a,b)=>Math.abs(flightMoment(a)-now)-Math.abs(flightMoment(b)-now));
    const chosen=nearby[0];
    if(!chosen){
      res.setHeader('Cache-Control','public, s-maxage=180');
      return res.status(200).json({callsign,status:'not_found',source:'FlightAware AeroAPI',note:'No flight match within 30 hours.'});
    }
    const fields=['scheduled_out','estimated_out','actual_out','scheduled_off','estimated_off','actual_off','scheduled_in','estimated_in','actual_in','scheduled_on','estimated_on','actual_on'];
    const result={callsign,status:'found',source:'FlightAware AeroAPI',origin:airportCode(chosen.origin),destination:airportCode(chosen.destination),flightId:txt(chosen.fa_flight_id,80),flightStatus:txt(chosen.status,80),retrievedAt:new Date(now).toISOString()};
    for(const k of fields){const out=k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());result[out]=time(chosen[k]);}
    res.setHeader('Cache-Control','public, s-maxage=300, stale-while-revalidate=120');
    return res.status(200).json(result);
  }catch(e){
    res.setHeader('Cache-Control','no-store');
    return res.status(503).json({error:e?.name==='AbortError'?'Flight status request timed out':'Flight status temporarily unavailable'});
  }finally{clearTimeout(timer)}
};
