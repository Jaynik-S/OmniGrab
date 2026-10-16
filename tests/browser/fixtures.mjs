import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export const FLOWER_BASE = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/';

async function orderAssets(mp4) {
  try {
    const directory = await mkdtemp(path.join(tmpdir(), 'media-detection-hls-assets-'));
    await writeFile(path.join(directory, 'flower.mp4'), mp4);
    await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'flower.mp4',
      '-map', '0:v:0', '-an', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'video-%03d.mp4', '-start_number', '1', '-hls_playlist_type', 'vod', 'child.m3u8'],
    { cwd: directory, timeout: 15000, windowsHide: true });
    const files = new Map(await Promise.all((await readdir(directory)).filter(name => name !== 'flower.mp4').map(async name => [name, await readFile(path.join(directory, name))])));
    const playlist = files.get('child.m3u8').toString('utf8');
    const duration = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    if (!(duration > 0) || !files.has('video-001.mp4')) throw new Error('Remux did not produce expected media assets');
    return { files, playlist, duration, mode: 'genuine ffmpeg-remuxed CC0 fMP4 HLS assets; network-order test only' };
  } catch (error) {
    const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:5.055,\nvideo-001.mp4\n#EXT-X-ENDLIST\n';
    return { files: new Map([['video-001.mp4', mp4]]), playlist, duration: 5.055,
      mode: 'parser/network-order control using complete CC0 MP4 as segment; no HLS playback claim', remuxUnavailable: String(error.message).split('\n')[0] };
  }
}

/** Original HTML fixtures; CC0 MDN samples stay in memory and are never committed. */
export async function startFixtures() {
  const media = new Map(await Promise.all(['mp4', 'webm'].map(async format => {
    const response = await fetch(`${FLOWER_BASE}flower.${format}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`CC0 ${format} fixture fetch: HTTP ${response.status}`);
    return [format, Buffer.from(await response.arrayBuffer())];
  })));
  const hlsAssets = await orderAssets(media.get('mp4'));
  const orderStates = new Map();
  let pageOrigin;
  let frameOrigin;
  let mediaOrigin;
  let slowManifestRequests = 0;
  const html = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>${body}`;
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/frame-never-commits') {
      const timer = setTimeout(() => { if (!res.destroyed) { res.statusCode = 204; res.end(); } }, 5000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    const orderMatch = /^\/order\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (orderMatch && orderStates.has(orderMatch[1])) {
      const state = orderStates.get(orderMatch[1]);
      const name = orderMatch[2];
      state.requests.push({ name, method: req.method, at: Date.now() });
      res.setHeader('Cache-Control', 'no-store');
      if (!name) { res.setHeader('Content-Type', 'text/html'); res.end(html('HLS request-order control', '<p>The harness performs explicit manifest and segment fetches. No player is started.</p>')); return; }
      if (name === 'master.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=960x540\nchild.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=480x270\nunused.m3u8\n'); return;
      }
      if (name === 'child.m3u8' || name === 'unused.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        const protection = state.protected ? '#EXT-X-KEY:METHOD=AES-128,URI="never-request-key.key"\n' : '';
        const finish = () => { if (!res.destroyed) res.end(hlsAssets.playlist.replace('#EXTM3U\n', `#EXTM3U\n${protection}`)); };
        // Explicit page POSTs deliver the observation; independent extension GET probes are held.
        if (name === 'child.m3u8' && state.hold && req.method === 'GET') { res.flushHeaders(); state.held.add(finish); res.on('close', () => state.held.delete(finish)); }
        else finish();
        return;
      }
      if (hlsAssets.files.has(name)) { res.setHeader('Content-Type', 'video/mp4'); res.end(hlsAssets.files.get(name)); return; }
      res.statusCode = 404; res.end('Order fixture resource unavailable'); return;
    }
    if (url.pathname === '/master-only.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n' + [[8, 6221600, '1920x1080', 'fhd'], [0, 2149280, '1280x720', 'hd'], [6, 836280, '848x480', 'hq'], [4, 460560, '512x288', ''], [2, 246440, '320x184', 'ld']].map(([index, bandwidth, size, quality]) => `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${size}\nhttps://test-streams.mux.dev/x36xhzz/url_${index}/193039199_mp4_h264_aac_${quality ? `${quality}_` : ''}7.m3u8\n`).join(''));
      return;
    }
    if (url.pathname === '/slow-master.m3u8') {
      slowManifestRequests++;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const finish = () => res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2149280,RESOLUTION=1280x720\nhttps://test-streams.mux.dev/x36xhzz/url_0/193039199_mp4_h264_aac_hd_7.m3u8\n');
      if (slowManifestRequests === 1) finish(); else setTimeout(finish, 1500);
      return;
    }
    if (url.pathname.startsWith('/media/')) {
      const format = url.pathname.endsWith('.webm') ? 'webm' : 'mp4';
      const bytes = media.get(format);
      res.setHeader('Content-Type', `video/${format}`);
      res.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start >= bytes.length || end < start) { res.writeHead(416); res.end(); return; }
      if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`); }
      res.setHeader('Content-Length', end - start + 1);
      res.end(bytes.subarray(start, end + 1));
      return;
    }
    if (url.pathname === '/video-banner.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const video = src => `<video controls muted preload="auto" src="${src}"></video>`;
    if (url.pathname === '/dynamic') res.end(html('Delayed video insertion', `<button id="insert">Insert video</button><script>document.querySelector('button').onclick=()=>{setTimeout(()=>{const v=document.createElement('video');v.controls=true;v.muted=true;v.preload='auto';v.src='${mediaOrigin}/media/dynamic.mp4';document.body.append(v)},350)}</script>`));
    else if (url.pathname === '/multiple') res.end(html('Two independent videos', video(`${mediaOrigin}/media/first.mp4`) + video(`${mediaOrigin}/media/second.webm`)));
    else if (url.pathname === '/embedded') res.end(html('Cross-origin embedded player', `<iframe src="${frameOrigin}/frame" title="Cross-origin video"></iframe>`));
    else if (url.pathname === '/frame-lifecycle') res.end(html('Frame lifecycle', video(`${mediaOrigin}/media/top.mp4`) + `<iframe src="${frameOrigin}/frame" title="Frame lifecycle player"></iframe>`));
    else if (url.pathname === '/stale-manifest') res.end(html('Delayed manifest completion', '<button onclick="fetch(\'/slow-master.m3u8\')">Observe manifest</button>'));
    else if (url.pathname === '/master-only') res.end(html('Master-only HLS observation', '<button onclick="fetch(\'/master-only.m3u8\')">Observe master</button>'));
    else if (url.pathname === '/popup-delayed') res.end(html('Popup observes new media', `<script>setTimeout(()=>{const v=document.createElement('video');v.controls=true;v.muted=true;v.preload='auto';v.src='${mediaOrigin}/media/popup.mp4';document.body.append(v)},1200)</script>`));
    else if (url.pathname === '/frame') res.end(html('Frame player', video(`${mediaOrigin}/media/framed.mp4`)));
    else if (url.pathname === '/mime-negative') res.end(html('Negative MIME evidence', video(`${mediaOrigin}/misleading.mp4`) + '<img src="/video-banner.svg" alt="Video banner">'));
    else if (url.pathname === '/misleading.mp4') res.end('<!doctype html><title>This is HTML, not media</title>');
    else if (url.pathname === '/direct') res.end(html('Direct video fixture', video(`${mediaOrigin}/media/flower.mp4`)));
    else if (url.pathname === '/no-video') res.end(html('No media fixture', '<p>Plain text with an ordinary image.</p><img src="/video-banner.svg" alt="Video banner">'));
    else { res.statusCode = 404; res.end('<!doctype html><title>Fixture not found</title>'); }
  };
  const servers = [http.createServer(handler), http.createServer(handler)];
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  pageOrigin = `http://127.0.0.1:${servers[0].address().port}`;
  frameOrigin = `http://localhost:${servers[0].address().port}`;
  mediaOrigin = `http://127.0.0.1:${servers[1].address().port}`;
  return { pageOrigin, frameOrigin, mediaOrigin, sizes: Object.fromEntries([...media].map(([k, v]) => [k, v.length])), slowManifestRequests: () => slowManifestRequests,
    orderAssets: { mode: hlsAssets.mode, duration: hlsAssets.duration, remuxUnavailable: hlsAssets.remuxUnavailable, files: [...hlsAssets.files].map(([name, bytes]) => ({ name, bytes: bytes.length })) },
    order(name, trial, settings = {}) {
      const key = `${name}-${trial}`;
      const state = { hold: !!settings.hold, protected: !!settings.protected, held: new Set(), requests: [] };
      orderStates.set(key, state);
      const base = `${pageOrigin}/order/${key}/`;
      return { page: base, master: `${base}master.m3u8`, child: `${base}child.m3u8`, unused: `${base}unused.m3u8`, segment: `${base}video-001.mp4`,
        duration: hlsAssets.duration, protected: state.protected, mode: hlsAssets.mode,
        heldCount: () => state.held.size, requests: () => [...state.requests], release() { state.hold = false; for (const finish of [...state.held]) finish(); state.held.clear(); } };
    },
    close: () => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))) };
}
