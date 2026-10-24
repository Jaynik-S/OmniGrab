// Read-only native process/heap observer for an already-owned acceptance browser.
// No code injection, media body cloning, or service-worker wake messages.
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = path.resolve(process.argv[2]);
const receipt = JSON.parse(await readFile(path.join(run, 'receipt.json'), 'utf8'));
const lines = (await readFile(path.join(receipt.profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
if (Number(lines[0]) === 9222) throw Error('User browser port forbidden');
const socket = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let next = 0, closed = false; const pending = new Map(), sessions = new Map(), childTargets = new Map();
socket.addEventListener('close', () => { closed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('browser closed')); } pending.clear(); });
socket.addEventListener('message', event => { const m = JSON.parse(event.data); if(m.method==='Target.attachedToTarget'){const t=m.params.targetInfo;childTargets.set(t.targetId,t);sessions.set(t.targetId,m.params.sessionId);}const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); });
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout')); }, 5000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
}
const execute = promisify(execFile);
try {
  while (!closed) {
    const sample = { at: new Date().toISOString(), heaps: [] };
    const { targetInfos } = await send('Target.getTargets');
    for (const t of new Map([...targetInfos.filter(t => ['page', 'background_page'].includes(t.type)), ...childTargets.values()].map(t=>[t.targetId,t])).values()) {
      if (!sessions.has(t.targetId)) {
        sessions.set(t.targetId, (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId);
        if(t.type==='background_page')await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessions.get(t.targetId));
      }
      try { sample.heaps.push({ targetId: t.targetId, type: t.type, url: t.url, ...await send('Runtime.getHeapUsage', {}, sessions.get(t.targetId)) }); }
      catch (error) { sample.heaps.push({ targetId: t.targetId, type:t.type, url:t.url, error: error.message }); }
    }
    sample.processes = (await send('SystemInfo.getProcessInfo')).processInfo;
    const ids = sample.processes.map(p => p.id); if (!ids.every(Number.isSafeInteger)) throw Error('Invalid browser PID');
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`]);
    sample.memory = JSON.parse(stdout);
    await appendFile(path.join(run, 'resources.ndjson'), JSON.stringify(sample) + '\n');
    console.log(JSON.stringify({ at: sample.at, targets: sample.heaps.length, workingSet: [].concat(sample.memory).reduce((n, p) => n + p.WorkingSet64, 0) }));
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
} catch (error) { if (!closed) throw error; }
finally { socket.close(); }
