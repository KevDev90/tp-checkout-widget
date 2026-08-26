const TP_BRANDMARK_PNG =
  'https://res.cloudinary.com/dqe5ou2gv/image/upload/v1777760452/Trustpilot_brandmark_gr-blk_RGB-288x72-L_rfgzgx.png';

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

function withCors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: h,
  });
}

function corsJson(status, payload, cacheControl) {
  const h = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  });
  if (cacheControl) h.set('Cache-Control', cacheControl);
  return new Response(JSON.stringify(payload), {status, headers: h});
}

function corsText(status, text) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    },
  });
}

async function proxyImage(url) {
  const upstream = await fetch(url, {cf: {cacheTtl: 86400, cacheEverything: true}});
  if (!upstream.ok) {
    return new Response(null, {status: 502});
  }
  const h = new Headers(upstream.headers);
  h.set('Cache-Control', 'public, max-age=86400');
  return withCors(new Response(upstream.body, {status: 200, headers: h}));
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

async function handleApiProxy(request, env) {
  const u = new URL(request.url);
  const buid = String(u.searchParams.get('buid') || '').trim();
  const skipReviews = String(u.searchParams.get('skipReviews') || '') === '1';
  const filter = normalizeFilter(u.searchParams.get('filter'));
  const limit = normalizeLimit(u.searchParams.get('limit'));

  if (!buid) {
    return corsJson(400, {error: 'Missing BUID'});
  }
  if (!env.TRUSTPILOT_API_KEY) {
    return corsJson(503, {error: 'Review service unavailable'});
  }

  const cache = caches.default;
  const cacheReq = new Request(u.toString(), request);
  const hit = await cache.match(cacheReq);
  if (hit) {
    const out = withCors(hit);
    out.headers.set('X-Cache', 'HIT');
    return out;
  }

  const unitUrl = `https://api.trustpilot.com/v1/business-units/${encodeURIComponent(buid)}?apikey=${encodeURIComponent(env.TRUSTPILOT_API_KEY)}`;

  if (skipReviews) {
    const unitRes = await fetch(unitUrl);
    if (!unitRes.ok) {
      return corsJson(502, {error: 'Trustpilot API error'});
    }
    const unitData = await unitRes.json();
    const body = JSON.stringify({unitData, reviewsData: {reviews: []}});
    const resp = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=900',
        'X-Cache': 'MISS',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      },
    });
    await cache.put(cacheReq, resp.clone());
    return resp;
  }

  const reviewsUrl = `https://api.trustpilot.com/v1/business-units/${encodeURIComponent(buid)}/reviews?apikey=${encodeURIComponent(env.TRUSTPILOT_API_KEY)}&perPage=100`;

  const [unitRes, reviewsRes] = await Promise.all([fetch(unitUrl), fetch(reviewsUrl)]);
  if (!unitRes.ok || !reviewsRes.ok) {
    return corsJson(502, {error: 'Trustpilot API error'});
  }

  const unitData = await unitRes.json();
  const reviewsData = await reviewsRes.json();
  let reviews = Array.isArray(reviewsData.reviews) ? reviewsData.reviews : [];
  reviews = applyReviewFilter(reviews, filter);
  reviews = sortReviewsNewestFirst(reviews);
  reviewsData.reviews = reviews.slice(0, limit);

  const body = JSON.stringify({unitData, reviewsData});
  const resp = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=900',
      'X-Cache': 'MISS',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    },
  });
  await cache.put(cacheReq, resp.clone());
  return resp;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        },
      });
    }

    const u = new URL(request.url);
    if (u.pathname === '/health') return corsText(200, 'ok');
    if (u.pathname === '/img/tp/brandmark') return proxyImage(TP_BRANDMARK_PNG);
    if (u.pathname.startsWith('/img/tp/r')) {
      const segment = u.pathname.slice('/img/tp/r'.length);
      const src = TP_STRIP_URL_BY_SEGMENT[segment];
      if (!src) return corsText(404, 'Not found');
      return proxyImage(src);
    }
    if (u.pathname === '/api/proxy') return handleApiProxy(request, env);
    return corsText(404, 'Not found');
  },
};
