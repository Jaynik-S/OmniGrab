// Shared read-only CDP connection for owned native extension targets, including action popups.
export async function connectTarget(port, url, sockets = new Set()) {
  if (port === 9222) throw Error('User browser port forbidden');
  let target; const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(target => target.url === url);
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!target) throw Error('target missing: ' + url);
  const socket = new WebSocket(target.webSocketDebuggerUrl); sockets.add(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map(), listeners = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data); for (const listener of listeners.get(data.method) ?? []) listener(data.params);
    const p = pending.get(data.id); if (!p) return;
    pending.delete(data.id); clearTimeout(p.timer); data.error ? p.reject(Error(JSON.stringify(data.error))) : p.resolve(data.result);
  });
  socket.addEventListener('close', () => { sockets.delete(socket); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('target closed')); } pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== 1) { reject(Error('target closed')); return; }
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error('CDP timeout ' + method)); }, 15000);
    pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, get closed() { return socket.readyState !== 1; }, on(method, listener) { listeners.set(method, [...(listeners.get(method) ?? []), listener]); }, close: () => socket.close(), async evaluate(fn, arg) {
    const response = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails)); return response.result.value;
  } };
}
