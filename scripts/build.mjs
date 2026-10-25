import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

await mkdir('dist/popup', { recursive: true });
const parserLicense = (await readFile('node_modules/fast-xml-parser/LICENSE', 'utf8')).trim();
if (!parserLicense.includes('MIT License') || !parserLicense.includes('Copyright (c) 2017 Amit Kumar Gupta') || parserLicense.includes('*/')) throw new Error('Unexpected fast-xml-parser license');
const parserNotice = `/*! fast-xml-parser\n${parserLicense}\n*/`;
await build({ entryPoints: { background: 'src/background/index.ts' }, outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', legalComments: 'eof', metafile: false, banner: { js: parserNotice } });
await build({ entryPoints: { content: 'src/content/index.ts' }, outdir: 'dist', bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', legalComments: 'eof' });
await build({ entryPoints: { index: 'src/popup/index.ts' }, outdir: 'dist/popup', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', legalComments: 'eof' });
await build({ entryPoints: { offscreen: 'src/downloads/offscreen.ts', 'download-worker': 'src/downloads/worker.ts' }, outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', legalComments: 'eof' });
await mkdir('dist/licenses', { recursive: true });
await mkdir('dist/icons', { recursive: true });
await mkdir('dist/fonts', { recursive: true });
for (const [src, dest] of [['src/downloads/offscreen.html', 'dist/offscreen.html'], ['THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md'], ['licenses/mediabunny-MPL-2.0.txt', 'dist/licenses/mediabunny-MPL-2.0.txt']]) await copyFile(src, dest);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (hash(await readFile('node_modules/mediabunny/LICENSE')) !== hash(await readFile('dist/licenses/mediabunny-MPL-2.0.txt'))) throw new Error('Mediabunny license mismatch');
if (!(await readFile('dist/THIRD_PARTY_NOTICES.md', 'utf8')).includes('1.62.1')) throw new Error('Missing pinned Mediabunny source notice');
for (const [src, dest] of [['extension/manifest.json', 'dist/manifest.json'], ['src/popup/index.html', 'dist/popup/index.html'], ['src/popup/style.css', 'dist/popup/style.css']]) await copyFile(src, dest);
for (const size of [16, 32, 48, 128]) await copyFile(`extension/icons/omnigrab-${size}.png`, `dist/icons/omnigrab-${size}.png`);
await copyFile('extension/fonts/nunito-sans-latin.woff2', 'dist/fonts/nunito-sans-latin.woff2');
await copyFile('licenses/nunito-sans-OFL.txt', 'dist/licenses/nunito-sans-OFL.txt');
if (!(await readFile('dist/licenses/nunito-sans-OFL.txt', 'utf8')).includes('SIL OPEN FONT LICENSE Version 1.1')) throw new Error('Missing Nunito Sans font license');
const allowed = new Set(['background.js', 'content.js', 'manifest.json', 'popup/index.js', 'popup/index.html', 'popup/style.css', 'offscreen.js', 'offscreen.html', 'download-worker.js', 'THIRD_PARTY_NOTICES.md', 'licenses/mediabunny-MPL-2.0.txt']);
for (const size of [16, 32, 48, 128]) allowed.add(`icons/omnigrab-${size}.png`);
allowed.add('fonts/nunito-sans-latin.woff2');
allowed.add('licenses/nunito-sans-OFL.txt');
const artifactCount = allowed.size;
async function audit(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await audit(path.join(dir, entry.name), `${name}/`);
    else if (!allowed.delete(name)) throw new Error(`Unexpected build artifact: ${name}`);
  }
}
await audit('dist');
if (allowed.size) throw new Error(`Missing build artifacts: ${[...allowed].join(', ')}`);
if (!(await readFile('dist/background.js', 'utf8')).includes(parserNotice)) throw new Error('Missing fast-xml-parser MIT notice in background bundle');
console.log(`Built and audited ${artifactCount} extension files; local branding, host/worker and verified licenses; research and fixtures excluded.`);
