// Worldwide runway end coordinates from OurAirports public-domain runways.csv.
// Display only: NOT a current AIP, airport operational status or chart.
'use strict';
const DATA_URL='https://davidmegginson.github.io/ourairports-data/runways.csv';
const {csvFields}=require('./world-airports');
let cachedRunways=null,cacheUntil=0,pending=null;
async function load(){
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),16000);
 try{
  const r=await fetch(DATA_URL,{signal:ctl.signal,headers:{Accept:'text/csv'}});
  if(!r.ok)throw new Error('OurAirports returned '+r.status);
  const lines=(await r.text()).split(/\r?\n/),head=csvFields(lines.shift()||'');
  const columns=['airport_ident','le_ident','he_ident','le_latitude_deg','le_longitude_deg','he_latitude_deg','he_longitude_deg','length_ft','le_heading_degT','he_heading_degT','closed'].map(k=>head.indexOf(k));
  const map=Object.create(null);
  for(const line of lines){
    if(!line)continue;
    const row=csvFields(line),[code,le,he,la,lo,ha,ho,length,heading,reversed,closed]=columns.map(i=>i<0?'':row[i]||'');
    if(closed==='1'||!code||(!le&&!he))continue;
    if(![la,lo,ha,ho].every(value=>value.trim()!==''))continue;
    const lat1=Number(la),lon1=Number(lo),lat2=Number(ha),lon2=Number(ho);
    if(![lat1,lon1,lat2,lon2].every(Number.isFinite))continue;
    if(Math.abs(lat1)>85||Math.abs(lat2)>85||Math.abs(lon1)>180||Math.abs(lon2)>180)continue;
    const item={id:[le,he].filter(Boolean).join('/'),a:[lat1,lon1],b:[lat2,lon2],lengthFt:Number(length)||null,heading:Number(heading)||null,source:'OurAirports'};
    (map[code]||=([])).push(item);
  }
  return map;
 }finally{clearTimeout(timer)}
}
module.exports=async function handler(req,res){
 res.setHeader('Content-Type','application/json; charset=utf-8');
 if(req.method!=='GET')return res.status(405).json({error:'GET only'});
 const code=String(req.query?.airport||'').trim().toUpperCase();
 if(!/^[A-Z0-9]{3,5}$/.test(code))return res.status(400).json({error:'Invalid airport identifier'});
 try{
  if(!cachedRunways||Date.now()>cacheUntil){if(!pending)pending=load().finally(()=>pending=null);cachedRunways=await pending;cacheUntil=Date.now()+12*3600e3;}
  res.setHeader('Cache-Control','public, s-maxage=43200, stale-while-revalidate=86400');
  return res.status(200).json({airport:code,runways:(cachedRunways[code]||[]).slice(0,12),source:'OurAirports public-domain runways.csv'});
 }catch(e){return res.status(503).json({error:'Runway directory temporarily unavailable'});}
};
