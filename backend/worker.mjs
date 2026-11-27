import { ApiError, fail, failedCheck, json, object, parseJson, readBounded, securityHeaders } from './http.mjs';
import { challenge, getSession, login, logout, sessionMetadata, validateTransport } from './auth.mjs';
import { collectionAction, listGamePage, listGames } from './collection.mjs';
import { backupCover, coverStatuses, serveCover } from './covers.mjs';
import { aiAction, aiActions } from './ai.mjs';

const requestLimit = 65536;
const uploadGroupLimit = 196608;
const passiveActions = new Set(['backup-cover', 'backup-cover-status']);

async function postBody(request) {
  if ((request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'json_required');
  }
  const limit = request.headers.get('X-Savepoint-Upload-Format') === 'rows' ? uploadGroupLimit : requestLimit;
  if (Number(request.headers.get('Content-Length')) > limit) fail(413, 'request_too_large');
  const bytes = await readBounded(request.body, limit);
  const body = parseJson(bytes, 'invalid_request_data', object);
  if (bytes.byteLength > requestLimit && body.action !== 'collection-upload-group') fail(413, 'request_too_large');
  return body;
}

function protectedError(request, action, error) {
  const ai = aiActions.has(action);
  if (failedCheck(error)) error = new ApiError(401, ai ? 'ai_session_expired' : 'authentication_required', { authRequired: true });
  if (!(error instanceof ApiError)) {
    const databaseError = /\bD1_(?:ERROR|EXEC_ERROR|COLUMN_NOTFOUND)\b/i.test(String(error?.message));
    console.warn('Savepoint API operation failed.', { source: databaseError ? 'd1' : 'application', ...(ai ? { action } : {}) });
    const id = databaseError ? 'database_unavailable' : action === 'ai-cover-search' ? 'ai_cover_search_unavailable'
      : ai ? 'ai_service_unavailable' : 'server_error';
    error = new ApiError(ai || databaseError ? 503 : 500, id);
  }
  const extra = ai && (error.id.startsWith('ai_') || error.id === 'database_unavailable')
    ? { errorId: error.id, authRequired: error.status === 401, ...error.extra }
    : error.extra;
  return json(request, error.status, { ok: false, error: error.id, ...extra },
    error.retry ? { 'Retry-After': String(error.retry) } : {});
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (['/api', '/api/', '/api/index.php'].includes(url.pathname)) {
    return new Response('Dostęp zabroniony.', { status: 403,
      headers: { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (url.pathname !== '/api/games.php') {
    return new Response('Nie znaleziono.', { status: 404,
      headers: { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  let action = '';
  try {
    validateTransport(request, url, env);
    const { method } = request;
    if (method !== 'GET' && method !== 'POST') {
      return json(request, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    }
    const body = method === 'POST' ? await postBody(request) : {};
    action = typeof body.action === 'string' ? body.action : '';
    const cover = method === 'GET' && url.searchParams.has('cover');
    const passive = method === 'GET' && url.searchParams.has('session');
    const paged = request.headers.get('X-Savepoint-Collection') === 'paged';
    const after = url.searchParams.get('after');
    const version = url.searchParams.get('version');
    if (after !== null || version !== null) {
      if (!paged || method !== 'GET' || cover || passive || !after || !/^(?:0|[1-9]\d*)$/.test(version ?? '')
        || url.searchParams.getAll('after').length !== 1 || url.searchParams.getAll('version').length !== 1) {
        fail(400, 'collection_invalid_page');
      }
    }
    if (passive && (url.searchParams.get('session') !== '1' || url.searchParams.getAll('session').length !== 1 || cover)) {
      fail(400, 'invalid_session_request');
    }
    const db = env.DB;
    if (!db) fail(503, 'configuration_incomplete');
    const snapshot = () => paged ? listGamePage(db, after ?? '', version === null ? null : Number(version))
      : listGames(db).then(games => ({ games }));
    if (action === 'logout') {
      const cookie = await logout(db, request);
      return json(request, 200, { ok: true }, { 'Set-Cookie': cookie });
    }
    const ai = aiActions.has(action);
    const touch = !cover && !passive && !passiveActions.has(action)
      && (!ai || ['ai-add', 'ai-duplicates-apply'].includes(action));
    const session = await getSession(db, request, { touch, passive });
    if (action === 'login') {
      const result = await login({ db, request, url, env, context, body, listGames: snapshot, previous: session });
      return json(request, 200, { ok: true, ...result.games, session: sessionMetadata(result.session) },
        { 'Set-Cookie': result.cookie });
    }
    if (!session) {
      if (ai) fail(401, 'ai_session_expired', { authRequired: true });
      fail(401, 'authentication_required', { authRequired: true, ...(cover || passive ? {} : { captcha: challenge(env, url) }) });
    }
    const bucket = env.COVERS;
    if ((cover || passiveActions.has(action)) && !bucket) fail(503, 'configuration_incomplete');
    if (cover) {
      const id = url.searchParams.getAll('cover').length === 1 ? url.searchParams.get('cover') : null;
      const versions = url.searchParams.getAll('v');
      const revision = versions.length > 1 ? null : versions[0];
      return await serveCover(db, bucket, id, { revision, waitUntil: promise => context.waitUntil(promise) });
    }
    let result;
    if (passive) result = {};
    else if (method === 'GET') result = await snapshot();
    else if (action === 'backup-cover') result = await backupCover(db, bucket, body.id, url.hostname);
    else if (action === 'backup-cover-status') result = await coverStatuses(db, bucket, body.ids);
    else if (ai) result = await aiAction(db, env, request, session, action, body);
    else result = await collectionAction(db, session, action, body, snapshot);
    return json(request, 200, { ok: true, ...result, session: sessionMetadata(session) });
  } catch (error) {
    return protectedError(request, action, error);
  }
}
