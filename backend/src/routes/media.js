const express = require('express');
const cache = require('../lib/cache');

const router = express.Router();

// GET /api/media?u=<url> — repassa imagens dos CDNs da Meta (criativos,
// posts e foto do Instagram) com CORS liberado, pra elas poderem entrar no
// PDF gerado no navegador. Só aceita domínios da Meta (não é um proxy aberto).
const ALLOWED = [/\.fbcdn\.net$/i, /\.cdninstagram\.com$/i, /^scontent[\w.-]*\.(fbcdn\.net|cdninstagram\.com)$/i];
const MAX_BYTES = 6 * 1024 * 1024;

router.get('/', async (req, res) => {
  let url;
  try { url = new URL(String(req.query.u || '')); } catch (e) { return res.status(400).end(); }
  if (url.protocol !== 'https:' || !ALLOWED.some((re) => re.test(url.hostname))) return res.status(400).end();

  const key = `media:${url.toString()}`;
  const hit = cache.get(key);
  const send = (img) => {
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(img.body);
  };
  if (hit) return send(hit);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) return res.status(502).end();
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_BYTES) return res.status(413).end();
    const img = { type, body };
    cache.set(key, img, 60 * 60 * 6);
    send(img);
  } catch (e) {
    res.status(502).end();
  }
});

module.exports = router;
