import { check, encoder, fail, failedCheck, isGameId, isRevision, now, rows, sha256, sql } from './http.mjs';
import { sessionGuard } from './auth.mjs';
import { findGame, listGames, normalizePlatform, publicGame } from './collection.mjs';
import { createCandidateScan } from '../public/duplicate-candidates.mjs';
import { chooseDuplicates } from './gemini.mjs';

const editions = ['Fizyczne', 'Cyfrowe', 'Fizyczne i cyfrowe'];
const stale = () => fail(409, 'ai_duplicates_stale');
const invalid = () => fail(422, 'ai_duplicates_invalid');
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/g, '').replaceAll('+', '-').replaceAll('/', '_');
const fromBase64url = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0));
const secret = session => crypto.subtle.importKey('raw', encoder.encode(session.token), { name: 'HMAC', hash: 'SHA-256' },
  false, ['sign', 'verify']);

async function sign(key, payload) {
  const text = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return text + '.' + base64url(signature);
}

async function verify(key, token) {
  if (typeof token !== 'string' || token.length > 750 || !/^[\w-]+\.[\w-]{43}$/.test(token)) return null;
  try {
    const [text, signature] = token.split('.');
    if (!await crypto.subtle.verify('HMAC', key, fromBase64url(signature), encoder.encode(text))) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64url(text)));
  } catch { return null; }
}

const fingerprint = games => sha256(JSON.stringify(games.map(game => [game.id, game.revision])
  .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

const platformList = game => game.platform.split(',').map(part => part.trim()).filter(Boolean);
function sameDetails(a, b, coversMatch) {
  return coversMatch && ['title', 'edition', 'status'].every(key => a[key] === b[key])
    && JSON.stringify([...new Set(platformList(a))].sort()) === JSON.stringify([...new Set(platformList(b))].sort());
}

const maxPairs = 32;
const fields = ['id', 'title', 'platform', 'edition', 'status', 'created_at', 'revision'];
const selectPairFields = ['a', 'b'].flatMap(side => fields.map(field => `${side}.${field} AS ${side}_${field}`)).join(', ');
const reference = game => [game.id, game.revision];

function pairGame(row, side, legacy) {
  const game = Object.fromEntries(fields.map(field => [field === 'created_at' ? 'createdAt' : field, row[side + '_' + field]]));
  game.hasCover = row[side + '_has_cover'] === 1;
  if (legacy) game.coverUrl = row[side + '_cover_url'];
  return game;
}

async function matchPairs(db, proposed, legacy) {
  if (!Array.isArray(proposed) || proposed.length > maxPairs) fail(422, 'ai_duplicates_invalid_scan');
  const seen = new Set();
  for (const pair of proposed) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(ref => !Array.isArray(ref)
      || ref.length !== 2 || !isGameId(ref[0]) || !isRevision(ref[1]))) fail(422, 'ai_duplicates_invalid_scan');
    const ids = pair.map(ref => ref[0].toLowerCase()).sort();
    const joined = ids.join(':');
    if (ids[0] === ids[1] || seen.has(joined)) fail(422, 'ai_duplicates_invalid_scan');
    seen.add(joined);
  }
  if (!proposed.length) return [];

  // Join one small list of references in D1. Check revisions and compare
  // covers there, without loading the entire collection or its cover URLs.
  const matches = await rows(sql(db, `SELECT ${selectPairFields},
    a.cover_url <> '' AS a_has_cover, b.cover_url <> '' AS b_has_cover, a.cover_url = b.cover_url AS covers_match
    ${legacy ? ', a.cover_url AS a_cover_url, b.cover_url AS b_cover_url' : ''}
    FROM json_each(?) pair
    JOIN games a ON a.id = json_extract(pair.value, '$[0][0]') AND a.id COLLATE BINARY = json_extract(pair.value, '$[0][0]')
      AND a.revision = json_extract(pair.value, '$[0][1]')
    JOIN games b ON b.id = json_extract(pair.value, '$[1][0]') AND b.id COLLATE BINARY = json_extract(pair.value, '$[1][0]')
      AND b.revision = json_extract(pair.value, '$[1][1]')
    ORDER BY pair.key`, JSON.stringify(proposed)));
  if (matches.length !== proposed.length) fail(409, 'ai_duplicates_scan_changed');
  return matches.map(row => ({ left: pairGame(row, 'a', legacy), right: pairGame(row, 'b', legacy),
    coversMatch: row.covers_match === 1 }));
}

async function legacyPage(db, key, body) {
  // Older open tabs used this endpoint to find candidates themselves. Give
  // small collections a bounded fallback and ask larger ones to refresh.
  const games = await rows(sql(db, 'SELECT id, title, revision FROM games ORDER BY id LIMIT 41'));
  if (games.length > 40) fail(409, 'ai_duplicates_refresh_required');
  const snapshot = await fingerprint(games);
  let position = null;
  if (body.cursor != null) {
    const cursor = await verify(key, body.cursor);
    if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== 'cursor-v2'
      || cursor[1] <= now() || cursor[2] !== snapshot || !Array.isArray(cursor[3])) {
      fail(409, 'ai_duplicates_scan_changed');
    }
    position = cursor[3];
  }
  const { pairs, next } = createCandidateScan(games, maxPairs)(position);
  return { proposed: pairs.map(pair => pair.map(reference)),
    cursor: next ? await sign(key, ['cursor-v2', now() + 86400, snapshot, next]) : null };
}

export async function scanDuplicates(db, env, session, body) {
  const key = await secret(session);
  const legacy = !Object.hasOwn(body, 'pairs');
  const { proposed, cursor } = legacy ? await legacyPage(db, key, body) : { proposed: body.pairs, cursor: null };
  const pairs = await matchPairs(db, proposed, legacy);
  const options = pairs.map(({ left, right }, index) => ({ index,
    left: { title: left.title, platform: left.platform }, right: { title: right.title, platform: right.platform } }));
  const accepted = new Set(options.length ? await chooseDuplicates(db, env, options) : []);
  const review = await Promise.all(pairs.map(async ({ left, right, coversMatch }, index) => {
    if (!accepted.has(index)) return null;
    return { left, right, coversMatch, recommendation: sameDetails(left, right, coversMatch) ? 'delete' : 'merge',
      ticket: await sign(key, ['review', now() + 900, reference(left), reference(right)]) };
  }));
  return { pairs: review.filter(Boolean), limited: cursor !== null, cursor };
}

export async function applyDuplicate(db, session, body) {
  const { keepId, mode } = body;
  if (body.confirmed !== true || !isGameId(keepId) || !['merge', 'delete'].includes(mode)) invalid();
  const ticket = await verify(await secret(session), body.ticket);
  if (!Array.isArray(ticket) || ticket.length !== 4 || ticket[0] !== 'review') invalid();
  if (ticket[1] <= now()) stale();
  const contenders = ticket.slice(2);
  if (!contenders.every(pair => Array.isArray(pair) && isGameId(pair[0]) && isRevision(pair[1]))) invalid();
  const keep = contenders.find(([id]) => id === keepId);
  const remove = contenders.find(([id]) => id !== keepId);
  if (!keep || !remove) invalid();
  const [chosen, other] = await Promise.all([findGame(db, keepId), findGame(db, remove[0])]);
  if (!chosen || !other || chosen.revision !== keep[1] || other.revision !== remove[1]) stale();
  const commands = [
    sessionGuard(db, session),
    check(db, 'EXISTS(SELECT 1 FROM games WHERE id = ? AND revision = ?) AND EXISTS(SELECT 1 FROM games WHERE id = ? AND revision = ?)',
      ...keep, ...remove),
  ];
  if (mode === 'merge') {
    let platform;
    try {
      platform = normalizePlatform([...new Set([...platformList(chosen), ...platformList(other)])].join(','));
    } catch { fail(422, 'ai_duplicates_merge_too_large'); }
    const edition = chosen.edition !== other.edition && editions.includes(chosen.edition) && editions.includes(other.edition)
      ? editions[2] : chosen.edition;
    if (platform !== chosen.platform || edition !== chosen.edition) {
      commands.push(sql(db, 'UPDATE games SET platform = ?, edition = ?, revision = lower(hex(randomblob(32))) WHERE id = ?',
        platform, edition, keepId));
    }
  }
  commands.push(sql(db, 'DELETE FROM games WHERE id = ?', remove[0]), sql(db, 'SELECT * FROM games WHERE id = ?', keepId));
  try {
    const result = await db.batch(commands);
    return body.delta === true ? { game: publicGame(result.at(-1).results[0]), deletedId: remove[0] }
      : { games: await listGames(db) };
  } catch (error) {
    if (failedCheck(error)) {
      await sessionGuard(db, session).run();
      stale();
    }
    throw error;
  }
}
