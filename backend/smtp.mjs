const encoder = new TextEncoder();
const mailbox = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+$/i;

export class SmtpError extends Error {
  constructor(stage, code) {
    super(code === undefined ? stage : `${stage} (SMTP ${code})`);
  }
}

function base64(value) {
  return btoa(String.fromCharCode(...encoder.encode(value)));
}

function readReplies(reader) {
  const decoder = new TextDecoder();
  let buffer = '';

  return async function readReply(stage) {
    const lines = [];
    let code;
    while (lines.length < 50) {
      let end = buffer.indexOf('\r\n');
      while (end < 0) {
        const { value, done } = await reader.read();
        if (done) throw new SmtpError(stage);
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 16384) throw new SmtpError(stage);
        end = buffer.indexOf('\r\n');
      }

      const line = /^(\d{3})(?:([ -])(.*))?$/.exec(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (!line || (code && code !== Number(line[1]))) throw new SmtpError(stage);
      code = Number(line[1]);
      lines.push(line[3] ?? '');
      if (line[2] !== '-') return { code, lines };
    }
    throw new SmtpError(stage);
  };
}

async function submit(socket, { from, to, password, subject, text }) {
  await socket.opened;
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const readReply = readReplies(reader);

  async function command(stage, message, ...expected) {
    let reply;
    try {
      if (message !== null) await writer.write(encoder.encode(`${message}\r\n`));
      reply = await readReply(stage);
    } catch {
      throw new SmtpError(stage);
    }
    if (!expected.includes(reply.code)) throw new SmtpError(stage, reply.code);
    return reply;
  }

  try {
    const domain = from.split('@')[1];
    await command('greeting', null, 220);
    const { lines } = await command('greeting', `EHLO ${domain}`, 250);
    const mechanisms = lines.flatMap(line => /^AUTH[ =](.*)$/i.exec(line)?.[1].toUpperCase().split(/\s+/) ?? []);
    if (mechanisms.includes('PLAIN')) {
      const payload = base64(`\0${from}\0${password}`);
      const reply = await command('authentication', `AUTH PLAIN ${payload}`, 235, 334);
      if (reply.code === 334) await command('authentication', payload, 235);
    } else if (mechanisms.includes('LOGIN')) {
      await command('authentication', 'AUTH LOGIN', 334);
      await command('authentication', base64(from), 334);
      await command('authentication', base64(password), 235);
    } else {
      throw new SmtpError('authentication mechanism unavailable');
    }

    await command('sender', `MAIL FROM:<${from}>`, 250);
    await command('recipient', `RCPT TO:<${to}>`, 250, 251);
    await command('message data', 'DATA', 354);
    const body = base64(text).match(/.{1,76}/g)?.join('\r\n') ?? '';
    const message = [
      `From: Savepoint <${from}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${base64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '', body, '.',
    ].join('\r\n');
    await command('message acceptance', message, 250);
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

export async function sendSmtp(connect, { host, from, to, password, subject, text }) {
  if (!mailbox.test(from) || !mailbox.test(to)) throw new SmtpError('invalid address');
  const socket = connect({ hostname: host, port: 465 }, { secureTransport: 'on' });
  socket.closed.catch(() => {});
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SmtpError('timeout')), 10000);
  });
  try {
    await Promise.race([submit(socket, { from, to, password, subject, text }), deadline]);
  } catch (error) {
    throw error instanceof SmtpError ? error : new SmtpError('connection');
  } finally {
    clearTimeout(timer);
    void socket.close().catch(() => {});
  }
}
