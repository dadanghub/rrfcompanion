// Vercel serverless function: public OpenSea listings and sales for the Genesis Land collection.
// Needs the environment variable OPENSEA_API_KEY (set in the Vercel dashboard, never in code).
const SLUG = "rrf-village-genesis-land-81074852";
const BASE = "https://api.opensea.io/api/v2";
const KEY = (process.env.OPENSEA_API_KEY || "").replace(/[\s"']/g, "");
const TTL = 15 * 60 * 1000;
const OK_TOKENS = ["RON", "WRON"];
let mem = null, inflight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, n = 0) {
  const r = await fetch(BASE + path, { headers: { "x-api-key": KEY, accept: "application/json" } });
  if (r.status === 429 && n < 3) { await sleep(2000 * (n + 1)); return get(path, n + 1); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.errors && j.errors[0]) || "HTTP " + r.status);
  return j;
}
async function all(path, key, maxPages) {
  const out = []; let next = null;
  for (let i = 0; i < maxPages; i++) {
    const j = await get(path + (next ? "&next=" + encodeURIComponent(next) : ""));
    out.push(...(j[key] || []));
    next = j.next;
    if (!next) break;
    await sleep(500);   // stay gentle with OpenSea's rate limit
  }
  return out;
}
const amt = (q, d = 18) => { const w = BigInt(q), u = 10n ** BigInt(d); return Number(w / u) + Number(((w % u) * 100n) / u) / 100; };

async function build() {
  if (!KEY) throw new Error("OPENSEA_API_KEY is not set on the server");
  const [L, S] = await Promise.all([
    all(`/listings/collection/${SLUG}/all?limit=50`, "listings", 10),
    all(`/events/collection/${SLUG}?event_type=sale&limit=50`, "asset_events", 40),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const listings = [];
  L.forEach((o) => {
    const cur = o.price && o.price.current, p = o.protocol_data && o.protocol_data.parameters;
    if (o.asset?.identifier == null || !cur || !OK_TOKENS.includes(cur.currency) || o.status !== "ACTIVE") return;
    const end = p ? Number(p.endTime) : 0;
    if (end && end < now) return;
    listings.push({ tokenId: o.asset.identifier, seller: p ? p.offerer : "", price: amt(cur.value, cur.decimals),
      startedAt: o.order_created_at, expiredAt: end });
  });
  const sales = [];
  S.forEach((e) => {
    const pay = e.payment;
    if (!pay || !OK_TOKENS.includes(pay.symbol) || !e.nft) return;
    sales.push({ tokenId: e.nft.identifier, name: e.nft.name, from: e.seller, to: e.buyer,
      tx: e.transaction, timestamp: e.event_timestamp, price: amt(pay.quantity, pay.decimals) });
  });
  return { updated: now, listings, sales };
}
async function getData() {
  if (mem && Date.now() - mem.t < TTL) return mem.d;
  if (!inflight) inflight = build().then((d) => { mem = { t: Date.now(), d }; return d; }).finally(() => { inflight = null; });
  try { return await inflight; } catch (e) { if (mem) return { ...mem.d, stale: true }; throw e; }
}
module.exports = async (req, res) => {
  try {
    const d = await getData();
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=86400");
    res.status(200).json(d);
  } catch (e) { res.status(502).json({ error: e.message }); }
};
