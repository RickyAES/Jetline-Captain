'use strict';
// Public readiness check for the existing "Jetline Dashboard Live" scheduled monitor.
// Never discloses player history, metrics, secrets or owner account details.
const util=require('../lib/jetline-stats');
module.exports=async function handler(req,res){
 if(req.method!=='GET')return util.send(res,405,{ready:false,error:'Method not allowed'});
 if(util.envMissing().length)return util.send(res,503,{ready:false,reason:'not_configured'});
 try{
  await util.dbFetch('rpc/jetline_stats_summary',{method:'POST',body:{p_days:7}});
  return util.send(res,200,{ready:true,product:'Jetline Captain',dashboard:'/stats.html',database:'connected'});
 }catch(e){console.error('jetline health',e.message);return util.send(res,503,{ready:false,reason:'database_unavailable'})}
};
