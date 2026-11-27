import assert from 'node:assert/strict';
import { getSession } from '../backend/auth.mjs';
import { now, sha256 } from '../backend/http.mjs';
import { notifyLogin } from '../backend/login-notification.mjs';
import { SmtpError } from '../backend/smtp.mjs';
import { d1Fixture } from './sqlite-d1.mjs';

const { db, sqlite } = d1Fixture();
const insert = sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
const existingCookies = ['a'.repeat(64), 'b'.repeat(64)];
for (const cookie of existingCookies) insert.run(await sha256(cookie), now(), now());
const requestFor = cookie => new Request('https://savepoint.example/api/games.php?session=1', {
  headers: { Cookie: 'savepoint_cf_session_v1=' + cookie, 'CF-Connecting-IP': '192.0.2.10' },
});
for (let count = 0; count < 35; count++) {
  assert.equal(await getSession(db, requestFor('c'.repeat(64)), { passive: true }), null);
}
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM rate_limits').get().n, 0);
for (let count = 0; count < 31; count++) {
  assert.ok(await getSession(db, requestFor(existingCookies[0]), { passive: true }));
}
await assert.rejects(getSession(db, requestFor(existingCookies[0]), { passive: true }), { status: 429 });
assert.ok(await getSession(db, requestFor(existingCookies[1]), { passive: true }));
sqlite.close();

const mail = { MAIL_FROM: 'from@example.org', MAIL_TO: 'to@example.org' };
const mailOptions = { delay: async () => {} };
const smtp = { ...mail, SMTP_HOST: 'mail.example.org', SMTP_PASSWORD: 'synthetic-password' };
const deliveryIds = [];
assert.equal(await notifyLogin(smtp, 'example-user', '192.0.2.10', now(), {
  ...mailOptions,
  smtp: async (_message, _host, _password, id) => {
    deliveryIds.push(id);
    if (deliveryIds.length === 1) throw new SmtpError('message acceptance', 451);
  },
}), 'accepted');
assert.equal(deliveryIds.length, 2);
assert.equal(deliveryIds[0], deliveryIds[1]);

const rest = { ...mail, CF_EMAIL_ACCOUNT_ID: '0'.repeat(32), CF_EMAIL_TOKEN: 'synthetic-token' };
const report = result => Response.json({ success: true, result });
let attempts = 0;
assert.equal(await notifyLogin(rest, 'example-user', '192.0.2.10', now(), {
  ...mailOptions,
  fetchResponse: async (_url, { body }) => {
    assert.deepEqual(JSON.parse(body).to, ['to@example.org']);
    return ++attempts === 1 ? new Response('', { status: 503 }) : report({ queued: ['to@example.org'] });
  },
}), 'accepted');
assert.equal(attempts, 2);
attempts = 0;
assert.equal(await notifyLogin(rest, 'example-user', '192.0.2.10', now(), {
  ...mailOptions,
  fetchResponse: async () => {
    attempts++;
    return report({ permanent_bounces: ['to@example.org'] });
  },
}), 'rejected');
assert.equal(attempts, 1);
console.log('PASS: legitimate sessions have independent limits and login notifications handle transient failures and delivery results.');
