'use strict';
const util=require('../lib/jetline-stats');
module.exports=async function handler(req,res){
 util.cors(req,res);
 if(req.method==='OPTIONS')return res.status(204).end();
 if(req.method!=='POST')return util.send(res,405,{error:'Method not allowed'});
 if(!util.originAllowed(req))return util.send(res,403,{error:'Origin not allowed'});
 const missing=util.envMissing();if(missing.length)return util.send(res,503,{error:'Dashboard not configured',missing});
 if(Number(req.headers['content-length']||0)>4096)return util.send(res,413,{error:'Request too large'});
 const body=typeof req.body==='string'?(()=>{try{return JSON.parse(req.body)}catch{return {}}})():req.body||{};
 const ownerEmail=String(process.env.JETLINE_OWNER_EMAIL||'').trim().toLowerCase();
 const email=String(body.email||'').trim().toLowerCase();
 const password=String(body.password||'');
 if(!email||password.length<1||password.length>500||email!==ownerEmail)
   return util.send(res,401,{error:'Invalid owner credentials'});
 try{
  const r=await fetch(util.supabaseBase()+'/auth/v1/token?grant_type=password',{
   method:'POST',headers:{'apikey':util.authKey(),'Content-Type':'application/json'},
   body:JSON.stringify({email,password}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)return util.send(res,401,{error:'Invalid owner credentials or email not confirmed'});
  const result=await r.json();
  if(!result.access_token||String(result.user?.email||'').toLowerCase()!==ownerEmail||!result.user?.email_confirmed_at)
    return util.send(res,401,{error:'Owner account not verified'});
  // Dashboard stores this short-lived access token only for the current browser tab.
  return util.send(res,200,{access_token:result.access_token,expires_in:result.expires_in||3600,owner:ownerEmail});
 }catch(e){console.error('owner auth',e.message);return util.send(res,503,{error:'Owner login service unavailable'})}
};
