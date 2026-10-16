import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('dist/popup', { recursive: true });
const parserLicense = (await readFile('node_modules/fast-xml-parser/LICENSE', 'utf8')).trim();
if (!parserLicense.includes('MIT License') || !parserLicense.includes('Copyright (c) 2017 Amit Kumar Gupta') || parserLicense.includes('*/')) throw new Error('Unexpected fast-xml-parser license');
const parserNotice = `/*! fast-xml-parser\n${parserLicense}\n*/`;
await build({ entryPoints: { background: 'src/background/index.ts' }, outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', legalComments: 'eof', metafile: false, banner: { js: parserNotice } });
await build({ entryPoints: { content: 'src/content/index.ts' }, outdir: 'dist', bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', legalComments: 'eof' });
await build({ entryPoints: { index: 'src/popup/index.ts' }, outdir: 'dist/popup', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', legalComments: 'eof' });
for (const [src, dest] of [['extension/manifest.json', 'dist/manifest.json'], ['src/popup/index.html', 'dist/popup/index.html'], ['src/popup/style.css', 'dist/popup/style.css']]) await copyFile(src, dest);
const allowed = new Set(['background.js', 'content.js', 'manifest.json', 'popup/index.js', 'popup/index.html', 'popup/style.css']);
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
console.log('Built and audited six extension files; research and fixtures excluded.');
