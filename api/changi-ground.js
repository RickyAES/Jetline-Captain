'use strict';
const {fetchWSSSGround,errorResponse}=require('../lib/adsb');
module.exports=async function handler(req,res){
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'METHOD_NOT_ALLOWED'});}
 try{
  const snapshot=await fetchWSSSGround();
  res.setHeader('Cache-Control','public, s-maxage=30, stale-while-revalidate=10');
  return res.status(200).json(snapshot);
 }catch(err){return errorResponse(res,err);}
};
