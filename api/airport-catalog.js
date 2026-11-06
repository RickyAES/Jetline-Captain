// Vercel function: retrieves community-maintained OurAirports public-domain data.
// Runway bearings are degrees TRUE, not selected aircraft HDG. Radar is not for navigation.
'use strict';
const BASE=require('../airports.json');
const AIRPORTS_CSV='https://davidmegginson.github.io/ourairports-data/airports.csv';
const RUNWAYS_CSV='https://davidmegginson.github.io/ourairports-data/runways.csv';
let snapshot=null, lastSuccess=0;
const HOUR=3600000;
const TYPES=new Set(['small_airport','medium_airport','large_airport']);
const COUNTRIES=new Set(['SG','ID','TH']);
function parseCsv(s){
  // Stateful RFC-4180 parser; handles quoted commas, escaped double quotes and newlines.
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(c==='"'){
      if(quoted&&s[i+1]==='"'){field+='"';i++;}
      else quoted=!quoted;
    } else if(c===','&&!quoted){row.push(field);field='';}
    else if((c==='\n'||c==='\r')&&!quoted){
      if(c==='\r'&&s[i+1]==='\n')i++;
      row.push(field);if(row.some(x=>x!==''))rows.push(row);
      row=[];field='';
    } else field+=c;
  }
  if(field||row.length){row.push(field);rows.push(row);}
  if(!rows.length)return[];
  const keys=rows.shift();return rows.map(cells=>Object.fromEntries(keys.map((k,i)=>[k,cells[i]??''])));
}
function validCode(s){return /^[A-Z0-9][A-Z0-9-]{1,18}$/.test(s);}
function numberOrNull(x){const n=Number(x);return x!==''&&Number.isFinite(n)?n:null;}
function stripAirportName(s){return String(s||'').replace(/[<>]/g,'').slice(0,110);}
function buildCatalog(airportRows,runwayRows){
  const result={};const byIdent=new Map();
  for(const a of airportRows){
    const ident=String(a.ident||'').toUpperCase();
    const isRegion=COUNTRIES.has(a.iso_country);
    const isKnown=Object.hasOwn(BASE,ident)||Object.hasOwn(BASE,a.icao_code);
    if(!(isRegion||isKnown) || !TYPES.has(a.type))continue;
    const lat=numberOrNull(a.latitude_deg),lon=numberOrNull(a.longitude_deg);
    if(lat==null||lon==null||Math.abs(lat)>90||Math.abs(lon)>180)continue;
    let code=(String(a.icao_code||'').toUpperCase()||ident);
    if(!validCode(code))code=ident;
    if(!validCode(code))continue;
    // Existing base airports retain original identity. ISO country and runway metadata are enriched below.
    result[code]={name:stripAirportName(a.name),lat,lon,country:a.iso_country,type:a.type,
      municipality:stripAirportName(a.municipality),iata:String(a.iata_code||'').toUpperCase().slice(0,4),
      runways:[],remote:!Object.hasOwn(BASE,code)};
    byIdent.set(ident,code);
  }
  for(const r of runwayRows){
    const ident=String(r.airport_ident||'').toUpperCase();const code=byIdent.get(ident);
    if(!code||r.closed==='1')continue;
    const rw=result[code];if(!rw||rw.runways.length>=8)continue;
    const id=[String(r.le_ident||''),String(r.he_ident||'')].filter(Boolean).join('/');
    const le=numberOrNull(r.le_heading_degT),he=numberOrNull(r.he_heading_degT);
    // DegreeT from dataset. If missing, derive it from published runway-end coordinates.
    let heading=le!=null?le:(he!=null?(he+180)%360:null);
    let source='published';
    const leLat=numberOrNull(r.le_latitude_deg),leLon=numberOrNull(r.le_longitude_deg);
    const heLat=numberOrNull(r.he_latitude_deg),heLon=numberOrNull(r.he_longitude_deg);
    if(heading==null&&leLat!=null&&leLon!=null&&heLat!=null&&heLon!=null){
      const x=(heLon-leLon)*Math.cos((leLat+heLat)*Math.PI/360),y=heLat-leLat;
      if(Math.hypot(x,y)>0.00001){heading=(Math.atan2(x,y)*180/Math.PI+360)%360;source='threshold positions';}
    }
    if(heading==null)continue; // Never invent headings from ICAO runway numbers.
    rw.runways.push({id:id||'Unlabelled',heading:Math.round((heading+360)%360*10)/10,bearingSource:source,
      lengthFt:numberOrNull(r.length_ft)||0,
      leLat,leLon,heLat,heLon});
  }
  // Preserve requested Seletar (03/21) with verified published heading even when remote unavailable.
  for(const [code,item] of Object.entries(BASE)){
    if(item.runways?.length){
      if(!result[code])result[code]={...item,remote:false};
      if(!result[code].runways?.length)result[code].runways=item.runways;
    }
  }
  return result;
}
async function fetchCsv(url){
  const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),18000);
  try{
    const r=await fetch(url,{signal:ctl.signal,headers:{Accept:'text/csv,text/plain'}});
    if(!r.ok)throw new Error('Airport data source HTTP '+r.status);
    return parseCsv(await r.text());
  }finally{clearTimeout(timer)}
}
async function getCatalog(){
  if(snapshot && Date.now()-lastSuccess<HOUR*12)return snapshot;
  const [a,r]=await Promise.all([fetchCsv(AIRPORTS_CSV),fetchCsv(RUNWAYS_CSV)]);
  const catalog=buildCatalog(a,r);
  if(Object.keys(catalog).length<150)throw new Error('Airport catalogue unexpectedly small');
  snapshot=catalog;lastSuccess=Date.now();return snapshot;
}
module.exports=async (req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  try{
    const airports=await getCatalog();
    res.setHeader('Cache-Control','public, s-maxage=43200, stale-while-revalidate=86400');
    res.status(200).json({airports,source:'OurAirports public domain',updated:'Daily source, 12-hour response cache',count:Object.keys(airports).length});
  }catch(e){
    if(snapshot){res.setHeader('Cache-Control','public, s-maxage=3600');return res.status(200).json({airports:snapshot,source:'OurAirports cached',count:Object.keys(snapshot).length});}
    res.setHeader('Cache-Control','no-store');
    res.status(503).json({error:'Airport catalogue temporarily unavailable; existing airport list can still be used.'});
  }
};
// Export internals solely for deterministic local unit tests.
module.exports._test={parseCsv,buildCatalog};

// Allow initial regional CSV snapshot parsing on Vercel functions with configurable duration.
module.exports.config={maxDuration:60};
