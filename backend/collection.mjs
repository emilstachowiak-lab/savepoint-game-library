import {
  check, encoder, fail, failedCheck, isGameId, isRevision, now, object, parseJson,
  rows, sha256, sql, validText,
} from './http.mjs';
import { sessionGuard } from './auth.mjs';
import {
  collectionBytes, isRowUpload, uploadAppend, uploadCancel, uploadRowGroup, uploadStart, uploadState,
} from './uploads.mjs';

const columns = ['id', 'title', 'platform', 'edition', 'cover_url', 'status', 'created_at'];
const gameFields = columns.slice(1, -1);
const trim = value => typeof value === 'string' ? value.replace(/^ +| +$/g, '') : '';

function coverUrl(value) {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f\\]/u.test(value) || !/^https?:\/\/[^/]/i.test(value)) return null;
  try {
    const url = new URL(value);
    const authority = value.split(/[/?#]/)[2];
    return !authority?.includes('@') && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function normalizePlatform(value) {
  if (typeof value !== 'string' || encoder.encode(value).length > 1649) {
    fail(422, 'game_title_and_platform_required');
  }
  const list = [...new Set(value.split(',').map(trim).filter(Boolean))];
  const spaced = list.join(', ');
  const result = validText(spaced, 400) ? spaced : list.join(',');
  if (list.length > 50 || !validText(result, 400)) fail(422, 'game_title_and_platform_required');
  return result;
}

export function normalizeGame(game) {
  if (!object(game)) fail(422, 'invalid_game_data');
  const title = trim(game.title);
  if (!validText(title, 255)) fail(422, 'game_title_and_platform_required');
  const platform = normalizePlatform(game.platform);
  const id = game.id;
  if (!isGameId(id)) fail(422, 'invalid_game_data');
  const defaults = { edition: 'Fizyczne', status: 'Do ogrania' };
  const details = {};
  for (const [field, fallback] of Object.entries(defaults)) {
    const candidate = game[field] ?? fallback;
    if (typeof candidate !== 'string') fail(422, 'invalid_game_data');
    details[field] = trim(candidate) || fallback;
    if (!validText(details[field], 50)) fail(422, 'invalid_game_data');
  }
  const cover = game.coverUrl ?? '';
  if (typeof cover !== 'string' || encoder.encode(cover).length > 65535) fail(422, 'invalid_game_data');
  const cover_url = trim(cover);
  if (cover_url && !coverUrl(cover_url)) fail(422, 'invalid_game_data');
  const input = game.createdAt ?? Date.now();
  const created_at = typeof input === 'string' && /^[+-]?(?:0|[1-9][0-9]*)$/.test(input.trim()) ? Number(input) : input;
  if (!Number.isSafeInteger(created_at) || created_at < 0) fail(422, 'invalid_game_data');
  return { id, title, platform, cover_url, created_at, ...details };
}

export function publicGame(row) {
  return {
    id: row.id, title: row.title, platform: row.platform, edition: row.edition,
    coverUrl: coverUrl(row.cover_url) ? row.cover_url : '',
    status: row.status, createdAt: row.created_at, revision: row.revision,
  };
}

export const listGames = async db => (await rows(db.prepare('SELECT * FROM games'))).map(publicGame);
const pageSize = 256;
const pageBytes = 512 * 1024;

// Limit both row count and content bytes before reading the query response.
// The first row beyond a limit is a continuation marker, not part of the page.
const pageQuery = `WITH candidates AS (
    SELECT *, 256 + length(CAST(title AS BLOB)) + length(CAST(platform AS BLOB))
      + length(CAST(cover_url AS BLOB)) + length(CAST(edition AS BLOB)) + length(CAST(status AS BLOB)) AS bytes
    FROM games WHERE id > ? COLLATE NOCASE ORDER BY id COLLATE NOCASE LIMIT ?
  ), cumulative AS (
    SELECT *, sum(bytes) OVER (ORDER BY id COLLATE NOCASE ROWS UNBOUNDED PRECEDING) AS page_bytes
    FROM candidates
  )
  SELECT * FROM cumulative WHERE page_bytes - bytes <= ? ORDER BY id COLLATE NOCASE`;

export async function listGamePage(db, after = '', expectedVersion = null) {
  if (after && (!isGameId(after) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
    fail(400, 'collection_invalid_page');
  }
  const [state, page] = await db.batch([
    db.prepare('SELECT version FROM collection_revision WHERE key = 1'),
    sql(db, pageQuery, after, pageSize + 1, pageBytes),
  ]);
  const collectionVersion = state.results[0].version;
  if (after && collectionVersion !== expectedVersion) fail(409, 'collection_changed');
  const games = page.results.slice(0, pageSize).filter(row => row.page_bytes <= pageBytes).map(publicGame);
  return { games, collectionVersion, nextGameId: page.results.length > games.length ? games.at(-1).id : null };
}
export const findGame = (db, id) => sql(db, 'SELECT * FROM games WHERE id = ?', id).first();
export const sameGame = (a, b) => columns.every(key => a[key] === b[key]);

export async function saveGame(db, session, body, snapshot = () => readFullCollection(db)) {
  if (!object(body.game)) fail(422, 'game_data_missing');
  const mode = body.mode ?? 'create';
  if (!['edit', 'create'].includes(mode)) fail(422, 'invalid_game_data');
  if (mode === 'edit' && !isRevision(body.revision)) fail(409, 'collection_conflict');
  const game = normalizeGame(body.game);
  const command = mode === 'create'
    ? sql(db, `INSERT INTO games(${columns.join(',')}) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      ...columns.map(key => game[key]))
    : sql(db, `UPDATE games SET ${gameFields.map(key => key + ' = ?').join(',')}, revision = lower(hex(randomblob(32)))
         WHERE id = ? COLLATE BINARY AND revision = ?
           AND NOT (${gameFields.map(key => key + ' = ?').join(' AND ')})`,
      ...gameFields.map(key => game[key]), game.id, body.revision, ...gameFields.map(key => game[key]));
  const result = await db.batch([
    sessionGuard(db, session), command, sql(db, 'SELECT * FROM games WHERE id = ?', game.id),
  ]);
  const current = result[2].results[0];
  if (mode === 'edit' && current) game.created_at = current.created_at;
  if (!current || !sameGame(current, game)) fail(409, 'collection_conflict');
  return body.delta === true ? { game: publicGame(current) } : snapshot();
}

export async function deleteGame(db, session, body, snapshot = () => readFullCollection(db)) {
  if (!isGameId(body.id)) fail(422, 'invalid_game_data');
  if (!isRevision(body.revision)) fail(409, 'collection_conflict');
  const result = await db.batch([
    sessionGuard(db, session),
    sql(db, 'DELETE FROM games WHERE id = ? COLLATE BINARY AND revision = ?', body.id, body.revision),
    sql(db, 'SELECT id FROM games WHERE id = ?', body.id),
  ]);
  if (result[2].results.length) fail(409, 'collection_conflict');
  return body.delta === true ? { deletedId: body.id } : snapshot();
}

function phpSerialize(value) {
  if (value === null) return 'N;';
  if (typeof value === 'boolean') return value ? 'b:1;' : 'b:0;';
  if (typeof value === 'number') return `${Number.isSafeInteger(value) ? 'i' : 'd'}:${value};`;
  if (typeof value === 'string') return `s:${encoder.encode(value).length}:"${value}";`;
  const entries = Object.entries(value);
  const items = entries.map(([key, item]) => phpSerialize(/^-?(?:0|[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(Number(key))
    ? Number(key) : key) + phpSerialize(item));
  return `a:${entries.length}:{${items.join('')}}`;
}

export async function importRows(items, startIndex = 0) {
  if (!Array.isArray(items) || items.length > 5000) fail(422, 'invalid_game_collection');
  const seen = new Set();
  const result = [];
  for (const [index, item] of items.entries()) {
    if (!object(item)) fail(422, 'invalid_game_data');
    const id = item.id == null || item.id === ''
      ? 'legacy-' + (await sha256(phpSerialize([startIndex + index, item]))).slice(0, 29)
      : item.id;
    const platform = item.platform;
    if (Array.isArray(platform) && !platform.every(item => typeof item === 'string')) fail(422, 'invalid_game_data');
    const game = normalizeGame({ ...item, id, platform: Array.isArray(platform) ? platform.join(',') : platform,
      createdAt: item.createdAt ?? 0 });
    const key = id.toLowerCase();
    if (seen.has(key)) fail(409, 'collection_import_conflict');
    seen.add(key);
    result.push(game);
  }
  return result;
}

function groups(games) {
  const result = [];
  let group = [];
  let size = 0;
  for (const game of games) {
    const row = JSON.stringify(columns.map(key => game[key]));
    const bytes = encoder.encode(row).length + 1;
    if (size + bytes > 240000) {
      result.push('[' + group.join(',') + ']');
      group = [];
      size = 0;
    }
    group.push(row);
    size += bytes;
  }
  if (group.length) result.push('[' + group.join(',') + ']');
  return result;
}

const fields = columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(',');
const matches = columns.map(key => `games.${key} = excluded.${key} COLLATE BINARY`).join(' AND ');
const readFullCollection = async db => ({ games: await listGames(db) });

export async function insertGames(db, session, games, mode, uploadId = null, conflict = 'collection_import_conflict') {
  const commands = [sessionGuard(db, session)];
  const inserts = [];
  if (uploadId) {
    commands.push(check(db, `EXISTS(SELECT 1 FROM uploads WHERE id = ? AND owner = ?
        AND state = 'uploading' AND offset = size AND expires > ?)`, uploadId, session.token, now()));
    commands.push(sql(db, 'UPDATE uploads SET inserted = 0 WHERE id = ?', uploadId));
  }
  if (mode === 'replace') commands.push(db.prepare('DELETE FROM games'));

  for (const data of groups(games)) {
    commands.push(sql(db, `INSERT INTO games(${columns.join(',')})
      SELECT ${fields} FROM json_each(?) WHERE true
      ON CONFLICT(id) DO UPDATE SET revision = NULL WHERE NOT (${matches})`, data));
    inserts.push(commands.length);
    commands.push(db.prepare('SELECT changes() AS inserted'));
    if (uploadId) commands.push(sql(db, 'UPDATE uploads SET inserted = inserted + changes() WHERE id = ?', uploadId));
  }
  if (uploadId) {
    commands.push(sql(db, "UPDATE uploads SET state = 'done' WHERE id = ?", uploadId),
      sql(db, 'DELETE FROM upload_chunks WHERE upload_id = ?', uploadId));
  }
  try {
    const result = await db.batch(commands);
    return inserts.reduce((count, index) => count + result[index].results[0].inserted, 0);
  } catch (error) {
    if (String(error?.message).includes('NOT NULL constraint failed: games.revision')) fail(409, conflict);
    if (uploadId && failedCheck(error)) {
      const state = await uploadState(db, session, 'collection', uploadId);
      if (state.state === 'done') return state.inserted;
    }
    throw error;
  }
}

async function finishRowUpload(db, session, state) {
  const conflict = 'collection_import_conflict';
  if (state.offset !== state.size) fail(409, 'collection_upload_offset');
  const selected = 'FROM upload_chunks, json_each(upload_chunks.data) WHERE upload_id = ?';
  const mode = state.mode.slice(5);
  const commands = [
    sessionGuard(db, session),
    check(db, `EXISTS(SELECT 1 FROM uploads WHERE id = ? AND owner = ?
      AND state = 'uploading' AND offset = size AND expires > ?)`, state.id, session.token, now()),
    check(db, `NOT EXISTS(SELECT 1 ${selected} GROUP BY json_extract(value, '$[0]') COLLATE NOCASE HAVING count(*) > 1)`, state.id),
  ];
  if (mode === 'replace') commands.push(db.prepare('DELETE FROM games'));
  commands.push(sql(db, `INSERT INTO games(${columns.join(',')}) SELECT ${fields} ${selected}
    ON CONFLICT(id) DO UPDATE SET revision = NULL WHERE NOT (${matches})`, state.id),
  sql(db, "UPDATE uploads SET inserted = changes(), state = 'done' WHERE id = ?", state.id),
  sql(db, 'DELETE FROM upload_chunks WHERE upload_id = ?', state.id),
  sql(db, 'SELECT inserted FROM uploads WHERE id = ?', state.id));
  try {
    return (await db.batch(commands)).at(-1).results[0].inserted;
  } catch (error) {
    if (String(error?.message).includes('NOT NULL constraint failed: games.revision')) fail(409, conflict);
    if (!failedCheck(error)) throw error;
    await sessionGuard(db, session).run();
    const current = await uploadState(db, session, 'collection', state.id);
    if (current.state === 'done') return current.inserted;
    fail(409, conflict);
  }
}

export async function collectionAction(db, session, action, body, snapshot = () => readFullCollection(db)) {
  switch (action) {
    case 'save': return saveGame(db, session, body, snapshot);
    case 'delete': return deleteGame(db, session, body, snapshot);
    case 'migrate':
    case 'replace': {
      const inserted = await insertGames(db, session, await importRows(body.games), action);
      return { inserted, ...await snapshot() };
    }
    case 'collection-upload-start': return uploadStart(db, session, 'collection', body);
    case 'collection-upload-chunk': return uploadAppend(db, session, 'collection', body);
    case 'collection-upload-group': {
      if (!Array.isArray(body.games) || body.games.length < 1 || body.games.length > 128
        || !Number.isSafeInteger(body.offset) || body.offset < 0) fail(422, 'invalid_game_collection');
      const games = await importRows(body.games, body.offset);
      return uploadRowGroup(db, session, body.uploadId, body.offset, games.length,
        JSON.stringify(games.map(game => columns.map(key => game[key]))));
    }
    case 'collection-upload-cancel': return uploadCancel(db, session, 'collection', body.uploadId);
    case 'collection-upload-finish': {
      const state = await uploadState(db, session, 'collection', body.uploadId);
      if (state.state === 'done') return { inserted: state.inserted, ...await snapshot() };
      let inserted;
      try {
        if (isRowUpload(state.mode)) inserted = await finishRowUpload(db, session, state);
        else {
          const bytes = await collectionBytes(db, state);
          const games = await importRows(parseJson(bytes, 'invalid_game_collection', Array.isArray, 422));
          inserted = await insertGames(db, session, games, state.mode, state.id);
        }
      } catch (error) {
        const latest = await uploadState(db, session, 'collection', body.uploadId).catch(() => null);
        if (latest?.state === 'done') inserted = latest.inserted;
        else {
          if (error.status === 422 || error.id === 'collection_import_conflict') {
            await uploadCancel(db, session, 'collection', state.id);
          }
          throw error;
        }
      }
      return { inserted, ...await snapshot() };
    }
    default: return fail(400, 'unknown_action');
  }
}
