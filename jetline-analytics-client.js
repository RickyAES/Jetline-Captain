/* Jetline Captain v95 – public gameplay telemetry, owner-only reporting API.
   No emails, IP addresses or precise locations are collected. */
(()=>{
 'use strict';
 if(window.__jetlineStatsTrackerInstalled)return;
 window.__jetlineStatsTrackerInstalled=true;
 const host=location.hostname;
 const base=/\.vercel\.app$|localhost$|127\.0\.0\.1$/.test(host)?'':
   (window.JETLINE_STATS_BASE||'https://jetlinecaptain.vercel.app');
 const endpoint=base+'/api/jetline-stats';
 const STORAGE_VISITOR='jetline.stats.visitor.v1', STORAGE_SESSION='jetline.stats.session.v1';
 function makeId(){
  try{return crypto.randomUUID().replace(/-/g,'')}catch{}
  return String(Date.now())+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
 }
 function stored(area,key){try{let v=area.getItem(key);if(!v){v=makeId();area.setItem(key,v)}return v}catch{return makeId()}}
 const visitorId=stored(localStorage,STORAGE_VISITOR),sessionId=stored(sessionStorage,STORAGE_SESSION);
 const source=/higgsfield/i.test(host)?'higgsfield':/vercel/i.test(host)?'vercel':'web';
 function emit(type,fields={}){
  const event={event_uid:makeId(),type,visitor_id:visitorId,session_id:sessionId,source,...fields};
  const payload=JSON.stringify(event);
  if(document.visibilityState==='hidden'&&navigator.sendBeacon&&(!base||new URL(base).origin===location.origin)){
   try{if(navigator.sendBeacon(endpoint,new Blob([payload],{type:'application/json'})))return}catch{}
  }
  try{fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:payload,mode:'cors',keepalive:true,credentials:'omit'}).catch(()=>{})}catch{}
 }
 function dataFrom(info){
  const routes=info?.route?.plan||info?.route||{};
  return {pilot_alias:String(info?.account?.name||'').slice(0,40),level:info?.level,score:info?.score,
   departure:String(routes.dep||info?.rwys?.dep||'').slice(0,8),
   arrival:String(routes.arr||info?.rwys?.arr||'').slice(0,8),
   phase:String(info?.phase||'').slice(0,20)};
 }
 let prev='boot',prevLevel=null,flightStartTime=null,flightStartT=0,lastInfo=null;
 function heartbeat(){if(document.visibilityState==='visible')emit('session_ping')}
 function tick(){
  let info;try{info=window.__game?.info?.()}catch{return}
  if(!info||typeof info!=='object')return;
  lastInfo=info;
  const state=String(info.st||'');
  if(state==='play'&&prev!=='play'){
   flightStartTime=Date.now();flightStartT=Number(info.t)||0;prevLevel=info.level;
   emit('flight_start',dataFrom(info));
  } else if(state==='play'&&prev==='play'&&info.level!==prevLevel){
    prevLevel=info.level;emit('level_change',dataFrom(info));
  }
  if(prev==='play'&&state!=='play'){
   const played=flightStartTime?Math.max(0,Math.round((Date.now()-flightStartTime)/1000)):0;
   const outcome=state==='end'?(info.won?'completed':info.outcome==='win'?'completed':'failed'):'quit';
   emit('flight_end',{...dataFrom(info),outcome,flight_duration_sec:played});
   flightStartTime=null;
  }
  prev=state;
 }
 emit('page_view');setInterval(tick,2200);setInterval(heartbeat,60000);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')heartbeat()});
 window.addEventListener('pagehide',()=>{
   if(flightStartTime){emit('flight_end',{...dataFrom(lastInfo),outcome:'quit',flight_duration_sec:Math.max(0,Math.round((Date.now()-flightStartTime)/1000))});flightStartTime=null}
 });
})();
