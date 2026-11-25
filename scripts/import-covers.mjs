import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { imageInfo } from '../backend/images.mjs';

const [directory, bucket, option] = process.argv.slice(2);
if (!directory || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? '')
  || !['--local', '--remote'].includes(option) || process.argv.length !== 5) {
  console.error('Usage: node scripts/import-covers.mjs BACKUP_DIRECTORY R2_BUCKET --local|--remote');
  process.exit(1);
}

const root = resolve(directory);
let uploaded = 0;
let skipped = 0;
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile() || !/^[a-f0-9]{64}\.img$/.test(entry.name)) continue;
  const file = join(root, entry.name);
  const size = (await stat(file)).size;
  const image = size && size <= 5242880 ? imageInfo(await readFile(file)) : null;
  if (!image || image.width > 8192 || image.height > 8192 || image.width * image.height > 40000000) {
    skipped++;
    continue;
  }
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler@4', 'r2', 'object', 'put', bucket + '/covers/' + entry.name, '--file', file, '--content-type', image.type, option],
    { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Import stopped. Running the command again uses the same object keys.');
    process.exit(1);
  }
  uploaded++;
}
console.log(`Imported covers: ${uploaded}. Skipped invalid images: ${skipped}.`);
