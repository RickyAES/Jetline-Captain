'use strict';
const {AIRPORTS,fetchAirport,errorResponse}=require('../lib/adsb');
module.exports=async function handler(req,res){
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'METHOD_NOT_ALLOWED'});}
 const airport=String(req.query?.airport||'WSSS').toUpperCase().trim();
 if(!Object.prototype.hasOwnProperty.call(AIRPORTS,airport))return res.status(400).json({error:'UNSUPPORTED_AIRPORT',supported:Object.keys(AIRPORTS)});
 try{
  const snapshot=await fetchAirport(airport);
  res.setHeader('Cache-Control','public, s-maxage=35, stale-while-revalidate=15');
  return res.status(200).json(snapshot);
 }catch(err){return errorResponse(res,err)}
};
