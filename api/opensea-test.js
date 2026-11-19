// TEMPORARY test endpoint. Open /api/opensea-test in a browser and send the result to Claude (it never shows your key).
// Delete this file after the OpenSea feature is built.
const ADDR = "0xa3daa6ccbe9abc148eb503c9c12b1220e1a9ca36";
const BASE = "https://api.opensea.io/api/v2";

async function call(path) {
  try {
    const r = await fetch(BASE + path, { headers: { "x-api-key": process.env.OPENSEA_API_KEY, accept: "application/json" } });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 400); }
    return { path, status: r.status, body };
  } catch (e) { return { path, error: e.message }; }
}
const trim = (o) => JSON.parse(JSON.stringify(o, (k, v) => (Array.isArray(v) ? v.slice(0, 1) : v)));

module.exports = async (req, res) => {
  if (!process.env.OPENSEA_API_KEY) return res.status(500).json({ error: "OPENSEA_API_KEY is not set in Vercel" });
  const out = {};
  out.nft = await call(`/chain/ronin/contract/${ADDR}/nfts/1`);
  const slug = (req.query && req.query.slug) || (out.nft.body && out.nft.body.nft && out.nft.body.nft.collection);
  out.slug = slug || null;
  if (slug) {
    out.listings = await call(`/listings/collection/${slug}/all?limit=2`);
    out.sales = await call(`/events/collection/${slug}?event_type=sale&limit=2`);
  }
  res.status(200).json(trim(out));
};
