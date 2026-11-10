// Current-airport METAR gateway for the Jetline Captain ND.
// AviationWeather.gov restricts browser CORS; use this Vercel server-side route.
// Observations are NOT precipitation-radar imagery or ATC clearances.
const CACHE = new Map();
const TTL = 180000;
const REPORT_MAX_AGE = 2 * 3600000;
const finite = value => value === null || value === undefined || value === '' ? null :
  Number.isFinite(Number(value)) ? Number(value) : null;
function parseVis(value){
  if(value == null || value === '')return null;
  const str=String(value).toUpperCase().trim();
  if(str.endsWith('+'))return finite(str.slice(0,-1));
  if(str.includes('/')){ const m=str.match(/^(\d+)?\s*(\d+)\/(\d+)$/);
   if(m)return (+m[1]||0)+(+m[2]/+m[3]); }
  return finite(str);
}
function statusFromWx(wx,raw){
 const text=String(wx||'').toUpperCase().trim();
 const obs=String(raw||'').toUpperCase();
 // Prefer coded present weather, never infer rain from cloud category alone.
 if(/\b(?:\+|-)?TS(?:RA|GR|GS|SN)?\b|\bVCTS\b/.test(text))return 'THUNDERSTORM';
 if(/\b(?:\+|-)?(?:SHRA|RA|DZ)\b/.test(text))return 'RAIN';
 if(/\b(?:\+|-)?(?:SN|SG|PL)\b/.test(text))return 'SNOW';
 if(/\b(?:FG|BR|HZ|FU|DU|SA)\b/.test(text))return text.split(/\s+/)[0];
 if(/\bCAVOK\b/.test(obs))return 'CAVOK';
 return text.replace(/[^A-Z0-9 +/\-]/g,'').slice(0,22)||'NO SIGNIFICANT WX';
}
module.exports = async function handler(req,res){
 res.setHeader('Content-Type','application/json; charset=utf-8');
 if(req.method !== 'GET'){res.setHeader('Allow','GET');return res.status(405).json({ok:false,error:'Method not allowed'});}
 const icao=String(req.query?.icao||'').toUpperCase().trim();
 if(!/^[A-Z0-9]{4}$/.test(icao))return res.status(400).json({ok:false,error:'Valid 4-character ICAO required'});
 const cached=CACHE.get(icao),now=Date.now();
 if(cached&&now-cached.at<TTL){res.setHeader('Cache-Control','public, s-maxage=120, stale-while-revalidate=60');return res.status(200).json(cached.data);}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{
  const url='https://aviationweather.gov/api/data/metar?ids='+encodeURIComponent(icao)+'&format=json';
  const reply=await fetch(url,{signal:controller.signal,headers:{
   'Accept':'application/json','User-Agent':'JetlineCaptainGame/1.0 (aviation weather practice display)'}});
  if(reply.status===204){return res.status(200).json({ok:false,icao,error:'No METAR available'});}
  if(!reply.ok)throw new Error('Aviation weather service HTTP '+reply.status);
  const data=await reply.json();
  const row=Array.isArray(data)?data[0]:data?.data?.[0];
  if(!row) return res.status(200).json({ok:false,icao,error:'No METAR for station'});
  const station=String(row.icaoId||row.stationId||icao).toUpperCase();
  if(station!==icao)throw new Error('Station mismatch');
  let timestamp=Number(row.obsTime)||NaN;
  if(Number.isFinite(timestamp))timestamp*=1000;
  else timestamp=Date.parse(row.reportTime||row.receiptTime||row.obsTime||'');
  if(!Number.isFinite(timestamp))throw new Error('Missing observation time');
  const age=now-timestamp;
  if(age< -900000 || age>REPORT_MAX_AGE) return res.status(200).json({ok:false,icao,error:'METAR observation stale'});
  const windDir=finite(row.wdir),windKt=finite(row.wspd),gustKt=finite(row.wgst);
  const visSm=parseVis(row.visib);
  const flightCategory=String(row.fltCat||'').toUpperCase();
  const result={ok:true,icao,reportedAt:new Date(timestamp).toISOString(),
   receivedAt:new Date(now).toISOString(),flightCategory:['VFR','MVFR','IFR','LIFR'].includes(flightCategory)?flightCategory:'',
   windDir:windDir!=null&&windDir>=0&&windDir<=360?windDir:null,
   windKt:windKt!=null&&windKt>=0?windKt:null,
   gustKt:gustKt!=null&&gustKt>=0?gustKt:null,
   visKm:visSm!=null&&visSm>=0?+(visSm*1.609344).toFixed(1):null,
   condition:statusFromWx(row.wxString,row.rawOb),
   raw:String(row.rawOb||'').slice(0,320),source:'NOAA Aviation Weather Center METAR'};
  CACHE.set(icao,{at:now,data:result});
  if(CACHE.size>120)CACHE.delete(CACHE.keys().next().value);
  res.setHeader('Cache-Control','public, s-maxage=120, stale-while-revalidate=60');
  return res.status(200).json(result);
 }catch(err){
  if(cached&&now-new Date(cached.data.reportedAt).getTime()<REPORT_MAX_AGE)return res.status(200).json(cached.data);
  return res.status(503).json({ok:false,icao,error:'Weather temporarily unavailable'});
 }finally{clearTimeout(timer);}
};
