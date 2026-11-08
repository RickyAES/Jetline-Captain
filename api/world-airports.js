// Worldwide airport directory for Jetline Captain radar. Based on OurAirports
// public-domain data, refreshed nightly: https://ourairports.com/data/
// Geographic names and positions are informational, not for flight navigation.
'use strict';
const DATA_URL='https://davidmegginson.github.io/ourairports-data/airports.csv';
let cache=null, cacheUntil=0, pending=null;
function csvFields(line){
  const a=[];let field='',quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){if(quoted&&line[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){a.push(field);field='';}
    else field+=c;
  }
  a.push(field);return a;
}
async function loadWorld(){
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),16000);
 try{
  const response=await fetch(DATA_URL,{signal:ctl.signal,headers:{Accept:'text/csv'}});
  if(!response.ok)throw new Error('OurAirports returned '+response.status);
  const csv=await response.text();
  const lines=csv.split(/\r?\n/),keys=csvFields(lines.shift()||'');
  const col=k=>keys.indexOf(k);
  const cols=['type','name','latitude_deg','longitude_deg','iso_country','municipality','iata_code','icao_code','gps_code','ident','scheduled_service'].map(col);
  const airports={};
  for(const line of lines){
   if(!line)continue;
   const row=csvFields(line),[type,name,latS,lonS,country,city,iata,icao,gps,ident,scheduled]=cols.map(i=>i<0?'':row[i]||'');
   if(type!=='large_airport'&&type!=='medium_airport'&&!(type==='small_airport'&&scheduled==='yes'))continue;
   const code=(icao||gps||ident).trim().toUpperCase();
   if(!/^[A-Z]{4}$/.test(code))continue;
   if(!latS.trim()||!lonS.trim())continue;
   const lat=Number(latS),lon=Number(lonS);
   if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>85||Math.abs(lon)>180)continue;
   airports[code]={name:name.slice(0,110),lat,lon,country,municipality:city.slice(0,85),iata:iata.slice(0,4),type,remote:true};
  }
  return {airports,count:Object.keys(airports).length,source:'OurAirports public-domain airports.csv'};
 }finally{clearTimeout(timer)}
}
module.exports=async function handler(req,res){
 res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET')return res.status(405).json({error:'GET only'});
 try{
  if(!cache||Date.now()>cacheUntil){
    if(!pending)pending=loadWorld().finally(()=>{pending=null});
    cache=await pending;cacheUntil=Date.now()+12*3600e3;
  }
  res.setHeader('Cache-Control','public, s-maxage=43200, stale-while-revalidate=86400');
  return res.status(200).json(cache);
 }catch(e){return res.status(503).json({error:'Worldwide airport directory temporarily unavailable',detail:String(e.message||e).slice(0,90)});}
};
module.exports.csvFields=csvFields;
