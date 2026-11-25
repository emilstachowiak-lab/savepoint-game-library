import { fail, isGameId, now, randomId, readBounded, rows, securityHeaders, sha256, sql } from './http.mjs';
import { findGame, publicGame } from './collection.mjs';
import { imageInfo } from './images.mjs';

const maxImage = 5242880;
const maxStore = 536870912;
const kinds = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
export const coverKey = async url => `covers/${await sha256(url)}.img`;
const ready = value => value && value.size > 0 && value.size <= maxImage && kinds.includes(value.httpMetadata?.contentType);

function target(value, local) {
  if (value.length > 4096 || /[^\x21-\x7e]|\\/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname;
  if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
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
      return null;
    }
    const result = JSON.parse(new TextDecoder().decode(await readBounded(response.body, 32000)));
    if (result.Status !== 0 || result.TC) return null;
    return (result.Answer ?? []).filter(answer => answer.type === (type === 'A' ? 1 : 28)).map(answer => answer.data);
  }));
  const [ipv4, ipv6] = replies;
  return ipv4?.length && ipv6 && ipv4.every(publicIPv4) && ipv6.every(address =>
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
      url = target(new URL(location, url).href, local);
      if (!url || url.protocol !== 'https:') return null;
      continue;
    }
    if (!response.ok || Number(response.headers.get('Content-Length')) > maxImage) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await readBounded(response.body, maxImage);
    const info = imageInfo(bytes);
    if (!info || info.width > 8192 || info.height > 8192 || info.width * info.height > 40000000) return null;
    return { bytes, type: info.type };
  }
  return null;
}

async function savedUrl(db, id) {
  if (!isGameId(id)) fail(404, 'cover_not_found');
  const row = await findGame(db, id);
  if (!row?.cover_url) fail(404, 'cover_not_found');
  return row.cover_url;
}

export async function serveCover(db, bucket, id) {
  const url = await savedUrl(db, id);
  const item = await bucket.get(await coverKey(url));
  if (!ready(item)) {
    await item?.body.cancel();
    fail(404, 'cover_backup_unavailable');
  }
  return new Response(item.body, { headers: {
    ...securityHeaders, 'Content-Type': item.httpMetadata.contentType, 'Content-Length': String(item.size),
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
    if (!cache.has(coverUrl)) cache.set(coverUrl, Boolean(coverUrl && ready(await bucket.head(await coverKey(coverUrl)))));
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
  if (ready(await bucket.head(key))) return { backup: { status: 'cached' } };
  if (!target(url, local)) return { backup: { status: 'unavailable' } };
  const token = randomId();
  const time = now();
  const result = await db.batch([
    sql(db, 'DELETE FROM cover_claims WHERE expires <= ?', time),
    sql(db, 'SELECT token FROM cover_claims WHERE key = ?', key),
    sql(db, "INSERT INTO cover_claims(key, token, expires) VALUES ('active', ?, ?) ON CONFLICT(key) DO NOTHING", token, time + 60),
  ]);
  const locked = Boolean(result[2].meta.changes);
  try {
    if (result[1].results.length) return { backup: { status: 'unavailable' } };
    if (!locked) return { backup: { status: 'busy' } };
    if (ready(await bucket.head(key))) return { backup: { status: 'cached' } };
    let image;
    try { image = await download(url, local); } catch { /* Transient download failure. */ }
    if (!image) {
      await sql(db, "INSERT INTO cover_claims(key, token, expires) VALUES (?, 'retry', ?) ON CONFLICT(key) DO NOTHING",
        key, time + 21600).run();
      return { backup: { status: 'unavailable' } };
    }
    if (!await hasSpace(db, bucket, image.bytes.length)) return { backup: { status: 'quota' } };
    await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.type } });
    return { backup: { status: 'saved' } };
  } finally {
    if (locked) await sql(db, "DELETE FROM cover_claims WHERE key = 'active' AND token = ?", token).run();
  }
}
