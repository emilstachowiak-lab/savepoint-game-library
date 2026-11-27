import { check, encoder, fail, failedCheck, hex, now, randomId, sha256, sql, validText } from './http.mjs';
import { notifyLogin } from './login-notification.mjs';

const cookieName = 'savepoint_cf_session_v1';
const idleSeconds = 1800;
const maxSeconds = 28800;
const localhost = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const testSecret = '1x0000000000000000000000000000000AA';
const testSite = '1x00000000000000000000AA';
const secureAttributes = 'Path=/; HttpOnly; SameSite=Strict; Secure';

export function validateTransport(request, url, env) {
  const local = env.LOCAL_DEVELOPMENT === '1' && localhost(url.hostname);
  if (url.protocol !== 'https:' && !local) fail(426, 'https_required');
  if (env.APP_ORIGIN && url.origin !== env.APP_ORIGIN) fail(403, 'origin_not_allowed');
  if (request.method !== 'POST') return;
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  let allowed = origin === url.origin;
  if (!origin && referer) {
    try {
      const parsed = new URL(referer);
      allowed = !parsed.username && !parsed.password && parsed.origin === url.origin;
    } catch { /* Invalid Referer. */ }
  }
  if (!allowed) fail(403, 'origin_not_allowed');
}

export function captchaConfig(env, url) {
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) fail(503, 'captcha_configuration_incomplete');
  const dummy = /^(?:[123]x0{15,})/.test(env.TURNSTILE_SITE_KEY)
    || /^(?:[123]x0{15,})/.test(env.TURNSTILE_SECRET_KEY);
  if (dummy && !(env.LOCAL_DEVELOPMENT === '1' && localhost(url.hostname)
    && env.TURNSTILE_SECRET_KEY === testSecret && env.TURNSTILE_SITE_KEY === testSite)) {
    fail(503, 'captcha_configuration_incomplete');
  }
  return { provider: 'turnstile', siteKey: env.TURNSTILE_SITE_KEY };
}

async function sessionToken(request) {
  const values = (request.headers.get('Cookie') ?? '').split(';')
    .map(entry => entry.trim()).filter(entry => entry.startsWith(cookieName + '='));
  const value = values.length === 1 ? values[0].slice(cookieName.length + 1) : '';
  return /^[a-f0-9]{64}$/.test(value) ? sha256(value) : null;
}

const alive = 'token = ? AND activity_at > ? AND authenticated_at > ?';
export function sessionGuard(db, session) {
  const time = now();
  return check(db, `EXISTS(SELECT 1 FROM sessions WHERE ${alive})`,
    session.token, time - idleSeconds, time - maxSeconds);
}

export async function getSession(db, request, { touch = false, passive = false } = {}) {
  const token = await sessionToken(request);
  if (!token) return null;
  const time = now();
  const command = touch
    ? sql(db, `UPDATE sessions SET activity_at = max(activity_at, ?) WHERE ${alive}
        RETURNING token, authenticated_at, activity_at`, time, token, time - idleSeconds, time - maxSeconds)
    : sql(db, `SELECT token, authenticated_at, activity_at FROM sessions WHERE ${alive}`,
      token, time - idleSeconds, time - maxSeconds);
  const session = await command.first();
  if (passive && session) {
    const rate = await reserve(db, 'session:' + token, time, 31, 60, 60, 60);
    if (!rate.accepted) fail(429, 'session_checks_rate_limited', {}, rate.retry);
  }
  return session;
}

export function sessionMetadata(session) {
  return {
    authenticatedAt: session.authenticated_at,
    lastActivityAt: session.activity_at,
    idleExpiresAt: session.activity_at + idleSeconds,
    absoluteExpiresAt: session.authenticated_at + maxSeconds,
    serverNow: now(),
  };
}

export async function logout(db, request) {
  const token = await sessionToken(request);
  if (token) {
    await db.batch([
      sql(db, 'DELETE FROM uploads WHERE owner = ?', token),
      sql(db, 'DELETE FROM sessions WHERE token = ?', token),
    ]);
  }
  return `${cookieName}=; ${secureAttributes}; Max-Age=0`;
}

function clientIp(request) {
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  return /^[0-9a-f:.]{3,45}$/i.test(ip) ? ip : 'unknown';
}

function reservation(db, bucket, time, threshold, window, delay, maxDelay) {
  return sql(db, `INSERT INTO rate_limits(bucket, started_at, attempts, blocked_until)
      VALUES (?1, ?2, 1, CASE WHEN ?3 = 1 THEN ?2 + ?5 ELSE 0 END)
    ON CONFLICT(bucket) DO UPDATE SET
      started_at = CASE WHEN started_at <= ?2 - ?4 THEN ?2 ELSE started_at END,
      attempts = CASE WHEN started_at <= ?2 - ?4 THEN 1 ELSE attempts + 1 END,
      blocked_until = CASE
        WHEN started_at <= ?2 - ?4 OR attempts + 1 < ?3 THEN 0
        ELSE ?2 + min(?6, ?5 * (1 << min(16, attempts + 1 - ?3))) END
    WHERE blocked_until <= ?2
    RETURNING blocked_until`, bucket, time, threshold, window, delay, maxDelay);
}

async function reserve(db, bucket, time, threshold, window, delay, maxDelay) {
  const row = await reservation(db, bucket, time, threshold, window, delay, maxDelay).first();
  if (row) return { accepted: true, retry: Math.max(0, row.blocked_until - time) };
  return { accepted: false, retry: await retryFor(db, bucket, time) || 1 };
}

async function retryFor(db, bucket, time) {
  const row = await sql(db, 'SELECT blocked_until FROM rate_limits WHERE bucket = ?', bucket).first();
  return Math.max(0, (row?.blocked_until ?? 0) - time);
}

async function verifyCaptcha(env, url, body) {
  const token = body.captcha?.token;
  if (typeof body.website === 'string' && body.website.trim()) return false;
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) {
      await result.body?.cancel();
      return null;
    }
    const data = await result.json();
    if (data.success === true) {
      return data.hostname === url.hostname && data.action === 'login'
        || env.TURNSTILE_SECRET_KEY === testSecret && localhost(url.hostname)
          && env.LOCAL_DEVELOPMENT === '1' && data.hostname === 'example.com';
    }
    if (data.success !== false || !data['error-codes']?.length) return null;
    const rejected = ['invalid-input-response', 'missing-input-response', 'timeout-or-duplicate'];
    return data['error-codes'].every(code => rejected.includes(code)) ? false : null;
  } catch {
    return null;
  }
}

function accountConfig(env) {
  if (!validText(env.APP_USERNAME, 128) || encoder.encode(env.APP_USERNAME).length > 128
    || !/^(?:[a-f0-9]{2}){16,64}$/.test(env.APP_PASSWORD_SALT ?? '')
    || !/^[a-f0-9]{64}$/.test(env.APP_PASSWORD_HASH ?? '')) {
    fail(503, 'invalid_app_account_configuration');
  }
}

export async function passwordHash(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g), pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}

function equal(a, b) {
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) mismatch |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function challenge(env, url) {
  const captcha = captchaConfig(env, url);
  accountConfig(env);
  return captcha;
}

export async function login({ db, request, url, env, context, body, listGames, previous }) {
  const captcha = challenge(env, url);
  const time = now();
  const ip = clientIp(request);
  const [ipKey, accountKey] = await Promise.all([
    sha256(`${env.APP_PASSWORD_HASH}:ip:${ip}`),
    sha256(`${env.APP_PASSWORD_HASH}:account:${env.APP_USERNAME.toLowerCase()}`),
  ]);
  const [requestKey, captchaKey, failureKey, userKey] =
    ['login:', 'captcha:', 'ip:', 'account:'].map((prefix, index) => prefix + (index === 3 ? accountKey : ipKey));
  const retries = await Promise.all([captchaKey, failureKey, userKey].map(key => retryFor(db, key, time)));
  if (retries[0]) fail(429, 'failed_verifications_rate_limited', { captcha }, retries[0]);
  if (retries[1] || retries[2]) fail(429, 'failed_logins_rate_limited', { captcha }, Math.max(...retries));
  const requestRate = await reserve(db, requestKey, time, 10, 60, 60, 300);
  if (!requestRate.accepted || requestRate.retry) {
    fail(429, 'login_requests_rate_limited', { captcha }, requestRate.retry);
  }

  const verified = await verifyCaptcha(env, url, body);
  if (verified === null) fail(503, 'captcha_unavailable', { captcha });
  if (!verified) {
    const result = await reserve(db, captchaKey, now(), 5, 900, 60, 3600);
    if (!result.accepted || result.retry) fail(429, 'failed_verifications_rate_limited', { captcha }, result.retry);
    fail(422, 'captcha_verification_failed', { captcha });
  }
  const passwordTime = now();
  let retry;
  try {
    const limits = await db.batch([
      check(db, 'NOT EXISTS(SELECT 1 FROM rate_limits WHERE bucket IN (?, ?) AND blocked_until > ?)',
        userKey, failureKey, passwordTime),
      sql(db, 'DELETE FROM rate_limits WHERE bucket = ?', captchaKey),
      reservation(db, userKey, passwordTime, 10, 900, 2, 30),
      reservation(db, failureKey, passwordTime, 5, 900, 60, 3600),
    ]);
    retry = Math.max(0, ...limits.slice(2).map(result => result.results[0].blocked_until - passwordTime));
  } catch (error) {
    if (!failedCheck(error)) throw error;
    const retries = await Promise.all([userKey, failureKey].map(key => retryFor(db, key, passwordTime)));
    fail(429, 'failed_logins_rate_limited', { captcha }, Math.max(1, ...retries));
  }

  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const match = password && encoder.encode(password).length <= 1024
    && equal(await passwordHash(password, env.APP_PASSWORD_SALT), env.APP_PASSWORD_HASH);
  if (!match || !equal(username, env.APP_USERNAME)) {
    if (retry) fail(429, 'failed_logins_rate_limited', { captcha }, retry);
    fail(401, 'invalid_credentials', { captcha });
  }

  const games = await listGames(db);
  const value = randomId(32);
  const token = await sha256(value);
  const issued = now();
  const session = { token, authenticated_at: issued, activity_at: issued };
  const commands = [];
  if (previous) {
    commands.push(sessionGuard(db, previous),
      sql(db, 'DELETE FROM uploads WHERE owner = ?', previous.token),
      sql(db, 'DELETE FROM sessions WHERE token = ?', previous.token));
  }
  commands.push(
    sql(db, 'DELETE FROM sessions WHERE activity_at <= ?', issued - idleSeconds),
    sql(db, 'DELETE FROM rate_limits WHERE bucket IN (?, ?, ?) OR started_at < ?', captchaKey, failureKey, userKey, issued - 86400),
    sql(db, 'INSERT INTO sessions(token, authenticated_at, activity_at) VALUES (?, ?, ?)', token, issued, issued),
  );
  try {
    await db.batch(commands);
  } catch (error) {
    if (failedCheck(error)) fail(409, 'session_unavailable');
    throw error;
  }
  context.waitUntil(notifyLogin(env, env.APP_USERNAME, ip, issued));
  return { games, session, cookie: `${cookieName}=${value}; ${secureAttributes}` };
}
