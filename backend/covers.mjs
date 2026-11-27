import { ApiError, fail, isGameId, isRevision, now, randomId, readBounded, rows, securityHeaders, sha256, sql } from './http.mjs';
import { findGame, publicGame } from './collection.mjs';
import { MAX_COVER_BYTES, validatedCoverInfo } from './images.mjs';

const maxStore = 536870912;
const kinds = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
const validationVersion = '1';
const temporaryRetrySeconds = 30;
const permanentRetrySeconds = 21600;
export const coverKey = async url => `covers/${await sha256(url)}.img`;
const verified = item => item && item.size > 0 && item.size <= MAX_COVER_BYTES
  && item.customMetadata?.savepointValidation === validationVersion && kinds.includes(item.httpMetadata?.contentType);

class RetryCover extends Error {
  constructor(seconds = temporaryRetrySeconds) {
    super('Temporary cover download failure');
    this.seconds = seconds;
  }
}

function retrySeconds(response) {
  const hint = response.headers.get('Retry-After')?.trim();
  if (!hint) return temporaryRetrySeconds;
  const seconds = /^\d+$/.test(hint) ? Number(hint) : (Date.parse(hint) - Date.now()) / 1000;
  return Number.isNaN(seconds) ? temporaryRetrySeconds : Math.min(86400, Math.max(5, Math.ceil(seconds)));
}

const temporaryResponse = status => status === 408 || status === 425 || status === 429 || status >= 500;

function target(value, local) {
  if (/[\s\x00-\x1f\x7f\\]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname;
  if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password
    || value.split(/[/?#]/)[2]?.includes('@')
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host)
    || /\.(?:localhost|local|internal|onion|test|invalid|example)$/.test(host)
    || [local, 'emilstachowiak.helioho.st'].includes(host)) return null;
  url.hash = '';
  return url;
}

function publicIPv4(ip) {
  const fields = String(ip).split('.');
  if (fields.length !== 4 || fields.some(field => !/^\d{1,3}$/.test(field) || Number(field) > 255)) return false;
  const [a,b,c,d] = fields.map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 100 && b >= 64 && b <= 127 || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || (b === 0 && [0,2].includes(c)) || b === 88 && c === 99)
    || a === 198 && ([18,19].includes(b) || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113 || a === 64 && b === 62 && c === 151 && d === 106);
}

async function publicHost(hostname, signal) {
  const replies = await Promise.all(['A', 'AAAA'].map(async type => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.search = new URLSearchParams({ name: hostname, type });
    const response = await fetch(url, { signal, redirect: 'manual', headers: { Accept: 'application/dns-json' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RetryCover(retrySeconds(response));
    }
    const result = JSON.parse(new TextDecoder().decode(await readBounded(response.body, 32000)));
    if (result.TC || ![0, 3].includes(result.Status)) throw new RetryCover();
    if (result.Status === 3) return null;
    return (result.Answer ?? []).filter(answer => answer.type === (type === 'A' ? 1 : 28)).map(answer => answer.data);
  }));
  const [ipv4, ipv6] = replies;
  return ipv4 && ipv6 && ipv4.length + ipv6.length > 0 && ipv4.every(publicIPv4) && ipv6.every(address =>
    typeof address === 'string' && /^[23][0-9a-f]{3}:[\da-f:]+$/i.test(address) && !/^2001:(?:db8|0000|0):/i.test(address)
    && !/^2002:/i.test(address));
}

async function download(value, local) {
  let url = target(value, local);
  if (!url) return null;
  url.protocol = 'https:';
  const signal = AbortSignal.timeout(8000);
  for (let hop = 0; hop <= 3; hop++) {
    if (!await publicHost(url.hostname, signal)) return null;
    const response = await fetch(url, {
      redirect: 'manual', signal,
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (!location || location.startsWith('#')) return null;
      let redirected;
      try { redirected = new URL(location, url); } catch { return null; }
      url = target(redirected.href, local);
      if (!url || url.protocol !== 'https:') return null;
      continue;
    }
    if (!response.ok || Number(response.headers.get('Content-Length')) > MAX_COVER_BYTES) {
      await response.body?.cancel();
      if (temporaryResponse(response.status)) throw new RetryCover(retrySeconds(response));
      return null;
    }
    const bytes = await readBounded(response.body, MAX_COVER_BYTES);
    const info = validatedCoverInfo(bytes);
    return info && { bytes, type: info.type };
  }
  return null;
}

async function savedUrl(db, id, revision) {
  if (!isGameId(id)) fail(404, 'cover_not_found');
  const row = await findGame(db, id);
  if (!row?.cover_url || revision !== undefined && (!isRevision(revision) || row.revision !== revision)) {
    fail(404, 'cover_not_found');
  }
  return row.cover_url;
}

async function legacyCover(item) {
  if (!item?.body || item.size < 1 || item.size > MAX_COVER_BYTES) {
    await item?.body?.cancel();
    return null;
  }
  let bytes;
  try { bytes = await readBounded(item.body, MAX_COVER_BYTES); }
  catch (error) {
    if (error instanceof ApiError && error.status === 413) return null;
    throw error;
  }
  if (bytes.length !== item.size) return null;
  const info = validatedCoverInfo(bytes);
  return info && { bytes, type: info.type };
}

function saveVerifiedCover(bucket, key, image, previous) {
  return bucket.put(key, image.bytes, {
    httpMetadata: { contentType: image.type },
    customMetadata: { ...previous?.customMetadata, savepointValidation: validationVersion },
    ...(previous?.etag ? { onlyIf: { etagMatches: previous.etag } } : {}),
  });
}

export async function serveCover(db, bucket, id, { revision, waitUntil } = {}) {
  const key = await coverKey(await savedUrl(db, id, revision));
  const item = await bucket.get(key);
  let body, size, type;
  if (verified(item)) {
    body = item.body;
    size = item.size;
    type = item.httpMetadata.contentType;
  } else {
    const image = await legacyCover(item);
    if (!image) fail(404, 'cover_backup_unavailable');
    body = image.bytes;
    size = image.bytes.length;
    type = image.type;
    if (waitUntil && item.etag) {
      // Keep valid pre-existing copies, including those whose originals have disappeared.
      waitUntil(saveVerifiedCover(bucket, key, image, item).catch(() => {}));
    }
  }
  return new Response(body, { headers: {
    ...securityHeaders, 'Content-Type': type, 'Content-Length': String(size),
    'Content-Disposition': 'inline; filename="cover"', 'Cross-Origin-Resource-Policy': 'same-origin',
  } });
}

export async function coverStatuses(db, bucket, ids) {
  if (!Array.isArray(ids) || ids.length > 32 || !ids.every(isGameId)) fail(400, 'invalid_cover_list');
  if (!ids.length) return { backups: [] };
  const games = await rows(sql(db, `SELECT * FROM games WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids));
  const cache = new Map();
  const backups = [];
  for (const game of games) {
    const { id, coverUrl } = publicGame(game);
    if (!cache.has(coverUrl)) cache.set(coverUrl, Boolean(coverUrl && verified(await bucket.head(await coverKey(coverUrl)))));
    backups.push({ id, coverUrl, ready: cache.get(coverUrl) });
  }
  return { backups };
}

async function hasSpace(db, bucket, newSize) {
  let usage = 0;
  const reclaimable = [];
  let page;
  do {
    page = await bucket.list({ prefix: 'covers/', limit: 1000, ...(page?.cursor ? { cursor: page.cursor } : {}) });
    for (const item of page.objects) {
      usage += item.size;
      if (item.uploaded.getTime() < Date.now() - 90 * 86400000) reclaimable.push(item);
    }
  } while (page.truncated);
  if (usage + newSize <= maxStore) return true;
  const active = new Set();
  for (const item of await rows(db.prepare("SELECT DISTINCT cover_url FROM games WHERE cover_url <> ''"))) {
    active.add(await coverKey(item.cover_url));
  }
  for (const item of reclaimable) {
    if (active.has(item.key)) continue;
    await bucket.delete(item.key);
    usage -= item.size;
    if (usage + newSize <= maxStore) return true;
  }
  return false;
}

export async function backupCover(db, bucket, id, local) {
  const url = await savedUrl(db, id);
  const key = await coverKey(url);
  if (verified(await bucket.head(key))) return { backup: { status: 'cached' } };
  const token = randomId();
  const time = now();
  const result = await db.batch([
    sql(db, 'DELETE FROM cover_claims WHERE expires <= ?', time),
    sql(db, "SELECT token, expires FROM cover_claims WHERE key = ? AND token IN ('temporary', 'unavailable')", key),
    sql(db, "INSERT INTO cover_claims(key, token, expires) VALUES ('active', ?, ?) ON CONFLICT(key) DO NOTHING", token, time + 60),
  ]);
  const locked = Boolean(result[2].meta.changes);
  try {
    const claim = result[1].results[0];
    if (claim?.token === 'temporary') return { backup: { status: 'retry', retryAfter: Math.max(1, claim.expires - time) } };
    if (claim) return { backup: { status: 'unavailable' } };
    if (!locked) return { backup: { status: 'busy' } };
    const previous = await bucket.get(key);
    if (verified(previous)) {
      await previous.body.cancel();
      return { backup: { status: 'cached' } };
    }
    const existing = await legacyCover(previous);
    if (existing) {
      await saveVerifiedCover(bucket, key, existing, previous);
      return { backup: { status: 'cached' } };
    }
    if (!target(url, local)) return { backup: { status: 'unavailable' } };
    let image;
    let retryAfter = 0;
    try { image = await download(url, local); }
    catch (error) {
      if (error instanceof RetryCover) retryAfter = error.seconds;
      else if (!(error instanceof ApiError && error.status === 413)) retryAfter = temporaryRetrySeconds;
    }
    if (!image) {
      await sql(db, `INSERT INTO cover_claims(key, token, expires) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET token = excluded.token, expires = excluded.expires`,
      key, retryAfter ? 'temporary' : 'unavailable', now() + (retryAfter || permanentRetrySeconds)).run();
      return { backup: retryAfter ? { status: 'retry', retryAfter } : { status: 'unavailable' } };
    }
    const increase = image.bytes.length - (previous?.size ?? 0);
    if (increase > 0 && !await hasSpace(db, bucket, increase)) return { backup: { status: 'quota' } };
    if (!await saveVerifiedCover(bucket, key, image, previous)) return { backup: { status: 'busy' } };
    return { backup: { status: 'saved' } };
  } finally {
    if (locked) await sql(db, "DELETE FROM cover_claims WHERE key = 'active' AND token = ?", token).run();
  }
}
