import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { backupCover, coverKey, coverStatuses, serveCover } from '../backend/covers.mjs';
import { validatedCoverInfo } from '../backend/images.mjs';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile(new URL('../migrations/0001_savepoint.sql', import.meta.url), 'utf8'));

function statement(query, values = []) {
  const prepared = sqlite.prepare(query);
  return {
    bind: (...next) => statement(query, next),
    first: () => prepared.get(...values),
    all: () => ({ results: prepared.all(...values) }),
    run: () => ({ meta: { changes: prepared.run(...values).changes } }),
    execute() {
      return prepared.columns().length ? this.all() : this.run();
    },
  };
}
const db = {
  prepare: statement,
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(item => item.execute());
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
};

const entries = new Map();
let etag = 0;
const bucket = {
  async head(key) { return entries.get(key) ?? null; },
  async get(key) {
    const item = entries.get(key);
    return item ? { ...item, body: new Response(item.bytes).body } : null;
  },
  async list() { return { objects: [...entries.values()], truncated: false }; },
  async put(key, bytes, { httpMetadata, customMetadata, onlyIf } = {}) {
    if (onlyIf && onlyIf.etagMatches !== entries.get(key)?.etag) return null;
    const item = { key, bytes, size: bytes.length, httpMetadata, customMetadata,
      etag: String(++etag), uploaded: new Date() };
    entries.set(key, item);
    return item;
  },
};

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==', 'base64');
const truncated = png.subarray(0, 24);
const mime = { httpMetadata: { contentType: 'image/png' } };
const id = 'test-cover';
const revision = 'a'.repeat(64);
const nextRevision = 'b'.repeat(64);
const original = 'https://covers.example.org/okładka.png?' + 'x'.repeat(5000);
const key = await coverKey(original);
sqlite.prepare('INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(id, 'Synthetic test', 'PC', 'Cyfrowe', original, 'Do ogrania', 1, revision);

assert.deepEqual(validatedCoverInfo(png), { type: 'image/png', width: 2, height: 3 });
assert.equal(validatedCoverInfo(truncated), null);
assert.equal(validatedCoverInfo(png.subarray(0, -1)), null);

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let clock = originalNow();
let failOrigin = true;
let originCalls = 0;
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.hostname === 'cloudflare-dns.com') {
    assert.equal(url.searchParams.get('name'), 'covers.example.org');
    // A successful AAAA lookup is enough when A has no records.
    return Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'AAAA'
      ? [{ type: 28, data: '2606:4700:4700::1111' }] : [] });
  }
  assert.equal(url.href, new URL(original).href);
  originCalls++;
  return failOrigin ? new Response(null, { status: 503, headers: { 'Retry-After': '35' } }) : new Response(png);
};
Date.now = () => clock;
try {
  await bucket.put(key, truncated, mime);
  assert.equal((await coverStatuses(db, bucket, [id])).backups[0].ready, false);
  await assert.rejects(serveCover(db, bucket, id), { status: 404, id: 'cover_backup_unavailable' });

  // Claims made before this update did not distinguish slow providers from invalid images.
  sqlite.prepare("INSERT INTO cover_claims VALUES (?, 'retry', ?)").run(key, Math.floor(clock / 1000) + 21600);
  assert.deepEqual(await backupCover(db, bucket, id, 'savepoint.pages.dev'),
    { backup: { status: 'retry', retryAfter: 35 } });
  failOrigin = false;
  clock += 34000;
  assert.deepEqual(await backupCover(db, bucket, id, 'savepoint.pages.dev'),
    { backup: { status: 'retry', retryAfter: 1 } });
  assert.equal(originCalls, 1);
  clock += 1000;
  assert.deepEqual(await backupCover(db, bucket, id, 'savepoint.pages.dev'), { backup: { status: 'saved' } });
  assert.equal(originCalls, 2);
  assert.equal((await coverStatuses(db, bucket, [id])).backups[0].ready, true);
  const response = await serveCover(db, bucket, id, { revision });
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  sqlite.prepare('UPDATE games SET revision = ? WHERE id = ?').run(nextRevision, id);
  await assert.rejects(serveCover(db, bucket, id, { revision }), { status: 404, id: 'cover_not_found' });
  assert.equal((await serveCover(db, bucket, id, { revision: nextRevision })).status, 200);
  assert.equal((await serveCover(db, bucket, id)).status, 200, 'Unversioned clients still work');

  // A real legacy image remains available without contacting its origin.
  await bucket.put(key, png, mime);
  const pending = [];
  const legacy = await serveCover(db, bucket, id, { waitUntil: promise => pending.push(promise) });
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), png);
  await Promise.all(pending);
  assert.equal((await coverStatuses(db, bucket, [id])).backups[0].ready, true);
  assert.equal(originCalls, 2);
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  sqlite.close();
}
console.log('PASS: cover validation, legacy recovery, revisions, transient retry and long Unicode IPv6-only origins');
