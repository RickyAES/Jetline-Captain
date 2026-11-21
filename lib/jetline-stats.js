'use strict';
const ALLOWED_TYPES = new Set(['page_view','flight_start','flight_end','level_change','session_ping']);
const CONFIG_ENV = ['SUPABASE_URL','JETLINE_OWNER_EMAIL'];
function envMissing(){return [...CONFIG_ENV,'SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY','SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY'].filter(k=>{
  if(k.includes(' or '))return !k.split(' or ').some(n=>process.env[n]);
  return !process.env[k];
});}
function supabaseBase(){return String(process.env.SUPABASE_URL||'').replace(/\/+$/,'');}
function dbKey(){return process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'';}
function authKey(){return process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||'';}
function keyHeaders(key){return {'apikey':key, ...(key.split('.').length===3?{'Authorization':'Bearer '+key}:{})};}
function noStore(res){res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('X-Content-Type-Options','nosniff');}
function send(res,status,obj){noStore(res);return res.status(status).json(obj);}
function originAllowed(req){
  const origin=String(req.headers.origin||'');
  if(!origin)return true;
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();
  const valid=new Set(['https://'+host,'http://'+host,'https://jetlinecaptain.vercel.app']);
  for(const entry of String(process.env.JETLINE_ALLOWED_ORIGINS||'').split(',')){
    const clean=entry.trim().replace(/\/+$/,'');if(clean)valid.add(clean);
  }
  return valid.has(origin);
}
function cors(req,res){
  const origin=String(req.headers.origin||'');
  if(origin&&originAllowed(req))res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age','600');
}
function shortString(v,n){return String(v==null?'':v).trim().slice(0,n);}
function cleanId(v){const s=shortString(v,72);return /^[a-zA-Z0-9_-]{12,72}$/.test(s)?s:'';}
function cleanText(v,n){return shortString(v,n).replace(/[<>\r\n]/g,'');}
function countryFromRequest(req){const v=String(req.headers['x-vercel-ip-country']||'').toUpperCase();return /^[A-Z]{2}$/.test(v)?v:null;}
function numeric(v,lo,hi){const n=Number(v);return Number.isFinite(n)?Math.max(lo,Math.min(hi,Math.round(n))):null;}
function sanitizeEvent(v,req){
 if(!v||typeof v!=='object'||!ALLOWED_TYPES.has(v.type))return null;
 const visitor=cleanId(v.visitor_id),session=cleanId(v.session_id),uid=cleanId(v.event_uid);
 if(!visitor||!session||!uid)return null;
 const phase=cleanText(v.phase,20),outcome=cleanText(v.outcome,20).toLowerCase();
 return {event_uid:uid,event_type:v.type,visitor_id:visitor,session_id:session,
  pilot_alias:cleanText(v.pilot_alias,40)||null,
  level:numeric(v.level,1,999),score:numeric(v.score,0,1e9),
  flight_duration_sec:numeric(v.flight_duration_sec,0,86400),
  source:cleanText(v.source,20)||'vercel',country:countryFromRequest(req),
  departure:cleanText(v.departure,8).toUpperCase()||null,
  arrival:cleanText(v.arrival,8).toUpperCase()||null,
  phase:phase||null,
  outcome:['completed','failed','quit','unknown'].includes(outcome)?outcome:null};
}
async function dbFetch(path, options={}){
 const key=dbKey();if(!key||!supabaseBase())throw new Error('Database configuration missing');
 const r=await fetch(supabaseBase()+'/rest/v1/'+path,{
  method:options.method||'GET',headers:{...keyHeaders(key),'Content-Type':'application/json',...options.headers},
  body:options.body?JSON.stringify(options.body):undefined,
  signal:AbortSignal.timeout(10000)});
 const body=await r.text();if(!r.ok)throw new Error('Database HTTP '+r.status+': '+body.slice(0,200));
 if(!body)return null;
 try{return JSON.parse(body)}catch{throw new Error('Invalid database JSON response')}
}
async function ownerFromToken(req){
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
 if(!token||token.length>5000)return null;
 const key=authKey();const email=String(process.env.JETLINE_OWNER_EMAIL||'').toLowerCase().trim();
 if(!key||!email||!supabaseBase())return null;
 try{
  const r=await fetch(supabaseBase()+'/auth/v1/user',{
   headers:{'apikey':key,Authorization:'Bearer '+token},signal:AbortSignal.timeout(9000)});
  if(!r.ok)return null;
  const user=await r.json();
  return String(user.email||'').toLowerCase()===email&&user.email_confirmed_at?user:null;
 }catch{return null}
}
module.exports={envMissing,send,originAllowed,cors,sanitizeEvent,dbFetch,ownerFromToken,authKey,supabaseBase};
