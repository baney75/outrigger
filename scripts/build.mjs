import { build } from 'esbuild';
import { mkdir, rm, cp, readFile, writeFile, readdir } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: { panel: 'src/main.tsx', background: 'src/background.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: true,
  sourcemap: false,
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await cp('public', 'dist', { recursive: true });
await writeFile(
  'dist/sidepanel.html',
  '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Outrigger · T3 Code beside you</title><link rel="stylesheet" href="panel.css"></head><body><div id="root"></div><script type="module" src="panel.js"></script></body></html>',
);
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
manifest.version = packageJson.version;
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
await mkdir('dist/licenses', { recursive: true });
await cp('LICENSE', 'dist/licenses/Outrigger.txt');
await cp('docs/T3-LICENSE.txt', 'dist/licenses/T3-Code.txt');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [];
for (const [directory, info] of Object.entries(lock.packages)) {
  if (!directory || info.dev) continue;
  const names = (await readdir(directory)).filter((name) =>
    /^(licen[sc]e|copying|notice)(\.|$)/i.test(name),
  );
  for (const name of names) {
    try {
      notices.push(
        `${directory.replace(/^node_modules\//, '')} (${info.license ?? 'See notice'})\n${await readFile(`${directory}/${name}`, 'utf8')}`,
      );
    } catch {
      /* Some packages use a directory of notices. */
    }
  }
}
await writeFile('dist/licenses/Dependencies.txt', notices.join('\n\n────────────────────────\n\n'));
console.log(`Built ${manifest.name} ${manifest.version} → dist/`);
