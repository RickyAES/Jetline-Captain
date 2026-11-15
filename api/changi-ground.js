'use strict';
const {fetchAirport,errorResponse}=require('../lib/adsb');
module.exports=async function handler(req,res){
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'METHOD_NOT_ALLOWED'});}
 try{
  const snapshot=await fetchAirport('WSSS');
  const aircraft=snapshot.aircraft.filter(a=>a.onGround&&a.seenPos<=40&&a.km<=35);
  res.setHeader('Cache-Control','public, s-maxage=35, stale-while-revalidate=15');
  return res.status(200).json({source:snapshot.source,sourceUrl:snapshot.sourceUrl,
   asOf:snapshot.asOf,aircraft,coverage:snapshot.coverage});
 }catch(err){return errorResponse(res,err)}
};
