import { messages } from './messages.mjs';

export const encoder = new TextEncoder();
export const now = () => Math.floor(Date.now() / 1000);
export const randomId = (bytes = 16) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
export const sha256 = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
export const sql = (db, query, ...values) => db.prepare(query).bind(...values);
export const rows = async statement => (await statement.all()).results;
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const textLength = value => [...value].length;
export const validText = (value, limit) => typeof value === 'string' && value.length > 0
  && textLength(value) <= limit && !/[\x00-\x1f\x7f]/u.test(value) && value.isWellFormed();
export const isGameId = id => typeof id === 'string' && /^[a-z0-9-]{1,36}$/i.test(id);
export const isRevision = revision => typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision);

export class ApiError extends Error {
  constructor(status, id, extra = {}, retry = 0) {
    super(id);
    this.status = status;
    this.id = id;
    this.extra = extra;
    this.retry = retry;
  }
}
export function fail(status, id, extra, retry) {
  throw new ApiError(status, id, extra, retry);
}
export const failedCheck = error => String(error?.message).includes('savepoint_transaction_check');
export function check(db, condition, ...values) {
  return sql(db, `INSERT INTO transaction_checks(failure) SELECT 'failed' WHERE NOT (${condition})`, ...values);
}

export const securityHeaders = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https://challenges.cloudflare.com; upgrade-insecure-requests",
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
};

export function language(request) {
  const preferred = (request.headers.get('Accept-Language') ?? '').split(',')[0].trim().toLowerCase();
  return { preferred, lang: /^en(?:-[a-z0-9]{1,8})*$/.test(preferred) ? 'en' : 'pl' };
}

export function json(request, status, payload, extraHeaders = {}) {
  const { preferred, lang } = language(request);
  const data = { ...payload };
  if (typeof data.error === 'string') {
    const id = data.error;
    const translated = Object.hasOwn(messages, id) ? messages[id] : messages.server_error;
    if (id.startsWith('collection_')) data.code = id;
    data.error = translated[lang];
    if (lang === 'en') data.errorDefault = translated.pl;
    else if (preferred === 'pl') data.errorEnglish = translated.en;
  }
  return Response.json(data, {
    status,
    headers: { ...securityHeaders, 'Content-Language': lang, ...extraHeaders },
  });
}

export async function readBounded(stream, limit) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        fail(413, 'request_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function parseJson(bytes, id, accept, status = 400) {
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!accept(result)) fail(status, id);
    const visit = (value, depth = 1) => {
      if (typeof value === 'string' && !value.isWellFormed()) fail(status, id);
      if (value && typeof value === 'object') {
        if (depth >= 32) fail(status, id);
        for (const [key, item] of Object.entries(value)) {
          if (!key.isWellFormed()) fail(status, id);
          visit(item, depth + 1);
        }
      }
    };
    visit(result);
    return result;
  } catch {
    fail(status, id);
  }
}

export function canonicalBase64(data, limit) {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(limit / 3)) return null;
  try {
    const binary = atob(data);
    return binary.length && binary.length <= limit && btoa(binary) === data ? binary : null;
  } catch {
    return null;
  }
}
