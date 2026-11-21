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
  // Some public receiver networks use a leading ~ for non-ICAO addresses.
  // Retain these distinct identities rather than silently discarding surface
  // contacts, while still requiring a genuine recent GPS position.
  const hex=String(r.hex||'').trim().toLowerCase();
  if(!/^~?[a-f0-9]{6}$/.test(hex)||lat==null||lon==null||Math.abs(lat)>90||Math.abs(lon)>180||seenPos==null||seenPos<0||seenPos>45)continue;
  const km=distanceKm(center.lat,center.lon,lat,lon);
  if(km>center.radiusNm*1.852+6)continue;
  const baro=r.alt_baro,geom=r.alt_geom;
  const onGround=String(baro||'').toLowerCase()==='ground'||String(geom||'').toLowerCase()==='ground'||r.onGround===true||r.on_ground===true;
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
// Airplanes.live has restricted public API access for non-feeders since Aug 2026.
// Only try this optional additional source when the operator has access and
// explicitly enables AIRPLANES_LIVE_ENABLED=1 on Vercel. A 403 is a denied
// permission, never a cue to bypass the provider's access controls.
const airplanesCache=new Map();
const AIRPLANES_MIN_POLL_MS=180000;  // avoid exceeding reported free usage limits
function airplanesEnabled(){return process.env.AIRPLANES_LIVE_ENABLED==='1';}
function providerError(message,code){const e=new Error(message);e.code=code;return e;}
async function fetchAirplanesLive(icao,radiusNm){
 if(!airplanesEnabled())throw providerError('Requires approved Airplanes.live API access; set AIRPLANES_LIVE_ENABLED=1 after receiving it','DISABLED');
 const airport=AIRPORTS[icao];
 if(!airport)throw providerError('Unsupported airport','UNSUPPORTED_AIRPORT');
 const radius=Math.max(5,Math.min(airport.radiusNm,Math.round(radiusNm||airport.radiusNm)));
 const key=icao+':'+radius;
 const record=airplanesCache.get(key)||{};
 const now=Date.now();
 if(record.promise)return record.promise;
 if(record.data&&now-record.at<40000)return record.data;
 if(record.retryAfter>now)throw providerError(record.blockedReason||'Airplanes.live request cooldown active',record.blockedCode||'COOLDOWN');
 // Protect shared network access (though serverless instances can still have
 // independent memory and callers should use a cache at deployment level).
 if(record.requestedAt&&now-record.requestedAt<AIRPLANES_MIN_POLL_MS)
  throw providerError('Airplanes.live checked recently; waiting before next request','COOLDOWN');
 const request=(async()=>{
  const url=`https://api.airplanes.live/v2/point/${airport.lat}/${airport.lon}/${radius}`;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),6500);
  try{
   const response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json',
    'User-Agent':'JetlineCaptainGame/85 (+https://jetlinecaptain.vercel.app/)'}});
   if(response.status===403||response.status===401){
    airplanesCache.set(key,{requestedAt:now,retryAfter:Date.now()+86400000,
     blockedReason:'Airplanes.live denied API access (HTTP '+response.status+'); feeder or approved access needed',blockedCode:'ACCESS_DENIED'});
    throw providerError('Airplanes.live denied API access (HTTP '+response.status+'); feeder or approved access needed','ACCESS_DENIED');
   }
   if(response.status===429){
    airplanesCache.set(key,{requestedAt:now,retryAfter:Date.now()+1800000,
     blockedReason:'Airplanes.live rate-limited the request',blockedCode:'RATE_LIMITED'});
    throw providerError('Airplanes.live rate-limited the request','RATE_LIMITED');
   }
   if(!response.ok)throw providerError('Airplanes.live HTTP '+response.status,'UPSTREAM_ERROR');
   const raw=await response.json();
   const timestamp=providerTime(raw.now);
   if(!Array.isArray(raw.ac)||!timestamp)throw providerError('Airplanes.live returned no fresh aircraft snapshot','INVALID_SNAPSHOT');
   const position={...airport,radiusNm:radius};
   const result={aircraft:normalizeAircraft(raw.ac,position),asOf:new Date(timestamp).toISOString(),
    timestamp,provider:'Airplanes.live',sourceUrl:'https://airplanes.live/'};
   airplanesCache.set(key,{requestedAt:now,at:Date.now(),data:result});return result;
  }catch(err){
   const existing=airplanesCache.get(key)||{};
   if(!existing.blockedCode)airplanesCache.set(key,{requestedAt:now,
    retryAfter:Date.now()+AIRPLANES_MIN_POLL_MS,
    blockedReason:String(err.message||err).slice(0,120),blockedCode:err.code||'UNAVAILABLE'});
   throw err;
  }finally{clearTimeout(timer);}
 })();
 airplanesCache.set(key,{...record,requestedAt:now,promise:request});
 try{return await request;}finally{
  const current=airplanesCache.get(key);
  if(current?.promise===request){delete current.promise;airplanesCache.set(key,current);}
 }
}
async function fetchAirport(icao){
 const airport=AIRPORTS[icao];
 if(!airport){const e=new Error('Airport not configured for ADS-B polling');e.status=400;throw e;}
 const cached=cache.get(icao),time=Date.now();
 if(cached&&cached.data&&time-cached.time<40000)return cached.data;
 if(cached&&cached.promise)return cached.promise;
 const url=`https://api.adsb.lol/v2/point/${airport.lat}/${airport.lon}/${airport.radiusNm}`;
 const promise=(async()=>{
  let data;
  let adsbError='';
  try{
   const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),9500);
   let response;
   try{response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json',
    'User-Agent':'JetlineCaptainGame/85 (+https://www.adsb.lol/)'}});}
   finally{clearTimeout(timeout)}
   if(!response.ok)throw new Error(`ADSB.lol upstream HTTP ${response.status}`);
   const raw=await response.json();
   if(!Array.isArray(raw.ac))throw new Error('ADSB.lol response missing aircraft list');
   const stamp=providerTime(raw.now);
   if(!stamp)throw new Error('ADSB.lol timestamp is missing or stale');
   data={airport:icao,reference:[airport.lat,airport.lon],asOf:new Date(stamp).toISOString(),
    provider:'ADSB.lol',source:'ADSB.lol receiver-observed ADS-B/MLAT (ODbL 1.0)',
    sourceUrl:'https://www.adsb.lol/',aircraft:normalizeAircraft(raw.ac,airport),
    runways:icao==='WSSS'?WSSS_RUNWAYS:[],selectedRunway:null,
    coverage:'Receiver-dependent; no verified gates, taxiways or ATC clearances.'};
  }catch(err){adsbError=String(err.message||err).slice(0,160);}
  if(!data){
   try{
    const alternate=await fetchAirplanesLive(icao,airport.radiusNm);
    data={airport:icao,reference:[airport.lat,airport.lon],asOf:alternate.asOf,
     provider:'Airplanes.live',source:'Airplanes.live receiver-observed ADS-B/MLAT',
     sourceUrl:'https://airplanes.live/',aircraft:alternate.aircraft,
     runways:icao==='WSSS'?WSSS_RUNWAYS:[],selectedRunway:null,
     coverage:'Receiver-dependent; no verified gates, taxiways or ATC clearances.'};
   }catch(secondaryErr){
    const e=new Error(`ADSB.lol: ${adsbError}; Airplanes.live: ${secondaryErr.message}`);
    e.status=503;throw e;
   }
  }
  data.providers=[{name:'ADSB.lol',status:adsbError?'unavailable':'connected',error:adsbError||undefined},
   {name:'Airplanes.live',status:data.provider==='Airplanes.live'?'connected':
    airplanesEnabled()?'standby':'disabled',reason:!airplanesEnabled()?'Approved feeder/API access required':undefined}];
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

// ADS-B Exchange operates its OWN receiver network, which may show surface
// positions absent from ADSB.lol. Its official v2 REST API is licensed and
// requires an X-Api-Key. Never scrape globe.adsbexchange.com or bypass access.
const adsbxWSSSCache={time:0,data:null,promise:null,retryAfter:0,errCode:''};
function adsbxEnabled(){return !!String(process.env.ADSBX_API_KEY||'').trim();}
async function fetchADSBExchangeWSSS(){
 if(!adsbxEnabled())throw providerError('ADSBX_API_KEY is not configured in Vercel','DISABLED');
 const now=Date.now(),c=adsbxWSSSCache;
 if(c.data&&now-c.time<40000)return c.data;
 if(c.promise)return c.promise;
 if(c.retryAfter>now)throw providerError('ADS-B Exchange request on cooldown',c.errCode||'COOLDOWN');
 const work=(async()=>{
  const center=AIRPORTS.WSSS;
  // Official API v2 documented path, ground-oriented 12 NM radius.
  const url=`https://gateway.adsbexchange.com/api/aircraft/v2/lat/${center.lat}/lon/${center.lon}/dist/12`;
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
  try{
   const response=await fetch(url,{signal:controller.signal,headers:{
    'x-api-key':String(process.env.ADSBX_API_KEY).trim(),
    'Accept':'application/json','Accept-Encoding':'gzip',
    'User-Agent':'JetlineCaptainGame/86 (+https://jetlinecaptain.vercel.app/)'
   }});
   if(!response.ok){
    const code=(response.status===401||response.status===402||response.status===403)?'ACCESS_DENIED':
      response.status===429?'RATE_LIMITED':'UPSTREAM_ERROR';
    c.errCode=code;c.retryAfter=Date.now()+((code==='ACCESS_DENIED')?3600000:code==='RATE_LIMITED'?120000:30000);
    throw providerError('ADS-B Exchange HTTP '+response.status,code);
   }
   const raw=await response.json();
   if(!Array.isArray(raw?.ac))throw providerError('Invalid ADS-B Exchange aircraft data','INVALID_SNAPSHOT');
   const timestamp=providerTime(raw.now)||Date.now();
   const aircraft=normalizeAircraft(raw.ac,{...center,radiusNm:12});
   const result={aircraft,provider:'ADS-B Exchange',asOf:new Date(timestamp).toISOString(),timestamp};
   c.data=result;c.time=Date.now();c.retryAfter=0;c.errCode='';return result;
  }finally{clearTimeout(timeout);}
 })();
 c.promise=work;
 try{return await work;}finally{if(c.promise===work)c.promise=null;}
}
// WSSS on-ground coverage can be patchy. Only explicit surface flags count as
// ground aircraft; altitude/low speed alone must NEVER become a live ground dot.
const wsssGroundCache={time:0,promise:null,data:null};
function wsssVicinity(a){
 return Number.isFinite(a.lat)&&Number.isFinite(a.lon)&&
  a.lat>=1.307&&a.lat<=1.399&&a.lon>=103.961&&a.lon<=104.031;
}
async function fetchWSSSGround(){
 const now=Date.now();
 if(wsssGroundCache.data&&now-wsssGroundCache.time<36000)return wsssGroundCache.data;
 if(wsssGroundCache.promise)return wsssGroundCache.promise;
 const work=(async()=>{
  let primary=null,primaryError='';
  try{primary=await fetchAirport('WSSS');}catch(err){primaryError=String(err.message||err);}
  const primaryNear=(primary?.aircraft||[]).filter(wsssVicinity);
  const primaryGround=primaryNear.filter(a=>a.onGround&&a.seenPos<=45);
  const providers=[{name:'ADSB.lol',status:primary?.provider==='ADSB.lol'?'connected':
    primary?.provider==='Airplanes.live'?'unavailable':primaryError?'unavailable':'unknown',
    near:primary?.provider==='ADSB.lol'?primaryNear.length:0,
    ground:primary?.provider==='ADSB.lol'?primaryGround.length:0,
    error:primaryError||undefined}];
  let alternate=[],secondaryStamp=null,secondaryStatus=airplanesEnabled()?'standby':'disabled';
  let secondaryError=airplanesEnabled()?'':'Requires approved feeder/API access; enable AIRPLANES_LIVE_ENABLED=1 on Vercel';
  if(primary?.provider==='Airplanes.live'){
   alternate=primaryNear;
   secondaryStamp=Date.parse(primary.asOf);
   secondaryStatus='connected';secondaryError='';
  }else if(primaryGround.length===0 && airplanesEnabled()){
   try{
    // Optional, access-restricted independent receiver network. Never
    // infer live ground contacts from speed/altitude alone.
    const feed=await fetchAirplanesLive('WSSS',13);
    alternate=feed.aircraft.filter(wsssVicinity);secondaryStamp=feed.timestamp;
    secondaryStatus='connected';secondaryError='';
   }catch(err){
    secondaryStatus=err.code==='ACCESS_DENIED'?'access_denied':
      err.code==='RATE_LIMITED'?'rate_limited':err.code==='COOLDOWN'?'cooldown':'unavailable';
    secondaryError=String(err.message||err).slice(0,125);
   }
  }
  const extraGround=alternate.filter(a=>a.onGround&&a.seenPos<=45);
  providers.push({name:'Airplanes.live',status:secondaryStatus,near:alternate.length,
   ground:extraGround.length,error:secondaryError||undefined});
  let exchange=[],exchangeStamp=null;
  let exchangeStatus=adsbxEnabled()?'standby':'disabled';
  let exchangeError=adsbxEnabled()?'':'Requires an authorized ADS-B Exchange v2 API key';
  if(primaryGround.length===0&&extraGround.length===0&&adsbxEnabled()){
   try{
    const feed=await fetchADSBExchangeWSSS();
    exchange=feed.aircraft.filter(wsssVicinity);exchangeStamp=feed.timestamp;
    exchangeStatus='connected';exchangeError='';
   }catch(err){
    exchangeStatus=err.code==='ACCESS_DENIED'?'access_denied':
      err.code==='RATE_LIMITED'?'rate_limited':'unavailable';
    exchangeError=String(err.message||err).slice(0,125);
   }
  }
  const exchangeGround=exchange.filter(a=>a.onGround&&a.seenPos<=45);
  providers.push({name:'ADS-B Exchange',status:exchangeStatus,near:exchange.length,
   ground:exchangeGround.length,error:exchangeError||undefined});
  const observedNear=new Map();
  for(const a of [...primaryNear,...alternate,...exchange]){
   const prev=observedNear.get(a.hex);
   if(!prev||prev.seenPos>a.seenPos)observedNear.set(a.hex,a);
  }
  const aircraft=[...observedNear.values()].filter(a=>a.onGround&&a.seenPos<=45)
   .sort((a,b)=>a.km-b.km).slice(0,160);
  const asOf=primary?.asOf||(secondaryStamp?new Date(secondaryStamp).toISOString():null)||(exchangeStamp?new Date(exchangeStamp).toISOString():null);
  if(!asOf){const e=new Error(primaryError||secondaryError||'Neither source returned a fresh snapshot');e.status=503;throw e;}
  const used=providers.filter(p=>p.status==='connected').map(p=>p.name);
  const source=used.join(' + ')+' · receiver-observed ADS-B/MLAT';
  const result={airport:'WSSS',asOf,source,
   sourceUrl:used.includes('ADS-B Exchange')?'https://www.adsbexchange.com/':primary?.provider==='Airplanes.live'?'https://airplanes.live/':'https://www.adsb.lol/',
   secondarySourceUrl:'https://airplanes.live/',licensedSourceUrl:'https://www.adsbexchange.com/',providers,aircraft,
   diagnostics:{reportedGround:aircraft.length,observedNearWSSS:observedNear.size,
    lowAltitudeNotGround:[...observedNear.values()].filter(a=>!a.onGround&&a.altFt!=null&&a.altFt<500).length,
    status:aircraft.length?'LIVE_GROUND_OBSERVED':'NO_GROUND_POSITIONS_REPORTED',
    airplanesLiveAccess:secondaryStatus,adsbxAccess:exchangeStatus},
   coverage:'Receiver coverage at runway level varies; no ground coordinates are fabricated. ADS-B Exchange API requires an authorized license/key; Airplanes.live may reject unapproved requests.'};
  wsssGroundCache.data=result;wsssGroundCache.time=Date.now();return result;
 })();
 wsssGroundCache.promise=work;
 try{return await work;}finally{if(wsssGroundCache.promise===work)wsssGroundCache.promise=null;}
}

module.exports={AIRPORTS,WSSS_RUNWAYS,normalizeAircraft,fetchAirport,fetchWSSSGround,errorResponse,fetchAirplanesLive,fetchADSBExchangeWSSS};
