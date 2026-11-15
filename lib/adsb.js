'use strict';
// Public, receiver-observed ADS-B/MLAT data. No gate, ATC, or runway clearance inference.
// Source: https://api.adsb.lol/docs ; ODbL 1.0 attribution required.
const AIRPORTS = Object.freeze({
 WSSS:{name:'Singapore Changi',lat:1.3508,lon:103.9940,radiusNm:65},
 WSAP:{name:'Paya Lebar',lat:1.3603,lon:103.9099,radiusNm:55},
 WMKK:{name:'Kuala Lumpur',lat:2.7456,lon:101.7072,radiusNm:65},
 VTBS:{name:'Bangkok Suvarnabhumi',lat:13.6900,lon:100.7501,radiusNm:65},
 VHHH:{name:'Hong Kong',lat:22.3080,lon:113.9185,radiusNm:65},
 RPLL:{name:'Manila',lat:14.5086,lon:121.0198,radiusNm:65},
 WIII:{name:'Jakarta Soekarno-Hatta',lat:-6.1256,lon:106.6559,radiusNm:65},
 RJTT:{name:'Tokyo Haneda',lat:35.5494,lon:139.7798,radiusNm:65},
 YSSY:{name:'Sydney',lat:-33.9461,lon:151.1772,radiusNm:65}
});
const WSSS_RUNWAYS=[
 {id:'02L/20R',a:[1.34896389,103.97745],b:[1.38225833,103.99150556],source:'Game WSSS reference'},
 {id:'02C/20C',a:[1.32875278,103.98496111],b:[1.36204722,103.99901667],source:'Game WSSS reference'},
 {id:'02R/20L',a:[1.32238611,103.99984722],b:[1.35568056,104.01390278],source:'Game WSSS reference'}
];
const cache=new Map();
function distanceKm(a,b,c,d){
 const rad=Math.PI/180, dl=(c-a)*rad,dp=(d-b)*rad;
 const v=Math.sin(dl/2)**2+Math.cos(a*rad)*Math.cos(c*rad)*Math.sin(dp/2)**2;
 return 12742*Math.asin(Math.min(1,Math.sqrt(v)));
}
function numeric(v,fallback=null){
 return (typeof v==='number'&&Number.isFinite(v))?v:
  ((typeof v==='string'&&v.trim()!==''&&Number.isFinite(+v))?+v:fallback);
}
function normalizeAircraft(ac,center){
 if(!Array.isArray(ac))return [];
 const unique=new Map();
 for(const r of ac){
  if(!r||typeof r!=='object')continue;
  const lat=numeric(r.lat),lon=numeric(r.lon),seenPos=numeric(r.seen_pos);
  const hex=String(r.hex||'').trim().toLowerCase();
  if(!/^[a-f0-9]{6}$/.test(hex)||lat==null||lon==null||Math.abs(lat)>90||Math.abs(lon)>180||seenPos==null||seenPos<0||seenPos>45)continue;
  const km=distanceKm(center.lat,center.lon,lat,lon);
  if(km>center.radiusNm*1.852+6)continue;
  const baro=r.alt_baro,geom=r.alt_geom;
  const onGround=baro==='ground'||geom==='ground';
  const alt=numeric(baro,numeric(geom));
  const verticalRate=numeric(r.baro_rate,numeric(r.geom_rate,0));
  const flight=String(r.flight||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,14);
  const plane={hex,lat,lon,seenPos,
   callsign:flight,registration:String(r.r||'').trim().toUpperCase().slice(0,14),
   type:String(r.t||'').trim().toUpperCase().slice(0,10),
   altFt:onGround?0:alt,heading:((numeric(r.track,0)%360)+360)%360,
   speedKt:Math.max(0,numeric(r.gs,0)),verticalRate,onGround,
   trafficPhase:onGround?'GROUND':verticalRate>150?'CLIMBING':verticalRate< -150?'DESCENDING':'LEVEL',
   km:Math.round(km*10)/10};
  const existing=unique.get(hex);
  if(!existing||existing.seenPos>plane.seenPos)unique.set(hex,plane);
 }
 return Array.from(unique.values()).sort((a,b)=>a.km-b.km).slice(0,180);
}
function providerTime(now){
 const n=numeric(now);
 if(n==null)return null;
 const ms=n<1e11?n*1000:n;
 return ms>1e12&&ms<Date.now()+120000&&ms>Date.now()-180000?ms:null;
}
async function fetchAirport(icao){
 const airport=AIRPORTS[icao];
 if(!airport){const e=new Error('Airport not configured for ADS-B polling');e.status=400;throw e;}
 const cached=cache.get(icao),time=Date.now();
 if(cached&&cached.data&&time-cached.time<40000)return cached.data;
 if(cached&&cached.promise)return cached.promise;
 const url=`https://api.adsb.lol/v2/point/${airport.lat}/${airport.lon}/${airport.radiusNm}`;
 const promise=(async()=>{
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),9500);
  let response;
  try{response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json','User-Agent':'JetlineCaptainGame/83 (+https://www.adsb.lol/)'}})}
  finally{clearTimeout(timeout)}
  if(!response.ok){const e=new Error(`ADSB.lol upstream HTTP ${response.status}`);e.status=502;throw e;}
  const raw=await response.json();
  if(!Array.isArray(raw.ac))throw new Error('ADSB.lol response missing aircraft list');
  const stamp=providerTime(raw.now);
  if(!stamp)throw new Error('ADSB.lol timestamp is missing or stale');
  const data={airport:icao,reference:[airport.lat,airport.lon],asOf:new Date(stamp).toISOString(),
   source:'ADSB.lol receiver-observed ADS-B/MLAT (ODbL 1.0)',sourceUrl:'https://www.adsb.lol/',
   aircraft:normalizeAircraft(raw.ac,airport),runways:icao==='WSSS'?WSSS_RUNWAYS:[],
   selectedRunway:null,coverage:'Receiver-dependent. Not a verified gate, taxi position, flight plan or ATC clearance.'};
  cache.set(icao,{data,time:Date.now()});return data;
 })();
 cache.set(icao,{data:cached?.data||null,time:cached?.time||0,promise});
 try{return await promise;}finally{
  const current=cache.get(icao);
  if(current?.promise===promise)cache.set(icao,{data:current.data,time:current.time});
 }
}
function errorResponse(res,err){
 res.setHeader('Cache-Control','no-store');
 return res.status(err.status===400?400:503).json({error:'OSINT_FEED_UNAVAILABLE',message:String(err.message||err).slice(0,180),aircraft:[],live:false});
}
module.exports={AIRPORTS,WSSS_RUNWAYS,normalizeAircraft,fetchAirport,errorResponse};
