import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

async function fixture(t) {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'bakwas-test', modules: true, scriptPath: 'worker.mjs', compatibilityDate: '2026-10-08', d1Databases: ['DB'], bindings: { RATE_LIMIT_SECRET: 'local-test-only', MODERATION_TOKEN: 'test-moderator' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const migration = await readFile(new URL('./migrations/0001_public_reviews.sql', import.meta.url), 'utf8');
  for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  return { db, request: (path = '/api/reviews', options = {}) => mf.dispatchFetch('https://test.example' + path, options) };
}
const json = (body, method = 'POST', headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('Cloudflare D1 publishes reviews, hides deletion secrets, and permits only owner or moderator deletion', async t => {
  const app = await fixture(t);
  const response = await app.request('/api/reviews', json({ rating: 2, text: '<script>literal text</script>' }));
  assert.equal(response.status, 201);
  const { review, deleteToken } = await response.json();
  const feed = await (await app.request()).json();
  assert.equal(feed.total, 1);
  assert.equal(feed.reviews[0].text, '<script>literal text</script>');
  assert.deepEqual(Object.keys(feed.reviews[0]).sort(), ['createdAt', 'id', 'rating', 'text']);
  assert.equal(JSON.stringify(feed).includes(deleteToken), false);
  assert.equal((await app.request('/api/reviews/' + review.id, json({ deleteToken: 'wrong' }, 'DELETE'))).status, 404);
  assert.equal((await app.request('/api/reviews/' + review.id, json({ deleteToken }, 'DELETE'))).status, 200);
  const second = await (await app.request('/api/reviews', json({ rating: 1, text: 'Moderator test' }))).json();
  assert.equal((await app.request('/api/reviews/' + second.review.id, json({}, 'DELETE', { Authorization: 'Bearer test-moderator' }))).status, 200);
  assert.equal((await (await app.request()).json()).total, 0);
});

test('Cloudflare rejects bad input, oversized requests, cross-origin writes, and private paths', async t => {
  const app = await fixture(t);
  for (const body of [null, {}, { rating: 0, text: 'Invalid' }, { rating: 6, text: 'Invalid' }, { rating: 1, text: ' ' }, { rating: 1, text: 'x'.repeat(501) }]) assert.equal((await app.request('/api/reviews', json(body))).status, 400);
  assert.equal((await app.request('/api/reviews', json({ rating: 1, text: 'x'.repeat(9000) }))).status, 413);
  assert.equal((await app.request('/api/reviews', json({ rating: 1, text: 'Cross site' }, 'POST', { Origin: 'https://other.example' }))).status, 403);
  assert.equal((await app.request('/api/reviews', { method: 'POST', body: '{}' })).status, 415);
  for (const path of ['/.git/config', '/worker.mjs', '/wrangler.jsonc', '/.data/reviews.sqlite']) assert.equal((await app.request(path)).status, 404);
});

test('Cloudflare rate limits are enforced atomically across concurrent writes', async t => {
  const app = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => app.request('/api/reviews', json({ rating: 1, text: 'Concurrent review ' + index }))));
  assert.equal(responses.filter(response => response.status === 201).length, 5);
  assert.equal(responses.filter(response => response.status === 429).length, 3);
  assert.equal((await (await app.request()).json()).total, 5);
  const stored = await app.db.prepare('SELECT address_key, count FROM review_rate_limits').all();
  assert.equal(stored.results.length, 1);
  assert.match(stored.results[0].address_key, /^[a-f0-9]{64}$/);
  assert.equal(stored.results[0].count, 5);
});

test('Cloudflare pagination lists every review without exposing private columns', async t => {
  const app = await fixture(t);
  for (let index = 0; index < 25; index++) await app.db.prepare('INSERT INTO reviews (rating, text, created_at, delete_hash) VALUES (1, ?, ?, ?)').bind('Review ' + index, new Date().toISOString(), '0'.repeat(64)).run();
  const first = await (await app.request()).json();
  const second = await (await app.request('/api/reviews?before=' + first.nextCursor)).json();
  assert.equal(first.reviews.length, 20);
  assert.equal(second.reviews.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.reviews, ...second.reviews].map(review => review.id)).size, 25);
  assert.equal((await app.request('/api/reviews?before=invalid')).status, 400);
});
