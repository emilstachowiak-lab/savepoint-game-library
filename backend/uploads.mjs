import { canonicalBase64, check, fail, failedCheck, now, randomId, rows, sql } from './http.mjs';
import { sessionGuard } from './auth.mjs';

const limits = {
  ai: { max: 2097152, chunk: 45000, ttl: 900, perOwner: 2, busy: 'ai_upload_limit' },
  collection: { max: 16777216, chunk: 32768, ttl: 7200, perOwner: 4, busy: 'collection_upload_busy' },
};

function issue(kind, type) {
  if (type === 'missing') {
    if (kind === 'ai') fail(409, 'ai_upload_expired');
    fail(409, 'collection_upload_missing');
  }
  if (type === 'offset' && kind === 'collection') fail(409, 'collection_upload_offset');
  if (type === 'incomplete') fail(409, 'ai_upload_incomplete');
  fail(400, kind === 'ai' ? 'ai_invalid_upload' : 'collection_upload_invalid');
}

export async function uploadStart(db, session, kind, body) {
  const { max, chunk, ttl, perOwner, busy } = limits[kind];
  const { size } = body;
  const mode = kind === 'collection' ? body.mode : null;
  if (!Number.isSafeInteger(size) || (kind === 'ai' ? body.mime !== 'image/jpeg' : size < 2 || !['migrate', 'replace'].includes(mode))) {
    issue(kind, 'invalid');
  }
  if (size < 1 || size > max) fail(413, kind === 'ai' ? 'ai_image_too_large' : 'request_too_large');
  const time = now();
  const id = randomId();
  const results = await db.batch([
    sessionGuard(db, session),
    sql(db, 'DELETE FROM uploads WHERE expires <= ?', time),
    sql(db, `INSERT INTO uploads(id, owner, kind, mode, size, expires)
      SELECT ?, ?, ?, ?, ?, ? WHERE
        (SELECT count(*) FROM uploads WHERE kind = ? AND state <> 'done') < 4 AND
        (SELECT count(*) FROM uploads WHERE kind = ? AND owner = ? AND state <> 'done') < ?`,
    id, session.token, kind, mode, size, time + ttl, kind, kind, session.token, perOwner),
  ]);
  if (!results[2].meta.changes) fail(429, busy, {}, kind === 'ai' ? 60 : 0);
  return { uploadId: id, offset: 0, chunkBytes: chunk, ...(kind === 'ai' ? { expiresIn: ttl } : {}) };
}

function uploadId(kind, value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) issue(kind, 'invalid');
  return value;
}

export async function uploadState(db, session, kind, value) {
  const id = uploadId(kind, value);
  const state = await sql(db, 'SELECT * FROM uploads WHERE id = ? AND owner = ? AND kind = ? AND expires > ?',
    id, session.token, kind, now()).first();
  if (!state) issue(kind, 'missing');
  return state;
}

export async function uploadAppend(db, session, kind, body) {
  const id = uploadId(kind, body.uploadId);
  const { offset, data } = body;
  const binary = canonicalBase64(data, limits[kind].chunk);
  if (!binary || !Number.isSafeInteger(offset) || offset < 0 || offset > limits[kind].max) issue(kind, 'invalid');
  const end = offset + binary.length;
  const time = now();
  const results = await db.batch([
    sessionGuard(db, session),
    sql(db, `INSERT INTO upload_chunks(upload_id, offset, data)
      SELECT id, ?, ? FROM uploads WHERE id = ? AND owner = ? AND kind = ?
        AND state = 'uploading' AND expires > ? AND offset = ? AND size >= ?
      ON CONFLICT(upload_id, offset) DO NOTHING`, offset, data, id, session.token, kind, time, offset, end),
    sql(db, `UPDATE uploads SET offset = ? WHERE changes() = 1 AND id = ? AND offset = ?`, end, id, offset),
    sql(db, `SELECT u.offset, u.state, c.data FROM uploads u
      LEFT JOIN upload_chunks c ON c.upload_id = u.id AND c.offset = ?
      WHERE u.id = ? AND u.owner = ? AND u.kind = ? AND u.expires > ?`,
    offset, id, session.token, kind, time),
  ]);
  const state = results[3].results[0];
  if (!state) issue(kind, 'missing');
  if (state.state !== 'uploading') fail(409, 'collection_upload_uncertain');
  if (state.data !== data || state.offset < end) issue(kind, 'offset');
  return { offset: kind === 'ai' ? state.offset : end };
}

export async function uploadCancel(db, session, kind, value) {
  const id = uploadId(kind, value);
  await sql(db, "DELETE FROM uploads WHERE id = ? AND owner = ? AND kind = ? AND state = 'uploading'",
    id, session.token, kind).run();
  return {};
}

export const readChunks = (db, id) => sql(db, 'SELECT data FROM upload_chunks WHERE upload_id = ? ORDER BY offset', id);

export function decodeChunks(chunks, size, kind) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const { data } of chunks) {
    const part = atob(data);
    if (offset + part.length > size) issue(kind, kind === 'ai' ? 'incomplete' : 'offset');
    for (let i = 0; i < part.length; i++) bytes[offset++] = part.charCodeAt(i);
  }
  if (offset !== size) issue(kind, kind === 'ai' ? 'incomplete' : 'offset');
  return bytes;
}

export async function takePhoto(db, session, value) {
  const state = await uploadState(db, session, 'ai', value);
  if (state.offset !== state.size) issue('ai', 'incomplete');
  try {
    const result = await db.batch([
      sessionGuard(db, session),
      check(db, 'EXISTS(SELECT 1 FROM uploads WHERE id = ? AND expires > ? AND offset = size)', state.id, now()),
      readChunks(db, state.id),
      sql(db, 'DELETE FROM uploads WHERE id = ?', state.id),
    ]);
    return decodeChunks(result[2].results, state.size, 'ai');
  } catch (error) {
    if (failedCheck(error)) issue('ai', 'missing');
    throw error;
  }
}

export async function collectionBytes(db, state) {
  if (state.offset !== state.size) issue('collection', 'offset');
  return decodeChunks(await rows(readChunks(db, state.id)), state.size, 'collection');
}
