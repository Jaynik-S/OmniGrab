// Native DOM regression coverage: linkedom does not model shadow MutationObserver boundaries.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';
import { chromium } from 'playwright-core';

const binary = process.env.CHROMIUM_PATH ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const bundle = await transform(await readFile('src/content/collector.ts', 'utf8'), { loader: 'ts', format: 'iife', globalName: 'detector', target: 'chrome120' });
const server = createServer((request, response) => {
  if (request.url?.endsWith('.mp4')) { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Native collector regression</title><main></main>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ executablePath: binary, headless: true });
  for (const [name, run] of [
    ['SPA sources use current document URL', async page => {
      await page.evaluate(() => {
        const video = document.createElement('video');
        video.preload = 'auto'; video.src = 'first.mp4'; document.querySelector('main').append(video);
        window.batches = [];
        window.collector = detector.observeMedia(document, location.href, batch => batches.push(...batch), { delay: 0 });
        history.pushState({}, '', '/new/');
        video.src = 'second.mp4';
      });
      await page.waitForFunction(() => document.querySelector('video').currentSrc.endsWith('/new/second.mp4'), null, { timeout: 1000 });
      await page.waitForTimeout(50);
      const observed = await page.evaluate(() => batches.filter(item => item.url.includes('second.mp4')));
      assert.ok(observed.length > 0);
      assert.ok(observed.every(item => item.url === `${origin}/new/second.mp4` && item.pageUrl === `${origin}/new/`), JSON.stringify(observed));
    }],
    ['late open shadow roots on existing hosts are discovered without rescan', async page => {
      await page.evaluate(() => {
        const host = document.createElement('div'); document.querySelector('main').append(host);
        window.batches = [];
        window.collector = detector.observeMedia(document, location.href, batch => batches.push(...batch), { delay: 0, sweepInterval: 30 });
        host.attachShadow({ mode: 'open' }).innerHTML = '<video preload="none" src="/late-shadow.mp4"></video>';
      });
      await page.waitForFunction(() => batches.some(item => item.url.endsWith('/late-shadow.mp4')), null, { timeout: 1000 });
      await page.evaluate(() => document.querySelector('main > div').shadowRoot.querySelector('video').src = '/late-changed.mp4');
      await page.waitForFunction(() => batches.some(item => item.url.endsWith('/late-changed.mp4')), null, { timeout: 1000 });
    }],
    ['detached shadow roots release observer capacity', async page => {
      await page.evaluate(() => {
        window.batches = [];
        const main = document.querySelector('main');
        for (let index = 0; index < 210; index++) {
          const host = document.createElement('div'); host.attachShadow({ mode: 'open' }); main.append(host);
        }
        window.collector = detector.observeMedia(document, location.href, batch => batches.push(...batch), { delay: 0, sweepInterval: 5000 });
        main.replaceChildren();
        const host = document.createElement('div');
        host.attachShadow({ mode: 'open' }).innerHTML = '<video preload="none" src="/after-churn.mp4"></video>';
        main.append(host);
      });
      await page.waitForFunction(() => batches.some(item => item.url.endsWith('/after-churn.mp4')), null, { timeout: 1000 });
      await page.evaluate(() => document.querySelector('main > div').shadowRoot.querySelector('video').src = '/after-churn-changed.mp4');
      await page.waitForFunction(() => batches.some(item => item.url.endsWith('/after-churn-changed.mp4')), null, { timeout: 1000 });
    }],
  ]) {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/old/`);
      await page.addScriptTag({ content: bundle.code });
      await run(page);
      results.push({ name, passed: true });
    } catch (error) { results.push({ name, passed: false, error: String(error) }); }
    finally { await page.close(); }
  }
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
  assert.ok(results.every(result => result.passed), 'Native collector regressions failed');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
