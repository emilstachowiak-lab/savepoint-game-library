import { readBounded } from './http.mjs';
import { sendSmtp, SmtpError } from './smtp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendBySmtp(message, host, password, messageId, date) {
  const { connect } = await import('cloudflare:sockets');
  await sendSmtp(connect, { ...message, host, password, messageId, date });
}

async function sendByEmailApi(env, message, fetchResponse) {
  try {
    const response = await fetchResponse(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_EMAIL_ACCOUNT_ID}/email/sending/send`,
      {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.CF_EMAIL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...message, to: [message.to] }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return [429, 500, 502, 503, 504].includes(response.status) ? 'retry' : 'rejected';
    }
    const { success, result } = JSON.parse(new TextDecoder().decode(await readBounded(response.body, 32768)));
    const hasRecipient = list => Array.isArray(list) && list.some(address =>
      typeof address === 'string' && address.toLowerCase() === message.to.toLowerCase());
    if (hasRecipient(result?.permanent_bounces) || hasRecipient(result?.suppressed_recipients)) return 'rejected';
    if (success !== true) return 'rejected';
    return hasRecipient(result?.delivered) || hasRecipient(result?.queued) ? 'accepted' : 'unknown';
  } catch {
    return 'retry';
  }
}

export async function notifyLogin(env, username, ip, time, {
  smtp = sendBySmtp, fetchResponse = fetch, delay = pause,
} = {}) {
  const from = env.MAIL_FROM?.trim();
  const to = env.MAIL_TO?.trim();
  const host = env.SMTP_HOST?.trim();
  const configured = host ? Boolean(env.SMTP_PASSWORD)
    : Boolean(env.CF_EMAIL_TOKEN) && /^[0-9a-f]{32}$/i.test(env.CF_EMAIL_ACCOUNT_ID ?? '');
  if (!from || !to || !configured) return;

  const date = new Date(time * 1000);
  const messageId = crypto.randomUUID();
  const localDate = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', dateStyle: 'long', timeStyle: 'long',
  }).format(date);
  const message = {
    from, to, subject: 'Savepoint — udane logowanie',
    text: `Udane logowanie do Savepoint.\nKonto: ${username}\nCzas: ${localDate}\nAdres IP: ${ip}`,
  };
  let outcome;
  for (const wait of [0, 600, 1500]) {
    if (wait) await delay(wait);
    if (host) {
      try {
        await smtp(message, host, env.SMTP_PASSWORD, messageId, date);
        outcome = 'accepted';
      } catch (error) {
        outcome = error instanceof SmtpError && !error.retryable ? 'rejected' : 'retry';
      }
    } else {
      outcome = await sendByEmailApi(env, message, fetchResponse);
    }
    if (outcome !== 'retry') break;
  }
  if (outcome === 'accepted') console.info('Savepoint login notification accepted.');
  else console.warn('Savepoint login notification did not confirm delivery:', outcome);
  return outcome;
}
