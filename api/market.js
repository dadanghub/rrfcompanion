// Vercel serverless function: public Ronin Market data for the Genesis Land collection.
// Needs the environment variable SKYMAVIS_API_KEY (set in the Vercel dashboard, never in code).
// Sky Mavis limits for /graphql/mavis-marketplace (Basic): 50/sec, 300/min, 5,000/hour, 20,000/day.
const ADDR = "0xa3daa6ccbe9abc148eb503c9c12b1220e1a9ca36";
const ENDPOINT = "https://api-gateway.skymavis.com/graphql/mavis-marketplace";
let PAGE = 100;               // falls back to 50 automatically if the API rejects 100
const TTL = 10 * 60 * 1000;   // in-memory freshness per warm server instance
const CONCURRENCY = 8;        // per data stream; 2 streams = 16 at once, far below 50/sec
let mem = null, inflight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(query, n = 0) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": process.env.SKYMAVIS_API_KEY },
    body: JSON.stringify({ query }),
  });
  if (r.status === 429 && n < 3) { await sleep(1500 * (n + 1)); return gql(query, n + 1); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || "HTTP " + r.status);
  return j.data.erc721Tokens;
}
const lq = (f) => `{erc721Tokens(tokenAddress:"${ADDR}",from:${f},size:${PAGE},auctionType:Sale){total results{tokenId name order{id maker currentPrice startedAt expiredAt}}}}`;
const tq = (f) => `{erc721Tokens(tokenAddress:"${ADDR}",from:${f},size:${PAGE}){total results{tokenId name transferHistory(from:0,size:10){total results{from to txHash timestamp withPrice}}}}}`;
const tier = (n = "") => (/^(Outpost|Highlands|Skyrealm)/.exec(n) || ["Unrevealed"])[0];
const ron = (wei) => {
  if (wei == null) return null;
  const w = BigInt(wei), u = 10n ** 18n;
  return Number(w / u) + Number((w % u) / 10n ** 16n) / 100;
};
async function pages(build, first) {
  const out = [...first.results], starts = [];
  for (let f = PAGE; f < first.total; f += PAGE) starts.push(f);
  for (let i = 0; i < starts.length; i += CONCURRENCY) {
    const batch = await Promise.all(starts.slice(i, i + CONCURRENCY).map((f) => gql(build(f))));
    batch.forEach((d) => out.push(...d.results));
  }
  return out;
}
async function head() {
  try { return await Promise.all([gql(lq(0)), gql(tq(0))]); }
  catch (e) { if (PAGE === 100) { PAGE = 50; return Promise.all([gql(lq(0)), gql(tq(0))]); } throw e; }
}
async function build() {
  if (!process.env.SKYMAVIS_API_KEY) throw new Error("SKYMAVIS_API_KEY is not set on the server");
  const [l0, t0] = await head();
  const [lrows, trows] = await Promise.all([pages(lq, l0), pages(tq, t0)]);
  const listings = lrows.filter((t) => t.order).map((t) => ({
    tokenId: t.tokenId, name: t.name, tier: tier(t.name), seller: t.order.maker,
    price: ron(t.order.currentPrice), startedAt: t.order.startedAt, expiredAt: t.order.expiredAt,
  }));
  const transfers = [];
  trows.forEach((t) => (t.transferHistory.results || []).forEach((h) => transfers.push({
    tokenId: t.tokenId, name: t.name, tier: tier(t.name), from: h.from, to: h.to,
    tx: h.txHash, timestamp: h.timestamp, price: h.withPrice && h.withPrice !== "0" ? ron(h.withPrice) : null,
  })));
  transfers.sort((a, b) => b.timestamp - a.timestamp);
  const names = {};
  trows.forEach((t) => { names[t.tokenId] = t.name; });
  return { updated: Math.floor(Date.now() / 1000), totalLands: t0.total, listings, transfers, names };
}
// One refresh at a time per instance; everyone else waits for it. On failure, serve the last good copy.
async function get() {
  if (mem && Date.now() - mem.t < TTL) return mem.d;
  if (!inflight) inflight = build().then((d) => { mem = { t: Date.now(), d }; return d; }).finally(() => { inflight = null; });
  try { return await inflight; }
  catch (e) { if (mem) return { ...mem.d, stale: true }; throw e; }
}

module.exports = async (req, res) => {
  try {
    const d = await get();
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=86400");
    res.status(200).json(d);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
