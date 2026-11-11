/**
 * Jetline Captain v10 — Aviationstack SIN flight → gate board.
 * Vercel Node serverless API, no browser key; no HTML scraping.
 *
 * Set AVIATIONSTACK_API_KEY in Vercel Production, then redeploy.
 * Optional: AVIATIONSTACK_INCLUDE_ARRIVALS=true (default),
 * AVIATIONSTACK_MAX_PAGES=1 (default; 1 provider request per page and direction),
 * AVIATIONSTACK_LOOKAHEAD_HOURS=24 (default).
 *
 * Provider quota: FREE 100 requests per month as of November 2026.
 * 1 page per direction uses up to 2 provider calls on each cache MISS.
 * For wider coverage use a suitable plan and increase MAX_PAGES (max 12).
 * CDN caching helps but is not a reliable quota limiter; do not turn on
 * automatic frequent polling on a public game without shared persistent cache.
 *
 * This endpoint exposes ASSIGNMENTS, NOT proof of parking or occupancy.
 */
const TERMINALS = Object.freeze({A:'T3',B:'T3',C:'T1',D:'T1',E:'T2',F:'T2',G:'T4'});
const str=(value,max=80)=>String(value==null?'':value).trim().slice(0,max);
const upper=(value,max=60)=>str(value,max).toUpperCase();
const gateId=value=>upper(value,36).replace(/^GATE\s*/,'').replace(/[^A-Z0-9]/g,'');
const sgtClock = value => new Date(value).toISOString();
const statusSafe = x => upper(x||'UNKNOWN',36);
const flightId = (f) => upper(f?.flight?.iata || f?.flight?.icao || (
 (f?.airline?.iata || f?.airline?.icao || '') + (f?.flight?.number || '')
),20).replace(/[^A-Z0-9]/g,'');
const isValidGate = gate => /^[A-G][0-9]{1,3}[A-Z]?$/.test(gate);
const normTerminal=x=>{const d=str(x,10).replace(/\D/g,'');return /^[1-4]$/.test(d)?'T'+d:'';};
const safeDate = value => {
 if(!value) return '';
 const ms=Date.parse(value);
 return Number.isFinite(ms)?new Date(ms).toISOString():'';
};
function flightRows(data,direction,now,lookaheadHours){
 const rows=[];
 for (const f of data){
  if(!f||typeof f!=='object')continue;
  const at=f[direction]||{};
  const gate=gateId(at.gate);
  if(!isValidGate(gate))continue;
  const flight=flightId(f);
  if(!flight)continue;
  const status=statusSafe(f.flight_status);
  const scheduled=safeDate(at.scheduled);
  const estimated=safeDate(at.estimated);
  const actual=safeDate(at.actual);
  const timeRef=estimated||scheduled||actual;
  // Keep nearby flight operations only. Old and future records must not be
  // mistaken for current activity at a gate.
  if(!timeRef)continue;
  const hours=(Date.parse(timeRef)-now)/3600000;
  if(hours < -6 || hours > lookaheadHours)continue;
  const mapped=TERMINALS[gate[0]];
  const terminal=normTerminal(at.terminal)||mapped||'';
  const dest=direction==='departure'?(f.arrival||{}):(f.departure||{});
  const codeShare=f.flight?.codeshared;
  const delay=Number(at.delay);
  rows.push({
   gate,terminal,flight,direction,status,
   scheduled,estimated,actual,
   destination:str(dest.airport||dest.iata||dest.icao,85),
   destinationIata:upper(dest.iata,5),
   airline:str(f.airline?.name,75),
   airlineIata:upper(f.airline?.iata,5),
   aircraft:upper(f.aircraft?.iata||f.aircraft?.icao||f.aircraft?.model,32),
   registration:upper(f.aircraft?.registration,32),
   delayMinutes:Number.isFinite(delay)?delay:null,
   codeshare:!!codeShare,
   operatingFlight:upper(codeShare?.flight?.iata||codeShare?.flight?.icao,20),
   confirmedParked:false,
  });
 }
 return rows;
}
const headers = res => {
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Access-Control-Allow-Origin','*');
 // 1h CDN cache; browser may still reload for manual freshness checks.
 res.setHeader('Cache-Control','public, s-maxage=3600, stale-while-revalidate=300');
};
export default async function handler(req,res){
 headers(res);
 if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
 const key=process.env.AVIATIONSTACK_API_KEY;
 if(!key)return res.status(503).json({error:'AVIATIONSTACK_API_KEY_MISSING',message:'Set AVIATIONSTACK_API_KEY in Vercel and redeploy.'});
 const maxPages=Math.min(12,Math.max(1,parseInt(process.env.AVIATIONSTACK_MAX_PAGES||'1',10)||1));
 const lookaheadHours=Math.min(48,Math.max(6,parseInt(process.env.AVIATIONSTACK_LOOKAHEAD_HOURS||'24',10)||24));
 const directions=process.env.AVIATIONSTACK_INCLUDE_ARRIVALS==='false'?['departure']:['departure','arrival'];
 const now=Date.now();
 const entries=[], warnings=[];
 const coverage={directions,limitPerPage:100,maxPages,scannedPages:{},providerTotals:{},incomplete:false,requests:0};
 try{
  for (const direction of directions){
   coverage.scannedPages[direction]=0;
   let finished=false, lastTotal=null;
   for(let page=0;page<maxPages;page++){
    const url=new URL('https://api.aviationstack.com/v1/flights');
    url.searchParams.set('access_key',key);
    url.searchParams.set(direction==='departure'?'dep_iata':'arr_iata','SIN');
    url.searchParams.set('limit','100');
    url.searchParams.set('offset',String(page*100));
    const reply=await fetch(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(14000)});
    coverage.requests++;
    let body;
    try {body=await reply.json();}catch {body=null;}
    if(!reply.ok||body?.error){
     const err=body?.error||{};
     const rawMsg=str(err.message||err.info||err.code||('Upstream HTTP '+reply.status),140).replaceAll(key,'[REDACTED]');
     const quota=/limit|quota|usage|request/i.test(rawMsg)||reply.status===429;
     const msg=(quota?'Aviationstack monthly/request quota reached. ':'Aviationstack request failed. ')+rawMsg;
     if(!entries.length)return res.status(quota?429:502).json({error:quota?'AVIATIONSTACK_QUOTA':'AVIATIONSTACK_UPSTREAM_ERROR',message:msg});
     coverage.incomplete=true;warnings.push(direction+' page '+(page+1)+': '+msg);finished=true;break;
    }
    if(!Array.isArray(body?.data)){
     if(!entries.length)return res.status(502).json({error:'AVIATIONSTACK_BAD_RESPONSE',message:'Provider did not return data[].'});
     coverage.incomplete=true;warnings.push('Provider returned invalid data for '+direction);finished=true;break;
    }
    coverage.scannedPages[direction]++;
    const meta=body.pagination||{};
    if(Number.isFinite(+meta.total))lastTotal=+meta.total;
    entries.push(...flightRows(body.data,direction,now,lookaheadHours));
    const count=body.data.length;
    const offset=page*100;
    if(count<100||(lastTotal!=null&&offset+count>=lastTotal)) {finished=true;break;}
   }
   coverage.providerTotals[direction]=lastTotal;
   if(!finished){coverage.incomplete=true;warnings.push('Only the first '+(coverage.scannedPages[direction]*100)+' '+direction+' records were scanned; increase AVIATIONSTACK_MAX_PAGES on a suitable plan for wider coverage.');}
  }
  const seen=new Set();
  // Preserve multiple sequential flights at the same gate; only remove exact
  // duplicate provider rows. Codeshares may appear as different flight numbers.
  const flights=entries.filter(r=>{
   const k=[r.gate,r.direction,r.flight,r.scheduled,r.estimated,r.actual].join('|');
   if(seen.has(k))return false;seen.add(k);return true;
  }).sort((a,b)=>a.gate.localeCompare(b.gate,undefined,{numeric:true})||
    Date.parse(a.estimated||a.scheduled||a.actual)-Date.parse(b.estimated||b.scheduled||b.actual));
  return res.status(200).json({source:'Aviationstack · SIN gate assignments',updatedAt:new Date().toISOString(),
   airport:'WSSS',flights,flightCount:flights.length,
   assignedGateCount:new Set(flights.map(f=>f.gate)).size,
   coverage:{...coverage,complete:!coverage.incomplete},warnings,
   gateOccupancyVerified:false,
   note:'Provider-reported flight-to-gate assignments only, not verified aircraft parking. All available matching records from scanned pages; blank gate/time fields cannot be filled.'});
 }catch(error){
  return res.status(502).json({error:'AVIATIONSTACK_REQUEST_FAILED',message:'Flight-data request failed or timed out. Check provider status and Vercel logs.'});
 }
}
