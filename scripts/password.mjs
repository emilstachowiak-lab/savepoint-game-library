import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { passwordHash } from '../backend/auth.mjs';
import { encoder, randomId } from '../backend/http.mjs';

const { stdin, stdout } = process;
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('Run this script in an interactive terminal.');
  process.exit(1);
}
const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
const input = createInterface({ input: stdin, output: muted, terminal: true });
try {
  stdout.write('Enter your Savepoint password (input is hidden): ');
  const password = await input.question('');
  stdout.write('\n');
  if (!password || encoder.encode(password).length > 1024) throw new Error('The password must be between 1 and 1024 bytes.');
  const salt = randomId(24);
  console.log('APP_PASSWORD_SALT=' + salt);
  console.log('APP_PASSWORD_HASH=' + await passwordHash(password, salt));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  input.close();
}
