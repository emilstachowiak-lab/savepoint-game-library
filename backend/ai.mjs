import { ApiError, encoder, fail, language, object, rows, sql, validText } from './http.mjs';
import { getSession } from './auth.mjs';
import { insertGames, listGames, normalizeGame, publicGame } from './collection.mjs';
import { admit, enabled, platforms, recognize } from './gemini.mjs';
import { suggestCovers } from './catalogues.mjs';
import { applyDuplicate, scanDuplicates } from './ai-duplicates.mjs';
import { imageInfo } from './images.mjs';
import { takePhoto, uploadAppend, uploadCancel, uploadStart } from './uploads.mjs';

export const aiActions = new Set(['ai-status', 'ai-upload-start', 'ai-upload-chunk', 'ai-upload-cancel', 'ai-recognize',
  'ai-add', 'ai-cover-search', 'ai-duplicates-scan', 'ai-duplicates-apply']);

async function sameSession(db, request, session) {
  const current = await getSession(db, request);
  if (!current || current.token !== session.token) fail(401, 'ai_session_expired');
}

async function coverSearch(db, env, body) {
  if (!validText(body.title, 255) || !body.title.trim() || !Array.isArray(body.platforms)
    || !body.platforms.length || body.platforms.length > 35 || new Set(body.platforms).size !== body.platforms.length
    || !body.platforms.every(platform => platform && platforms.includes(platform))) {
    fail(422, 'ai_invalid_cover_search');
  }
  await admit(db, env, 'manual-cover');
  const candidates = body.platforms.map(platform => ({ title: body.title.trim(), platform, confidence: 'high' }));
  const suggested = await suggestCovers(db, env, { candidates }, Date.now() + 24000, true);
  for (const source of ['igdb', 'steamgriddb', 'wikipedia']) {
    const match = suggested.candidates.find(game => game.coverSource === source);
    if (match) return { coverUrl: match.coverUrl, coverSource: source, coverSourceUrl: match.coverSourceUrl };
  }
  return { coverUrl: '', ...(suggested.coverSearch ? { coverSearch: suggested.coverSearch } : {}) };
}

const fields = ['title', 'platform', 'edition', 'status', 'coverUrl', 'id'];
async function addConfirmed(db, session, body) {
  if (body.confirmed !== true) fail(400, 'ai_confirmation_required');
  const invalid = () => fail(422, 'ai_invalid_batch');
  if (!Array.isArray(body.games) || !body.games.length || body.games.length > 32) invalid();
  const ids = new Set();
  const items = body.games.map(item => {
    if (!object(item) || Object.keys(item).length !== 7 || fields.some(key => typeof item[key] !== 'string'
      || /[\x00-\x1f\x7f]/.test(item[key]))
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.id)
      || !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0) invalid();
    const values = Object.fromEntries(fields.map(key => [key, item[key].trim()]));
    values.id = values.id.toLowerCase();
    if (ids.has(values.id) || !['Fizyczne', 'Cyfrowe', 'Fizyczne i cyfrowe'].includes(values.edition)
      || !['Do ogrania', 'W trakcie', 'Ograna'].includes(values.status)
      || values.coverUrl && (!/^https:\/\//i.test(values.coverUrl) || encoder.encode(values.coverUrl).length > 2048)) invalid();
    ids.add(values.id);
    try { return normalizeGame({ ...values, createdAt: item.createdAt }); }
    catch { return invalid(); }
  });
  const inserted = await insertGames(db, session, items, 'migrate', null, 'ai_batch_conflict');
  if (body.delta !== true) return { inserted, games: await listGames(db) };
  const games = await rows(sql(db, `SELECT * FROM games WHERE id IN (${items.map(() => '?').join(',')})`, ...ids));
  return { inserted, addedGames: games.map(publicGame) };
}

export async function aiAction(db, env, request, session, action, body) {
  const configured = enabled(env);
  if (action === 'ai-status') return { available: configured };
  if (action === 'ai-duplicates-apply') return applyDuplicate(db, session, body);
  if (!configured) fail(503, {
    'ai-cover-search': 'ai_cover_search_unavailable',
    'ai-duplicates-scan': 'ai_duplicates_not_configured',
  }[action] ?? 'ai_not_configured');
  if (action === 'ai-upload-start') return uploadStart(db, session, 'ai', body);
  if (action === 'ai-upload-chunk') return uploadAppend(db, session, 'ai', body);
  if (action === 'ai-upload-cancel') return uploadCancel(db, session, 'ai', body.uploadId);
  if (action === 'ai-add') return addConfirmed(db, session, body);
  if (action === 'ai-recognize') {
    const deadline = Date.now() + 32000;
    const photo = await takePhoto(db, session, body.uploadId);
    const info = imageInfo(photo);
    if (info?.type !== 'image/jpeg' || info.width > 1600 || info.height > 1600 || photo.at(-2) !== 255 || photo.at(-1) !== 217) {
      fail(422, 'ai_image_invalid');
    }
    const result = await recognize(db, env, photo, language(request).lang);
    await sameSession(db, request, session);
    await suggestCovers(db, env, result, deadline);
    await sameSession(db, request, session);
    return result;
  }
  try {
    const result = action === 'ai-cover-search' ? await coverSearch(db, env, body) : await scanDuplicates(db, env, session, body);
    await sameSession(db, request, session);
    return result;
  } catch (error) {
    if (error instanceof ApiError) {
      if (action === 'ai-duplicates-scan' && error.id === 'ai_response_invalid') fail(502, 'ai_duplicates_response_invalid');
      if (action === 'ai-duplicates-scan' && error.id === 'ai_refused') fail(422, 'ai_duplicates_refused');
      if (action === 'ai-cover-search' && ['ai_service_unavailable', 'ai_rate_limited'].includes(error.id)) {
        fail(error.status, error.id === 'ai_rate_limited' ? 'ai_cover_search_rate_limited' : 'ai_cover_search_unavailable',
          {}, error.retry);
      }
    }
    throw error;
  }
}
