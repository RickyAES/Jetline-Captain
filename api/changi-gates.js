/**
 * Jetline Captain: Aviationstack → Changi gate-assignment bridge.
 * Vercel Node Serverless Function: api/changi-gates.js
 *
 * Required Vercel environment variable: AVIATIONSTACK_API_KEY
 * Optional: AVIATIONSTACK_PAGES=1 (default; 1 request per refresh)
 * Optional: AVIATIONSTACK_INCLUDE_ARRIVALS=false (default)
 *
 * All provider requests happen on the server. Gate assignments do NOT verify
 * physical occupancy, aircraft stand, or current airport movement positions.
 * Do not substitute an API key in the browser or in a public source URL.
 */
const GATES = new Set([
 ...Array.from({length:21},(_,i)=>'A'+(i+1)),
 ...Array.from({length:10},(_,i)=>'B'+(i+1)),
 ...Array.from({length:26},(_,i)=>'C'+(i+1)),
 ...Array.from({length:20},(_,i)=>'D'+(i+30)),
 ...Array.from({length:28},(_,i)=>'E'+(i+1)),
 ...Array.from({length:31},(_,i)=>'F'+(i+30)),
 ...Array.from({length:21},(_,i)=>'G'+(i+1))
]);
const GATE_TERM = Object.fromEntries([...GATES].map(g=>[g, /^A|^B/.test(g)?'T3':/^C|^D/.test(g)?'T1':/^E|^F/.test(g)?'T2':'T4']));
const safeText = (x,n=60)=>String(x==null?'':x).trim().slice(0,n);
const cleanGate = x=>safeText(x,30).toUpperCase().replace(/^GATE\s*/, '').replace(/[^A-Z0-9]/g,'');
const normTerminal = x=>{const num=safeText(x,8).replace(/[^0-9]/g,'');return num?'T'+num:'';};
const isFlightInRange = (date, status) => {
  if (/^(active|landed|cancelled|canceled|diverted|incident)$/i.test(status)) return false;
  if (!date) return true;
  const t=Date.parse(date);
  if (!Number.isFinite(t))return true; // keep provider record, but don't imply physically parked
  const delta=(t-Date.now())/3600000;
  return delta>=-2 && delta<=12;
};
const gateRows = (records, direction='departure') => {
 const valid=[];
 for (const f of records) {
  if (!f || typeof f!=='object')continue;
  const entry=f[direction]||{};
  const gate=cleanGate(entry.gate);
  if (!GATES.has(gate))continue;
  const assignedTerminal=normTerminal(entry.terminal);
  if (assignedTerminal && assignedTerminal!==GATE_TERM[gate]) continue;
  const flight=safeText(f.flight?.iata || f.flight?.icao || ((f.airline?.iata||'')+(f.flight?.number||'')),20).toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (!flight)continue;
  const scheduled=entry.scheduled || entry.estimated || null;
  const status=safeText(f.flight_status||'scheduled',30).toUpperCase();
  if (!isFlightInRange(scheduled,status))continue;
  // Codeshare rows typically duplicate an operating flight at the same gate.
  // Skip duplicates when an operating flight entry is present on the provider page.
  valid.push({gate,terminal:GATE_TERM[gate],flight,status,
   scheduled:scheduled?String(scheduled).slice(0,40):'',
   destination:safeText(direction==='departure'?(f.arrival?.airport||f.arrival?.iata):(f.departure?.airport||f.departure?.iata),80),
   destinationIata:safeText(direction==='departure'?f.arrival?.iata:f.departure?.iata,6),
   airline:safeText(f.airline?.name,80),registration:safeText(f.aircraft?.registration,24),
   aircraft:safeText(f.aircraft?.iata||f.aircraft?.icao,16),direction,
   confirmedParked:false, // Gate assignment cannot prove parking.
   codeshare:!!f.flight?.codeshared,
   sortTime:scheduled && Number.isFinite(Date.parse(scheduled))?Date.parse(scheduled):Infinity});
 }
 // Each gate card can display one flight. Prefer earliest upcoming assigned
 // departure instead of an old event or a duplicate codeshare row.
 valid.sort((a,b)=>(a.codeshare?1:0)-(b.codeshare?1:0) || a.sortTime-b.sortTime);
 const seen = new Set();
 return valid.filter(x=>{if(seen.has(x.gate))return false;seen.add(x.gate);return true})
  .map(({codeshare,sortTime,...row})=>row);
};
const cors = res => {
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Cache-Control','public, s-maxage=900, stale-while-revalidate=300');
};
export default async function handler(req,res){
 cors(res);
 if (req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
 const apiKey=process.env.AVIATIONSTACK_API_KEY;
 if (!apiKey)return res.status(503).json({error:'AVIATIONSTACK_API_KEY_MISSING',message:'Set AVIATIONSTACK_API_KEY in Vercel Environment Variables and redeploy.'});
 // WARNING: the free plan allows 100 upstream requests / month. Even 15-minute
 // caching is not sufficient for a 24/7 public game at this quota. v9's game
 // disables automatic 90-second polling. Use manual refresh for initial testing.
 const pages=Math.max(1,Math.min(5,parseInt(process.env.AVIATIONSTACK_PAGES||'1',10)||1));
 const directions=process.env.AVIATIONSTACK_INCLUDE_ARRIVALS==='true'?['departure','arrival']:['departure'];
 const entries=[];let total=0;
 try{
  for (const direction of directions){
   for (let i=0;i<pages;i++){
    const url=new URL('https://api.aviationstack.com/v1/flights');
    url.searchParams.set('access_key',apiKey);
    url.searchParams.set(direction==='departure'?'dep_iata':'arr_iata','SIN');
    url.searchParams.set('limit','100');
    url.searchParams.set('offset',String(i*100));
    const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(11000),redirect:'error'});
    if (!response.ok)return res.status(response.status===429?429:502).json({error:response.status===429?'AVIATIONSTACK_QUOTA_EXCEEDED':'AVIATIONSTACK_HTTP_ERROR',message:'Aviationstack returned HTTP '+response.status});
    const body=await response.json();
    if(body?.error)return res.status(502).json({error:'AVIATIONSTACK_ERROR',message:safeText(body.error.message||body.error.code||'Provider rejected the request',150)});
    if(!Array.isArray(body?.data))return res.status(502).json({error:'AVIATIONSTACK_FORMAT_ERROR',message:'Provider response did not contain data[].'});
    total+=body.data.length;
    entries.push(...gateRows(body.data,direction));
    if(body.data.length<100)break;
   }
  }
  // Every flight-to-gate assignment is informational and NOT a statement that
  // an aircraft is currently parked at that gate.
  const seen=new Set();const flights=entries.filter(f=>{if(seen.has(f.gate))return false;seen.add(f.gate);return true;});
  return res.status(200).json({source:'Aviationstack (SIN flight-to-gate assignments)',updatedAt:new Date().toISOString(),
   flights,rawCount:total,matchedGates:flights.length,gateOccupancyVerified:false,
   note:'Flight data is provider-reported. Gate assignments do not confirm parking; terminals and 3D stands are schematic.'});
 }catch(e){
  return res.status(502).json({error:'AVIATIONSTACK_REQUEST_FAILED',message:e?.name==='TimeoutError'?'Aviationstack request timed out.':'Could not retrieve provider data.'});
 }
}
