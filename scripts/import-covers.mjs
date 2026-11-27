import { access, readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { MAX_COVER_BYTES, validatedCoverInfo } from '../backend/images.mjs';

const [directory, bucket, option] = process.argv.slice(2);
if (!directory || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? '')
  || !['--local', '--remote'].includes(option) || process.argv.length !== 5) {
  console.error('Usage: node scripts/import-covers.mjs BACKUP_DIRECTORY R2_BUCKET --local|--remote');
  process.exit(1);
}

const root = resolve(directory);
let wranglerCommand = ['npx'];
if (process.platform === 'win32') {
  const directories = new Set([dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]);
  wranglerCommand = [];
  for (const bin of directories) {
    const npxCli = join(bin.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    try { await access(npxCli); } catch { continue; }
    wranglerCommand = [process.execPath, npxCli];
    break;
  }
  if (!wranglerCommand.length) {
    console.error('Could not locate the npm installation. Install Node.js with npm or add its directory to PATH.');
    process.exit(1);
  }
}
let uploaded = 0;
let skipped = 0;
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile() || !/^[a-f0-9]{64}\.img$/.test(entry.name)) continue;
  const file = join(root, entry.name);
  const size = (await stat(file)).size;
  const image = size && size <= MAX_COVER_BYTES ? validatedCoverInfo(await readFile(file)) : null;
  if (!image) {
    skipped++;
    continue;
  }
  const [command, ...commandArgs] = wranglerCommand;
  const result = spawnSync(command,
    [...commandArgs, 'wrangler@4', 'r2', 'object', 'put', bucket + '/covers/' + entry.name,
      '--file', file, '--content-type', image.type, option],
    { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Import stopped. Running the command again uses the same object keys.');
    process.exit(1);
  }
  uploaded++;
}
console.log(`Imported covers: ${uploaded}. Skipped invalid images: ${skipped}.`);
