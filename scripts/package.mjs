import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { zipSync } from 'fflate';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const entries = {};
async function collect(directory, relative = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name.startsWith('.')) throw new Error('Hidden files must not enter the release');
    const name = relative + entry.name;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), `${name}/`);
    else if (entry.isFile())
      entries[name] = [
        new Uint8Array(await readFile(path.join(directory, entry.name))),
        { mtime: new Date('2026-01-01T00:00:00Z') },
      ];
    else throw new Error('Unexpected release entry');
  }
}
await collect('dist');
if (!entries['manifest.json'] || !entries['sidepanel.html'])
  throw new Error('Build the extension before packaging');
const archive = zipSync(entries, { level: 9 });
const name = `outrigger-${version}.zip`;
await mkdir('release', { recursive: true });
await writeFile(`release/${name}`, archive);
await writeFile(
  'release/SHA256SUMS.txt',
  `${createHash('sha256').update(archive).digest('hex')}  ${name}\n`,
);
console.log(`Packaged ${name}: ${Object.keys(entries).length} files, ${archive.byteLength} bytes`);
