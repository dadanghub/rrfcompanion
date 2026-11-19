// Vercel serverless function: reads public Ronin Market data for the Genesis Land collection.
// Needs the environment variable SKYMAVIS_API_KEY (set in the Vercel dashboard, never in code).
const ADDR = "0xa3daa6ccbe9abc148eb503c9c12b1220e1a9ca36";
const ENDPOINT = "https://api-gateway.skymavis.com/graphql/mavis-marketplace";
const PAGE = 50;

async function gql(query) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": process.env.SKYMAVIS_API_KEY },
    body: JSON.stringify({ query }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || "HTTP " + r.status);
  return j.data.erc721Tokens;
}
const tier = (n = "") => (/^(Outpost|Highlands|Skyrealm)/.exec(n) || ["Unrevealed"])[0];
const ron = (wei) => {
  if (wei == null) return null;
  const w = BigInt(wei), u = 10n ** 18n;
  return Number(w / u) + Number((w % u) / 10n ** 16n) / 100;
};
async function pages(build, total) {
  const out = [];
  for (let f = 0; f < total; f += PAGE * 6) {
    const batch = [];
    for (let k = 0; k < 6 && f + k * PAGE < total; k++) batch.push(gql(build(f + k * PAGE)));
    (await Promise.all(batch)).forEach((d) => out.push(...d.results));
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    if (!process.env.SKYMAVIS_API_KEY) throw new Error("SKYMAVIS_API_KEY is not set on the server");
    const lq = (f) => `{erc721Tokens(tokenAddress:"${ADDR}",from:${f},size:${PAGE},auctionType:Sale){total results{tokenId name order{id maker currentPrice startedAt expiredAt}}}}`;
    const tq = (f) => `{erc721Tokens(tokenAddress:"${ADDR}",from:${f},size:${PAGE}){total results{tokenId name transferHistory(from:0,size:10){total results{from to txHash timestamp withPrice}}}}}`;
    const [l0, t0] = await Promise.all([gql(lq(0)), gql(tq(0))]);
    const [lrest, trest] = await Promise.all([
      pages(lq, l0.total).then((r) => r.slice(l0.results.length > 0 ? 0 : 0)),
      pages(tq, t0.total),
    ]);
    const listings = lrest.filter((t) => t.order).map((t) => ({
      tokenId: t.tokenId, name: t.name, tier: tier(t.name), seller: t.order.maker,
      price: ron(t.order.currentPrice), startedAt: t.order.startedAt, expiredAt: t.order.expiredAt,
    }));
    const transfers = [];
    trest.forEach((t) => (t.transferHistory.results || []).forEach((h) => transfers.push({
      tokenId: t.tokenId, name: t.name, tier: tier(t.name), from: h.from, to: h.to,
      tx: h.txHash, timestamp: h.timestamp, price: h.withPrice && h.withPrice !== "0" ? ron(h.withPrice) : null,
    })));
    transfers.sort((a, b) => b.timestamp - a.timestamp);
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({ updated: Math.floor(Date.now() / 1000), totalLands: t0.total, listings, transfers });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
