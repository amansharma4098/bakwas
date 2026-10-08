import { createServer as createHttpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const sameSecret = (secret, digest) => timingSafeEqual(Buffer.from(hash(secret), 'hex'), Buffer.from(digest, 'hex'));

export function createApp({
  dbPath = resolve(root, '.data/reviews.sqlite'),
  publicOrigin = '',
  trustProxy = false,
  moderationToken = '',
} = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delete_hash TEXT NOT NULL
    );
  `);
  const html = readFileSync(resolve(root, 'index.html'));
  const origin = publicOrigin ? new URL(publicOrigin).origin : null;
  const moderationHash = moderationToken ? hash(moderationToken) : null;
  const limits = new Map();
  const addressSalt = randomBytes(32).toString('hex');
  const windowMs = 10 * 60 * 1000;
  const cleanLimits = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of limits) if (now >= value.resetAt) limits.delete(key);
  }, windowMs);
  cleanLimits.unref();

  function send(res, status, data, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(data));
  }
  function checkRate(req, res) {
    const forwarded = trustProxy && req.headers['x-forwarded-for'];
    const address = forwarded ? forwarded.split(',').at(-1).trim() : req.socket.remoteAddress || 'unknown';
    const key = hash(addressSalt + address);
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || now >= entry.resetAt) {
      if (limits.size >= 10000) {
        send(res, 503, { error: 'The review queue is busy. Please try again later.' });
        return false;
      }
      entry = { count: 0, resetAt: now + windowMs };
      limits.set(key, entry);
    }
    if (entry.count >= 5) {
      send(res, 429, { error: 'Five reviews in ten minutes is plenty of roasting. Please try again later.' }, { 'Retry-After': String(Math.ceil((entry.resetAt - now) / 1000)) });
      return false;
    }
    entry.count++;
    return true;
  }
  async function readJson(req) {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw Object.assign(new Error('Send JSON, please.'), { status: 415 });
    }
    const allowedOrigin = origin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if ((req.headers.origin && req.headers.origin !== allowedOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw Object.assign(new Error('Submit reviews from this site.'), { status: 403 });
    }
    let size = 0;
    const chunks = [];
    // Continue draining oversized requests without keeping their contents in memory.
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= 8192) chunks.push(chunk);
    }
    if (size > 8192) throw Object.assign(new Error('That review is too large.'), { status: 413 });
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('That request was not valid JSON.'), { status: 400 }); }
  }

  const server = createHttpServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (['GET', 'HEAD'].includes(req.method) && ['/', '/index.html'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (url.pathname === '/api/reviews' && req.method === 'GET') {
        const beforeValue = url.searchParams.get('before');
        const before = beforeValue === null ? Number.MAX_SAFE_INTEGER : Number(beforeValue);
        if (!Number.isSafeInteger(before) || before < 1) { send(res, 400, { error: 'Invalid review cursor.' }); return; }
        const rows = db.prepare('SELECT id, rating, text, created_at AS createdAt FROM reviews WHERE id < ? ORDER BY id DESC LIMIT 21').all(before);
        const more = rows.length > 20;
        const reviews = rows.slice(0, 20);
        const total = db.prepare('SELECT COUNT(*) AS total FROM reviews').get().total;
        send(res, 200, { reviews, total, nextCursor: more ? reviews.at(-1).id : null });
        return;
      }
      if (url.pathname === '/api/reviews' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5 || typeof body.text !== 'string' || body.text.trim().length < 3 || body.text.trim().length > 500) {
          send(res, 400, { error: 'Choose 1–5 stars and write a review between 3 and 500 characters.' });
          return;
        }
        if (!checkRate(req, res)) return;
        const deleteToken = randomBytes(32).toString('base64url');
        const review = { rating: body.rating, text: body.text.trim(), createdAt: new Date().toISOString() };
        const result = db.prepare('INSERT INTO reviews (rating, text, created_at, delete_hash) VALUES (?, ?, ?, ?)').run(review.rating, review.text, review.createdAt, hash(deleteToken));
        send(res, 201, { review: { id: Number(result.lastInsertRowid), ...review }, deleteToken });
        return;
      }
      const reviewId = url.pathname.match(/^\/api\/reviews\/([1-9]\d*)$/)?.[1];
      if (reviewId && req.method === 'DELETE') {
        const body = await readJson(req);
        const review = db.prepare('SELECT delete_hash FROM reviews WHERE id = ?').get(reviewId);
        const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
        const moderator = moderationHash && bearer && sameSecret(bearer, moderationHash);
        const owner = review && typeof body?.deleteToken === 'string' && sameSecret(body.deleteToken, review.delete_hash);
        if (!review || (!moderator && !owner)) { send(res, 404, { error: 'Review not found or deletion key unavailable.' }); return; }
        db.prepare('DELETE FROM reviews WHERE id = ?').run(reviewId);
        send(res, 200, { deleted: true });
        return;
      }
      send(res, 404, { error: 'Nothing here. Very on-brand.' });
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Reviews are temporarily unavailable. Please try again.' });
      else res.end();
    }
  });
  server.once('close', () => { clearInterval(cleanLimits); db.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp({
    dbPath: process.env.DB_PATH || resolve(root, '.data/reviews.sqlite'),
    publicOrigin: process.env.PUBLIC_ORIGIN || '',
    trustProxy: process.env.TRUST_PROXY === '1',
    moderationToken: process.env.MODERATION_TOKEN || '',
  });
  server.listen(port, host, () => console.log(`AI Studio parody is listening on http://${host}:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; server.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
