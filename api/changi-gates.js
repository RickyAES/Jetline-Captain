// Vercel Node Serverless Function — optional gate-data bridge for Jetline Captain.
// This does NOT read or reverse-engineer the Changi App. Configure a flight data
// provider whose license permits your intended use and whose JSON is shaped as
// {source:string,updatedAt:ISO8601,flights:[{gate,terminal,flight,status,...}]}.
// Set CHANGI_GATES_SOURCE_URL and optionally CHANGI_GATES_SOURCE_TOKEN in Vercel.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  const endpoint = process.env.CHANGI_GATES_SOURCE_URL;
  if (!endpoint) return res.status(503).json({error:'NO_AUTHORIZED_GATE_FEED', message:'Connect a licensed airport flight/gate data source to enable live updates.'});
  let address;
  try {
    address = new URL(endpoint);
    if (address.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
  } catch {
    return res.status(500).json({error:'GATE_SOURCE_URL_INVALID'});
  }
  try {
    const headers = {'Accept':'application/json'};
    if (process.env.CHANGI_GATES_SOURCE_TOKEN)
      headers.Authorization = `Bearer ${process.env.CHANGI_GATES_SOURCE_TOKEN}`;
    const upstream = await fetch(address.toString(), {
      headers, redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) throw new Error('provider HTTP '+upstream.status);
    const obj = await upstream.json();
    const list = Array.isArray(obj) ? obj : Array.isArray(obj.flights) ? obj.flights : null;
    if (!list) throw new Error('Provider response must contain flights[]');
    // Do not replace a missing provider timestamp with server time: that would
    // claim data is current when its actual acquisition time is unknown.
    const updatedAt = obj.updatedAt || obj.timestamp || null;
    const raw = list.slice(0,500).map(f => ({
      gate: f.gate || f.gateNumber || '',
      terminal: f.terminal || f.terminalNumber || '',
      flight: f.flight || f.flightNumber || f.callsign || '',
      status: f.status || f.flightStatus || '',
      scheduled: f.scheduled || '',
      confirmedParked: f.confirmedParked === true || f.actualStandOccupied === true
    }));
    res.setHeader('Cache-Control','public, s-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({
      source: String(obj.source || 'Authorized flight data feed').slice(0,90),
      updatedAt, flights: raw
    });
  } catch (e) {
    return res.status(502).json({error:'UPSTREAM_GATE_FEED_ERROR', message:String(e.message).slice(0,180)});
  }
}
