const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
const fail = (message, status) => Object.assign(new Error(message), { status });
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const hash = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(hex);
async function matches(secret, digest) {
  const actual = await hash(secret);
  let diff = actual.length ^ digest.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ (digest.charCodeAt(i) || 0);
  return diff === 0;
}
async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail('Send JSON, please.', 415);
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw fail('Submit reviews from this site.', 403);
  if (Number(request.headers.get('content-length')) > 8192) throw fail('That review is too large.', 413);
  if (!request.body) throw fail('That request was not valid JSON.', 400);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); throw fail('That review is too large.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw fail('That request was not valid JSON.', 400); }
}
async function claimReviewSlot(request, env) {
  if (!env.RATE_LIMIT_SECRET) throw fail('Reviews are temporarily unavailable. Please try again shortly.', 503);
  const now = Date.now();
  const windowMs = 600000;
  const bucket = Math.floor(now / windowMs);
  const resetAt = (bucket + 1) * windowMs;
  // Cloudflare supplies this header. Store only a rotating HMAC, never the raw address.
  const address = request.headers.get('cf-connecting-ip') || 'local';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RATE_LIMIT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const addressKey = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${bucket}:${address}`)));
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM review_rate_limits WHERE reset_at <= ?').bind(now),
    env.DB.prepare(`INSERT INTO review_rate_limits (address_key, count, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(address_key) DO UPDATE SET count = count + 1 WHERE count < 5 RETURNING count`).bind(addressKey, resetAt),
  ]);
  return { allowed: results[1].results.length > 0, retryAfter: Math.ceil((resetAt - now) / 1000) };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/reviews' && request.method === 'GET') {
        const raw = url.searchParams.get('before');
        const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
        if (!Number.isSafeInteger(before) || before < 1) return json({ error: 'Invalid review cursor.' }, 400);
        const [page, count] = await env.DB.batch([
          env.DB.prepare('SELECT id, rating, text, created_at AS createdAt FROM reviews WHERE id < ? ORDER BY id DESC LIMIT 21').bind(before),
          env.DB.prepare('SELECT COUNT(*) AS total FROM reviews'),
        ]);
        const reviews = page.results.slice(0, 20);
        return json({ reviews, total: count.results[0].total, nextCursor: page.results.length > 20 ? reviews.at(-1).id : null });
      }
      if (url.pathname === '/api/reviews' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5 || typeof body.text !== 'string' || body.text.trim().length < 3 || body.text.trim().length > 500) return json({ error: 'Choose 1–5 stars and write a review between 3 and 500 characters.' }, 400);
        const limit = await claimReviewSlot(request, env);
        if (!limit.allowed) return json({ error: 'Five reviews in ten minutes is plenty of roasting. Please try again later.' }, 429, { 'Retry-After': String(limit.retryAfter) });
        const deleteToken = hex(crypto.getRandomValues(new Uint8Array(32)));
        const createdAt = new Date().toISOString();
        const review = await env.DB.prepare('INSERT INTO reviews (rating, text, created_at, delete_hash) VALUES (?, ?, ?, ?) RETURNING id, rating, text, created_at AS createdAt').bind(body.rating, body.text.trim(), createdAt, await hash(deleteToken)).first();
        return json({ review, deleteToken }, 201);
      }
      const id = url.pathname.match(/^\/api\/reviews\/([1-9]\d*)$/)?.[1];
      if (id && request.method === 'DELETE') {
        const body = await readJson(request);
        const review = await env.DB.prepare('SELECT delete_hash FROM reviews WHERE id = ?').bind(id).first();
        const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
        const moderator = env.MODERATION_TOKEN && bearer && await matches(bearer, await hash(env.MODERATION_TOKEN));
        const owner = review && typeof body?.deleteToken === 'string' && await matches(body.deleteToken, review.delete_hash);
        if (!review || (!moderator && !owner)) return json({ error: 'Review not found or deletion key unavailable.' }, 404);
        await env.DB.prepare('DELETE FROM reviews WHERE id = ?').bind(id).run();
        return json({ deleted: true });
      }
      if (url.pathname === '/favicon.ico' && request.method === 'GET') return new Response(null, { status: 204 });
      if (['/', '/index.html'].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method) && env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: 'Nothing here. Very on-brand.' }, 404);
    } catch (error) {
      return json({ error: error.status ? error.message : 'Reviews are temporarily unavailable. Please try again.' }, error.status || 500);
    }
  },
};
