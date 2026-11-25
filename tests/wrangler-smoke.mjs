// Run on an empty local Pages database with the official development Turnstile keys.
// Set SAVEPOINT_TEST_USERNAME and SAVEPOINT_TEST_PASSWORD to the local test account values.
// Usage: node tests/wrangler-smoke.mjs http://127.0.0.1:8788
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8788');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('This test requires a local development server.');
const baseUrl = base.origin;
const username = process.env.SAVEPOINT_TEST_USERNAME;
const password = process.env.SAVEPOINT_TEST_PASSWORD;
if (!username || !password) throw new Error('Set SAVEPOINT_TEST_USERNAME and SAVEPOINT_TEST_PASSWORD.');

let cookie;
async function request(expected, { body, query = '', origin = baseUrl, type = 'application/json', withCookie = true } = {}) {
  const response = await fetch(baseUrl + '/api/games.php' + query, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Accept-Language': 'en',
      ...(withCookie && cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': type }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  assert.equal(result.ok, expected < 400);
  assert.match(response.headers.get('cache-control'), /no-store/);
  return { response, result };
}
const post = (body, expected = 200, options) => request(expected, { body, ...options });

const page = await fetch(baseUrl + '/');
assert.equal(page.status, 200);
assert.equal(await page.text(), await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
assert.match(page.headers.get('content-security-policy'), /challenges.cloudflare.com/);
assert.equal((await fetch(baseUrl + '/.dev.vars')).status, 404);
assert.equal((await fetch(baseUrl + '/api/')).status, 403);
assert.equal((await fetch(baseUrl + '/api/unknown.php')).status, 404);
const anonymous = (await request(401)).result;
assert.equal(anonymous.captcha.provider, 'turnstile');
assert.equal((await request(401, { query: '?session=1' })).result.captcha, undefined);
await request(400, { query: '?session=1&cover=1' });
await post({ action: 'login' }, 403, { origin: 'https://other.example' });
await post({}, 415, { type: 'multipart/form-data' });
await post('{"large":"' + 'a'.repeat(65536) + '"}', 413);
await post('[]', 400);
await post({ action: 'login', username, password, website: 'filled' }, 422);

const login = await post({ action: 'login', username, password, captcha: { token: 'XXXX.DUMMY.TOKEN.XXXX' } });
assert.deepEqual(login.result.games, [], 'Use an empty development database.');
const setCookie = login.response.headers.get('set-cookie');
assert.match(setCookie, /HttpOnly; SameSite=Strict; Secure/i);
cookie = setCookie.split(';')[0];
assert.equal(login.result.session.absoluteExpiresAt - login.result.session.authenticatedAt, 28800);
assert.equal(login.result.session.idleExpiresAt - login.result.session.lastActivityAt, 1800);
await request(200, { query: '?session=1' });
assert.equal((await post({ action: 'ai-status' })).result.available, false);

const saved = {
  id: 'smoke-game', title: 'Przykładowa gra', platform: 'PlayStation 2, PC, PC', edition: 'Fizyczne',
  status: 'Do ogrania', coverUrl: '', createdAt: 123456,
};
const created = (await post({ action: 'save', mode: 'create', game: saved, delta: true })).result.game;
assert.equal(created.platform, 'PlayStation 2, PC');
assert.match(created.revision, /^[a-f0-9]{64}$/);
assert.equal((await post({ action: 'save', game: saved, delta: true })).result.game.revision, created.revision);
const edited = (await post({ action: 'save', mode: 'edit', game: { ...saved, title: 'Nowy tytuł', createdAt: 456 },
  revision: created.revision, delta: true })).result.game;
assert.notEqual(edited.revision, created.revision);
assert.equal(edited.createdAt, saved.createdAt);
await post({ action: 'delete', id: saved.id, revision: created.revision, delta: true }, 409);
assert.deepEqual((await post({ action: 'backup-cover-status', ids: [saved.id] })).result.backups,
  [{ id: saved.id, coverUrl: '', ready: false }]);
await request(404, { query: '?cover=smoke-game' });
await request(401, { query: '?cover=smoke-game', withCookie: false });
await post({ action: 'migrate', games: [{ ...saved, id: 'rollback-probe' }, saved] }, 409);
assert.deepEqual((await request(200)).result.games.map(game => game.id), [saved.id]);
await post({ action: 'delete', id: saved.id, revision: edited.revision, delta: true });

const games = Array.from({ length: 180 }, (_, index) => ({ ...saved, id: 'staged-' + index, title: 'ź'.repeat(200) }));
const archive = Buffer.from(JSON.stringify(games));
assert.ok(archive.length > 65536);
const { uploadId, chunkBytes } = (await post({ action: 'collection-upload-start', mode: 'replace', size: archive.length })).result;
for (let offset = 0; offset < archive.length; offset += chunkBytes) {
  const bytes = archive.subarray(offset, offset + chunkBytes);
  const message = { action: 'collection-upload-chunk', uploadId, offset, data: bytes.toString('base64') };
  assert.equal((await post(message)).result.offset, offset + bytes.length);
  if (offset === 0) assert.equal((await post(message)).result.offset, bytes.length);
}
const finish = await post({ action: 'collection-upload-finish', uploadId });
assert.equal(finish.result.inserted, games.length);
assert.equal(finish.result.games.length, games.length);
assert.equal((await post({ action: 'collection-upload-finish', uploadId })).result.inserted, games.length);
await post({ action: 'replace', games: [] });
assert.deepEqual((await request(200)).result.games, []);
assert.match((await post({ action: 'logout' })).response.headers.get('set-cookie'), /Max-Age=0/i);
await request(401, { query: '?session=1' });
console.log('PASS: Pages routes and static files, Turnstile login, session, CRUD, R2 status, rollback, staged import and logout.');
