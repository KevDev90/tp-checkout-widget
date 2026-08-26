const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TRUSTPILOT_API_KEY;

/** In-memory cache: BUID → aggregated Trustpilot payload (30–60 min TTL). */
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 45 * 60 * 1000);
const cache = new Map();

/** Short TTL cache for proxied PNGs (reduces Cloudinary hits). */
const IMAGE_CACHE_TTL_MS = Number(process.env.IMAGE_CACHE_TTL_MS || 60 * 60 * 1000);
const imageBytesCache = new Map();

const TRUSTPILOT_LOGO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="Trustpilot">
  <path fill="#00B67A" d="M12 1.5l3.1 9.4h9.9l-8 5.8 3.1 9.3L12 18.2 3.9 26l3.1-9.3-8-5.8h9.9z"/>
</svg>`;

const TP_BRANDMARK_PNG =
  'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777760452/Trustpilot_brandmark_gr-blk_RGB-288x72-L_rfgzgx.png';

/** String keys only — Express query/path params are always strings. */
const TP_STRIP_URL_BY_SEGMENT = {
  '1': 'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782805/Trustpilot_ratings_1star-RGB-512x96_nsi2tm.png',
  '1half':
    'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782805/Trustpilot_ratings_1halfstar-RGB-512x96_jpcws6.png',
  '2': 'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782805/Trustpilot_ratings_2star-RGB-512x96_gdhrcj.png',
  '2half':
    'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782805/Trustpilot_ratings_2halfstar-RGB-512x96_vjubzo.png',
  '3': 'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782806/Trustpilot_ratings_3star-RGB-512x96_fy4h5d.png',
  '3half':
    'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782806/Trustpilot_ratings_3halfstar-RGB-512x96_mz2gxl.png',
  '4': 'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782806/Trustpilot_ratings_4star-RGB-512x96_kcdfre.png',
  '4half':
    'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782806/Trustpilot_ratings_4halfstar-RGB-512x96_ysrzgj.png',
  '5': 'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777782807/Trustpilot_ratings_5star-RGB-512x96_ct5e1r.png',
};

const REVIEW_FILTERS = new Set(['five_only', 'four_and_five', 'latest']);

function proxyCacheKey(buid, skipReviews, filter, limit) {
  return `${buid}|${skipReviews ? 1 : 0}|${filter}|${limit}`;
}

function getCached(key) {
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    cache.delete(key);
    return null;
  }
  return row.payload;
}

function setCached(key, payload) {
  cache.set(key, {payload, expiresAt: Date.now() + CACHE_TTL_MS});
}

function normalizeFilter(raw) {
  const s = String(raw || '').trim();
  return REVIEW_FILTERS.has(s) ? s : 'four_and_five';
}

function normalizeLimit(raw) {
  const n = parseInt(String(raw ?? '2'), 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(10, Math.max(2, n));
}

function sortReviewsNewestFirst(reviews) {
  return [...reviews].sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return tb - ta;
  });
}

function applyReviewFilter(reviews, filter) {
  if (filter === 'five_only') {
    return reviews.filter((r) => Number(r.stars ?? 0) === 5);
  }
  if (filter === 'four_and_five') {
    return reviews.filter((r) => Number(r.stars ?? 0) >= 4);
  }
  return reviews;
}

async function sendProxiedImage(url, res) {
  const now = Date.now();
  const hit = imageBytesCache.get(url);
  if (hit && now < hit.expiresAt) {
    res.setHeader('Content-Type', hit.contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(hit.body);
    return;
  }

  const upstream = await fetch(url);
  if (!upstream.ok) {
    res.status(502).end();
    return;
  }
  const contentType = upstream.headers.get('content-type') || 'image/png';
  const body = Buffer.from(await upstream.arrayBuffer());
  imageBytesCache.set(url, {
    body,
    contentType,
    expiresAt: now + IMAGE_CACHE_TTL_MS,
  });
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(body);
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With',
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.get('/brand/trustpilot-logo.svg', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('svg').send(TRUSTPILOT_LOGO_SVG);
});

/** Checkout Image can load this host (same as /api/proxy); Cloudinary often cannot. */
app.get('/img/tp/brandmark', async (req, res) => {
  try {
    await sendProxiedImage(TP_BRANDMARK_PNG, res);
  } catch (e) {
    res.status(502).end();
  }
});

/**
 * Rating strip as one path segment: /img/tp/r5, /img/tp/r4half — same depth as /img/tp/brandmark.
 * Checkout was loading brandmark but not /strip/... or /asset?k=... for some buyers.
 */
app.get('/img/tp/r:segment', async (req, res) => {
  const segment = String(req.params.segment);
  const url = TP_STRIP_URL_BY_SEGMENT[segment];
  if (!url) {
    return res.status(404).end();
  }
  try {
    await sendProxiedImage(url, res);
  } catch (e) {
    res.status(502).end();
  }
});

app.get('/img/tp/strip/:segment', async (req, res) => {
  const url = TP_STRIP_URL_BY_SEGMENT[String(req.params.segment)];
  if (!url) {
    return res.status(404).end();
  }
  try {
    await sendProxiedImage(url, res);
  } catch (e) {
    res.status(502).end();
  }
});

/**
 * Same PNGs as /img/tp/strip/:segment but one fixed path + query (matches /img/tp/brandmark depth).
 * Some checkout environments were not loading strip URLs with an extra path segment.
 */
app.get('/img/tp/asset', async (req, res) => {
  const k = String(req.query.k ?? '').trim();
  if (!k) {
    return res.status(400).end();
  }
  if (k === 'brandmark') {
    try {
      await sendProxiedImage(TP_BRANDMARK_PNG, res);
    } catch (e) {
      res.status(502).end();
    }
    return;
  }
  const url = TP_STRIP_URL_BY_SEGMENT[k];
  if (!url) {
    return res.status(404).end();
  }
  try {
    await sendProxiedImage(url, res);
  } catch (e) {
    res.status(502).end();
  }
});

app.get('/api/proxy', async (req, res) => {
  const buid = req.query.buid;
  const skipReviews = String(req.query.skipReviews || '') === '1';
  const filter = normalizeFilter(req.query.filter);
  const limit = normalizeLimit(req.query.limit);

  console.log('--- proxy request ---');
  console.log('BUID:', buid, 'skipReviews:', skipReviews, 'filter:', filter, 'limit:', limit);

  if (!buid || buid === 'undefined') {
    console.log('missing BUID');
    return res.status(400).json({error: 'Missing BUID'});
  }

  if (!API_KEY) {
    console.error('TRUSTPILOT_API_KEY is not set');
    return res.status(503).json({error: 'Review service unavailable'});
  }

  const cacheKey = proxyCacheKey(buid, skipReviews, filter, limit);
  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }

  try {
    const unitUrl = `https://api.trustpilot.com/v1/business-units/${buid}?apikey=${API_KEY}`;

    if (skipReviews) {
      const unitRes = await fetch(unitUrl);
      if (!unitRes.ok) {
        console.error('Trustpilot HTTP', unitRes.status);
        return res.status(502).json({error: 'Trustpilot API error'});
      }
      const unitData = await unitRes.json();
      const payload = {unitData, reviewsData: {reviews: []}};
      setCached(cacheKey, payload);
      console.log('ok (unit only)', unitData.displayName || buid);
      res.setHeader('X-Cache', 'MISS');
      return res.json(payload);
    }

    const reviewsUrl = `https://api.trustpilot.com/v1/business-units/${buid}/reviews?apikey=${API_KEY}&perPage=100`;

    const [unitRes, reviewsRes] = await Promise.all([
      fetch(unitUrl),
      fetch(reviewsUrl),
    ]);

    if (!unitRes.ok || !reviewsRes.ok) {
      console.error('Trustpilot HTTP', unitRes.status, reviewsRes.status);
      return res.status(502).json({error: 'Trustpilot API error'});
    }

    const unitData = await unitRes.json();
    const reviewsData = await reviewsRes.json();

    let reviews = Array.isArray(reviewsData.reviews) ? reviewsData.reviews : [];
    reviews = applyReviewFilter(reviews, filter);
    reviews = sortReviewsNewestFirst(reviews);
    reviewsData.reviews = reviews.slice(0, limit);

    const payload = {unitData, reviewsData};
    setCached(cacheKey, payload);

    console.log('ok', unitData.displayName || buid);
    res.setHeader('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error('proxy error:', error.message);
    res.status(500).json({error: 'Failed to connect to Trustpilot'});
  }
});

app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trustpilot proxy listening on ${PORT} (cache TTL ${CACHE_TTL_MS}ms)`);
});
