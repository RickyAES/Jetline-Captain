'use strict';
const util=require('../lib/jetline-stats');
module.exports=async function handler(req,res){
 // Keep owner login, public readiness and private metrics in a SINGLE
 // Vercel function. Vercel rewrites preserve the original public URLs.
 const parsed=new URL(req.url||'/', 'http://localhost');
 const mode=String(req.query?.mode||parsed.searchParams.get('mode')||'').toLowerCase();
 if(mode==='auth')return require('../lib/jetline-stats-auth')(req,res);
 if(mode==='health')return require('../lib/jetline-stats-health')(req,res);
 // v96 compatibility: some deployed rewrite configurations drop ?mode=auth.
 // This allows a cached v96 stats.html to sign in without accepting unrelated POST payloads.
 // Authentication is still performed ONLY by the verified Supabase owner login handler.
 if(req.method==='POST'){
  let credentials=req.body;
  if(typeof credentials==='string'){try{credentials=JSON.parse(credentials)}catch{credentials=null}}
  if(credentials && typeof credentials==='object' && !Array.isArray(credentials) &&
     typeof credentials.email==='string' && typeof credentials.password==='string' &&
     !('type' in credentials) && Object.keys(credentials).every(k=>k==='email'||k==='password')){
    return require('../lib/jetline-stats-auth')(req,res);
  }
 }
 util.cors(req,res);
 if(req.method==='OPTIONS')return res.status(204).end();
 if(!util.originAllowed(req))return util.send(res,403,{error:'Origin not allowed'});
 if(req.method==='POST'){
   if(!process.env.SUPABASE_URL||!(process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY))
     return util.send(res,503,{error:'Statistics database is not configured'});
   if(Number(req.headers['content-length']||0)>4096)return util.send(res,413,{error:'Event too large'});
   let data=req.body;
   if(typeof data==='string'){try{data=JSON.parse(data)}catch{return util.send(res,400,{error:'Invalid JSON'})}}
   const row=util.sanitizeEvent(data,req);
   if(!row)return util.send(res,400,{error:'Invalid statistics event'});
   try{
     await util.dbFetch('jetline_analytics_events?on_conflict=event_uid',{
       method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:row});
     return util.send(res,202,{accepted:true});
   }catch(e){console.error('jetline stats event',e.message);return util.send(res,503,{error:'Analytics write unavailable'})}
 }
 if(req.method==='GET'){
   const missing=util.envMissing();if(missing.length)return util.send(res,503,{error:'Setup required',missing});
   const owner=await util.ownerFromToken(req);
   if(!owner)return util.send(res,401,{error:'Owner login required'});
   const days=[0,7,30,90].includes(Number(req.query?.days))?Number(req.query.days):30;
   try{
     const stats=await util.dbFetch('rpc/jetline_stats_summary',{method:'POST',body:{p_days:days}});
     return util.send(res,200,{owner:true,days,generated_at:new Date().toISOString(),stats});
   }catch(e){console.error('jetline stats read',e.message);return util.send(res,503,{error:'Statistics table or SQL function unavailable. Run sql/jetline-stats.sql in Supabase.'})}
 }
 res.setHeader('Allow','GET,POST,OPTIONS');return util.send(res,405,{error:'Method not allowed'});
};
