import { canonicalBase64, check, fail, failedCheck, now, randomId, rows, sql } from './http.mjs';
import { sessionGuard } from './auth.mjs';

const limits = {
  ai: { max: 2097152, chunk: 45000, ttl: 900, perOwner: 2, busy: 'ai_upload_limit' },
  collection: { max: 16777216, chunk: 32768, ttl: 120, perOwner: 4, busy: 'collection_upload_busy' },
};
export const isRowUpload = mode => mode === 'rows:migrate' || mode === 'rows:replace';

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
  const collection = kind === 'collection';
  const staged = collection && body.format === 'rows';
  const mode = collection ? (staged ? 'rows:' + body.mode : body.mode) : null;
  if (!Number.isSafeInteger(size) || (collection ? !['migrate', 'replace'].includes(body.mode)
    || (body.format != null && !staged) || size < (staged ? 0 : 2) : body.mime !== 'image/jpeg')) {
    issue(kind, 'invalid');
  }
  if (!staged && (size < 1 || size > max)) fail(413, kind === 'ai' ? 'ai_image_too_large' : 'request_too_large');
  const time = now();
  const id = collection && body.uploadId != null ? uploadId(kind, body.uploadId) : randomId();
  const commands = [
    sessionGuard(db, session),
    sql(db, 'DELETE FROM uploads WHERE expires <= ?', time),
  ];
  if (collection && body.supersedes != null) {
    const older = uploadId(kind, body.supersedes);
    if (older !== id) commands.push(sql(db, "DELETE FROM uploads WHERE id = ? AND owner = ? AND kind = 'collection' AND state = 'uploading'",
      older, session.token));
  }
  commands.push(sql(db, `INSERT INTO uploads(id, owner, kind, mode, size, expires)
      SELECT ?, ?, ?, ?, ?, ? WHERE
        (SELECT count(*) FROM uploads WHERE kind = ? AND state <> 'done') < 4 AND
        (SELECT count(*) FROM uploads WHERE kind = ? AND owner = ? AND state <> 'done') < ?
      ON CONFLICT(id) DO NOTHING`, id, session.token, kind, mode, size, time + ttl, kind, kind, session.token, perOwner),
  sql(db, 'SELECT mode, size, offset FROM uploads WHERE id = ? AND owner = ? AND kind = ?', id, session.token, kind));
  const state = (await db.batch(commands)).at(-1).results[0];
  if (!state) fail(429, busy, {}, collection ? ttl : 60);
  if (state.mode !== mode || state.size !== size) issue(kind, 'invalid');
  return { uploadId: id, offset: state.offset, chunkBytes: chunk, ...(kind === 'ai' ? { expiresIn: ttl } : {}) };
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
  return storePart(db, session, kind, id, offset, offset + binary.length, data, false);
}

export function uploadRowGroup(db, session, value, offset, count, data) {
  const id = uploadId('collection', value);
  const end = offset + count;
  if (!Number.isSafeInteger(end)) issue('collection', 'invalid');
  return storePart(db, session, 'collection', id, offset, end, data, true);
}

async function storePart(db, session, kind, id, offset, end, data, staged) {
  const time = now();
  const results = await db.batch([
    sessionGuard(db, session),
    sql(db, `INSERT INTO upload_chunks(upload_id, offset, data)
      SELECT id, ?, ? FROM uploads WHERE id = ? AND owner = ? AND kind = ?
        AND state = 'uploading' AND expires > ? AND offset = ? AND size >= ?
        AND (kind <> 'collection' OR (substr(mode, 1, 5) = 'rows:') = ?)
      ON CONFLICT(upload_id, offset) DO NOTHING`, offset, data, id, session.token, kind, time, offset, end, Number(staged)),
    sql(db, `UPDATE uploads SET offset = ?, expires = CASE WHEN kind = 'collection' THEN ? ELSE expires END
      WHERE changes() = 1 AND id = ? AND offset = ?`, end, time + limits.collection.ttl, id, offset),
    sql(db, `SELECT u.offset, u.state, u.mode, c.data FROM uploads u
      LEFT JOIN upload_chunks c ON c.upload_id = u.id AND c.offset = ?
      WHERE u.id = ? AND u.owner = ? AND u.kind = ? AND u.expires > ?`,
    offset, id, session.token, kind, time),
  ]);
  const state = results[3].results[0];
  if (!state) issue(kind, 'missing');
  if (kind === 'collection' && isRowUpload(state.mode) !== staged) issue(kind, 'invalid');
  if (state.state !== 'uploading') fail(409, 'collection_upload_uncertain');
  if (state.data !== data || state.offset < end) issue(kind, 'offset');
  return { offset: kind === 'ai' ? state.offset : end };
}

export async function uploadCancel(db, session, kind, value) {
  const id = uploadId(kind, value);
  await sql(db, "DELETE FROM uploads WHERE id = ? AND owner = ? AND kind = ? AND (kind = 'ai' OR state = 'uploading')",
    id, session.token, kind).run();
  return {};
}

export const readChunks = (db, id) => sql(db, 'SELECT data FROM upload_chunks WHERE upload_id = ? ORDER BY offset', id);

export function decodeChunks(chunks, size, kind) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const { data } of chunks) {
    const part = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(data) : atob(data);
    if (offset + part.length > size) issue(kind, kind === 'ai' ? 'incomplete' : 'offset');
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i++) bytes[offset + i] = part.charCodeAt(i);
    } else {
      bytes.set(part, offset);
    }
    offset += part.length;
  }
  if (offset !== size) issue(kind, kind === 'ai' ? 'incomplete' : 'offset');
  return bytes;
}

export async function claimPhoto(db, session, value) {
  const id = uploadId('ai', value);
  const time = now();
  const lease = randomId();
  try {
    const [, claimed, selected, chunks] = await db.batch([
      sessionGuard(db, session),
      sql(db, `UPDATE uploads SET state = 'recognizing', mode = ?, inserted = ?
        WHERE id = ? AND owner = ? AND kind = 'ai' AND expires > ? AND offset = size
          AND (state = 'uploading' OR (state = 'recognizing' AND inserted <= ?))`,
      lease, time + 45, id, session.token, time, time),
      sql(db, "SELECT size, offset, state, mode, inserted FROM uploads WHERE id = ? AND owner = ? AND kind = 'ai' AND expires > ?",
        id, session.token, time),
      sql(db, `SELECT data FROM upload_chunks WHERE upload_id = ? AND EXISTS(
        SELECT 1 FROM uploads WHERE id = ? AND owner = ? AND kind = 'ai' AND state = 'recognizing' AND mode = ?) ORDER BY offset`,
      id, id, session.token, lease),
    ]);
    const state = selected.results[0];
    if (!state) issue('ai', 'missing');
    if (state.state === 'done') return { result: JSON.parse(state.mode) };
    if (state.offset !== state.size) issue('ai', 'incomplete');
    if (!claimed.meta.changes) fail(409, 'ai_upload_busy', {}, Math.max(1, state.inserted - time));
    const claim = { id, lease };
    try { return { claim, bytes: decodeChunks(chunks.results, state.size, 'ai') }; }
    catch (error) {
      await releasePhoto(db, session, claim, true);
      throw error;
    }
  } catch (error) {
    if (failedCheck(error)) fail(401, 'ai_session_expired');
    throw error;
  }
}

export async function finishPhoto(db, session, { id, lease }, result) {
  // Keep the small answer for an idempotent replay and immediately discard
  // image bytes. A cancelled or superseded attempt cannot finish.
  try {
    const [, updated] = await db.batch([
      sessionGuard(db, session),
      sql(db, `UPDATE uploads SET state = 'done', mode = ?, inserted = NULL
        WHERE id = ? AND owner = ? AND kind = 'ai' AND state = 'recognizing' AND mode = ?`,
      JSON.stringify(result), id, session.token, lease),
      sql(db, 'DELETE FROM upload_chunks WHERE upload_id = ? AND changes() = 1', id),
    ]);
    if (!updated.meta.changes) issue('ai', 'missing');
  } catch (error) {
    if (failedCheck(error)) fail(401, 'ai_session_expired');
    throw error;
  }
}

export async function releasePhoto(db, session, { id, lease }, discard = false) {
  const command = discard ? 'DELETE FROM uploads' : "UPDATE uploads SET state = 'uploading', mode = NULL, inserted = NULL";
  await sql(db, command + " WHERE id = ? AND owner = ? AND kind = 'ai' AND state = 'recognizing' AND mode = ?",
    id, session.token, lease).run();
}

export async function collectionBytes(db, state) {
  if (state.offset !== state.size) issue('collection', 'offset');
  return decodeChunks(await rows(readChunks(db, state.id)), state.size, 'collection');
}
