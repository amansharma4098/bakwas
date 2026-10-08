import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './server.mjs';

async function start(t, options = {}) {
  const server = createApp({ dbPath: ':memory:', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.listening ? new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) : undefined);
  return { server, base, request: (path = '/api/reviews', options) => fetch(base + path, options) };
}
const json = (body, method = 'POST', headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('reviews are public across visitors but deletion keys stay private', async t => {
  const app = await start(t);
  const payload = { rating: 2, text: '<img src=x onerror=alert(1)> A literal review.', role: 'Do not publish this field' };
  const posted = await app.request('/api/reviews', json(payload));
  assert.equal(posted.status, 201);
  const { review, deleteToken } = await posted.json();
  assert.ok(deleteToken.length >= 40);
  const feed = await (await fetch(app.base + '/api/reviews')).json();
  assert.equal(feed.total, 1);
  assert.equal(feed.reviews[0].text, payload.text);
  assert.deepEqual(Object.keys(feed.reviews[0]).sort(), ['createdAt', 'id', 'rating', 'text']);
  assert.equal(JSON.stringify(feed).includes(deleteToken), false);
  assert.equal((await app.request('/api/reviews/' + review.id, json({ deleteToken: 'wrong' }, 'DELETE'))).status, 404);
  assert.equal((await app.request('/api/reviews/' + review.id, json({ deleteToken }, 'DELETE'))).status, 200);
  assert.equal((await (await app.request()).json()).total, 0);
});

test('invalid ratings, empty reviews, oversized bodies, and cross-site writes are rejected', async t => {
  const app = await start(t);
  for (const body of [null, {}, { rating: 0, text: 'Bad' }, { rating: 6, text: 'Bad' }, { rating: 1.5, text: 'Bad' }, { rating: '1', text: 'Bad' }, { rating: 1, text: '   ' }, { rating: 1, text: 'a'.repeat(501) }]) {
    assert.equal((await app.request('/api/reviews', json(body))).status, 400);
  }
  assert.equal((await app.request('/api/reviews', json({ rating: 1, text: 'a'.repeat(9000) }))).status, 413);
  assert.equal((await app.request('/api/reviews', json({ rating: 1, text: 'Hello' }, 'POST', { Origin: 'https://unrelated.example' }))).status, 403);
  assert.equal((await app.request('/api/reviews', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await app.request('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await (await app.request()).json()).total, 0);
});

test('the sixth review from one address is rate-limited, even with a forged forwarding header', async t => {
  const app = await start(t);
  for (let index = 0; index < 5; index++) assert.equal((await app.request('/api/reviews', json({ rating: 1, text: `Review ${index}` }))).status, 201);
  const response = await app.request('/api/reviews', json({ rating: 1, text: 'One too many' }, 'POST', { 'X-Forwarded-For': '1.2.3.4' }));
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('reviews persist after a server restart and pagination does not repeat entries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bakwas-test-'));
  const dbPath = join(dir, 'reviews.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await start(t, { dbPath });
  const response = await first.request('/api/reviews', json({ rating: 4, text: 'A review that survives restarts.' }));
  assert.equal(response.status, 201);
  await response.json();
  await new Promise(resolve => { first.server.close(resolve); first.server.closeAllConnections(); });
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare('INSERT INTO reviews (rating, text, created_at, delete_hash) VALUES (1, ?, ?, ?)');
  for (let index = 0; index < 24; index++) insert.run(`Older review fixture ${index}`, new Date().toISOString(), '0'.repeat(64));
  db.close();
  const second = await start(t, { dbPath });
  const pageOne = await (await second.request()).json();
  const pageTwo = await (await second.request('/api/reviews?before=' + pageOne.nextCursor)).json();
  assert.equal(pageOne.total, 25);
  assert.equal(pageOne.reviews.length, 20);
  assert.equal(pageTwo.reviews.length, 5);
  assert.equal(pageTwo.nextCursor, null);
  assert.equal(new Set([...pageOne.reviews, ...pageTwo.reviews].map(review => review.id)).size, 25);
  assert.equal(pageTwo.reviews.at(-1).text, 'A review that survives restarts.');
  assert.equal((await second.request('/api/reviews?before=nope')).status, 400);
});

test('the configured site origin and moderator token work behind a proxy', async t => {
  const app = await start(t, { publicOrigin: 'https://parody.example', moderationToken: 'test-only-moderator-secret' });
  const posted = await app.request('/api/reviews', json({ rating: 1, text: 'A removable review.' }, 'POST', { Origin: 'https://parody.example' }));
  assert.equal(posted.status, 201);
  const { review } = await posted.json();
  const result = await app.request('/api/reviews/' + review.id, json({}, 'DELETE', { Origin: 'https://parody.example', Authorization: 'Bearer test-only-moderator-secret' }));
  assert.equal(result.status, 200);
});

test('only the page and review API are served; repository, database, and source files stay private', async t => {
  const app = await start(t);
  const page = await app.request('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /We're down\./);
  for (const path of ['/.git/config', '/.data/reviews.sqlite', '/server.mjs', '/package.json', '/README.md']) assert.equal((await app.request(path)).status, 404);
});
