import assert from 'node:assert/strict';
import { collectionAction, importRows, listGamePage, saveGame } from '../backend/collection.mjs';
import { now } from '../backend/http.mjs';
import { d1Fixture } from './sqlite-d1.mjs';

const { db, sqlite } = d1Fixture();
const session = { token: 'synthetic-collection-session' };
sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(session.token, now(), now());
const original = { id: 'original', title: 'Original game', platform: 'PC', createdAt: 1 };
await saveGame(db, session, { game: original, delta: true });

const call = (action, body) => collectionAction(db, session, action, body, () => listGamePage(db));
const start = (uploadId, size, extra = {}) => call('collection-upload-start', { format: 'rows', mode: 'replace', uploadId, size, ...extra });
const stage = (uploadId, offset, games) => call('collection-upload-group', { uploadId, offset, games });
const finish = uploadId => call('collection-upload-finish', { uploadId });

const upload = 'a'.repeat(32);
const longCover = 'https://images.example.org/' + 'x'.repeat(63900);
const source = Array.from({ length: 5001 }, (_, index) => ({ ...original, id: 'test-' + String(index).padStart(4, '0'),
  coverUrl: index < 275 ? longCover : '' }));
assert(Buffer.byteLength(JSON.stringify(source)) > 16 * 1024 * 1024);
const reply = await start(upload, source.length);
assert.deepEqual(await start(upload, source.length), reply, 'The same start request allocates only one upload');
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM uploads').get().n, 1);
await assert.rejects(finish(upload), { id: 'collection_upload_offset' });
const first = await stage(upload, 0, source.slice(0, 1));
assert.deepEqual(await stage(upload, 0, source.slice(0, 1)), first, 'A repeated group keeps the same offset');
await assert.rejects(stage(upload, 0, [{ ...source[0], title: 'Changed retry' }]), { id: 'collection_upload_offset' });
let offset = first.offset;
while (offset < source.length) {
  const length = offset < 275 ? 1 : 100;
  const response = await stage(upload, offset, source.slice(offset, offset + length));
  offset = response.offset;
}
assert.deepEqual((await listGamePage(db)).games.map(game => game.id), [original.id]);
const restored = await finish(upload);
assert.equal(restored.inserted, source.length);
assert.equal((await finish(upload)).inserted, source.length, 'The committed result is replay-safe');
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM games').get().n, source.length);
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM upload_chunks').get().n, 0);
let page = restored;
const ids = [];
for (;;) {
  assert(page.games.reduce((bytes, game) => bytes + game.coverUrl.length, 0) <= 512 * 1024);
  ids.push(...page.games.map(game => game.id));
  if (!page.nextGameId) break;
  page = await listGamePage(db, page.nextGameId, page.collectionVersion);
}
assert.deepEqual(ids, source.map(game => game.id));
console.log('PASS: a backup larger than 16 MiB and 5,000 games restores atomically and reads back in bounded pages.');

const duplicate = 'b'.repeat(32);
await start(duplicate, 2);
await stage(duplicate, 0, [{ ...original, id: 'dupe' }]);
await stage(duplicate, 1, [{ ...original, id: 'DUPE' }]);
await assert.rejects(finish(duplicate), { id: 'collection_import_conflict' });
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM games').get().n, source.length);
const pageBeforeMutation = await listGamePage(db);
await saveGame(db, session, { game: original, delta: true });
await assert.rejects(listGamePage(db, pageBeforeMutation.nextGameId, pageBeforeMutation.collectionVersion), { id: 'collection_changed' });
console.log('PASS: cross-group duplicates roll the restore back, and mutations invalidate a subsequent read page.');

const legacy = { title: 'Legacy import', platform: ['PC', 'PlayStation 5'] };
const [firstLegacy] = await importRows([legacy]);
const [retriedLegacy] = await importRows([legacy], 0);
assert.deepEqual(firstLegacy, retriedLegacy);
assert.equal(firstLegacy.created_at, 0);
assert.equal(firstLegacy.platform, 'PC, PlayStation 5');
await assert.rejects(importRows([{ ...legacy, platform: [{}] }]), { id: 'invalid_game_data' });
const abandoned = 'c'.repeat(32);
const replacement = 'd'.repeat(32);
await start(abandoned, 1);
await start(replacement, 1, { supersedes: abandoned });
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM uploads WHERE id = ?').get(abandoned).n, 0);
const leaseExpiry = sqlite.prepare('SELECT expires FROM uploads WHERE id = ?').get(replacement).expires;
assert(leaseExpiry > now() && leaseExpiry <= now() + 120);
console.log('PASS: legacy identities are repeatable, malformed platforms fail, and abandoned uploads can be superseded.');
