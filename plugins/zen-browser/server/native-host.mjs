import net from 'node:net';
import path from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NativeDecoder, LineDecoder, nativeFrame, writeLine, failure } from './wire.mjs';
import { connectionDir, dataHome } from './paths.mjs';
import { NativeDriver } from './native-driver.mjs';

export async function startHost({ input = process.stdin, output = process.stdout, home = dataHome(), nativeDriver } = {}) {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const dir = await connectionDir(home);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\reasonw6-zen-${id}` : path.join(dir, `${id}.sock`);
  const record = path.join(dir, `${id}.json`);
  const clients = new Set();
  const pending = new Map();
  const native = nativeDriver ?? (process.env.ZEN_BROWSER_LAUNCH ? new NativeDriver({ file: process.env.ZEN_BROWSER_LAUNCH, home }) : null);
  let ready = false, closing = false;
  const send = message => output.write(nativeFrame(message));
  const server = net.createServer(socket => {
    const sessionId = randomUUID();
    clients.add(socket);
    const decoder = new LineDecoder();
    // Idle unauthenticated pipes cannot accumulate indefinitely.
    socket.setTimeout(5000, () => socket.destroy());
    let authenticated = false;
    decoder.on('message', message => {
      const candidate = Buffer.from(typeof message.token === 'string' ? message.token : '');
      const expected = Buffer.from(token);
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        socket.destroy(); return;
      }
      authenticated = true;
      socket.setTimeout(0);
      if (message.command === '_ping') {
        writeLine(socket, { id: message.id, result: { ready, connectionId: id } }); return;
      }
      if (!ready || typeof message.id !== 'string' || typeof message.command !== 'string' || pending.size >= 64) {
        writeLine(socket, { id: message.id, error: { code: 'BRIDGE_BUSY', message: 'The browser is not ready or the request queue is full.' } }); return;
      }
      if (message.command.startsWith('_')) {
        writeLine(socket, { id: message.id, error: { code: 'INVALID_COMMAND', message: 'Reserved bridge command.' } }); return;
      }
      const requestId = randomUUID();
      const timeout = Math.max(1000, Math.min(35000, Number(message.timeoutMs) || 15000));
      const timer = setTimeout(() => {
        native?.cancel(requestId);
        pending.delete(requestId);
        send({ type: 'cancel', id: requestId, sessionId });
        writeLine(socket, { id: message.id, error: { code: 'TIMEOUT', message: 'Browser operation timed out; its outcome may be unknown. Observe before retrying a write.' } });
      }, timeout);
      pending.set(requestId, { socket, clientId: message.id, timer, sessionId, command: message.command, tabId: message.params?.tabId });
      try {
        send({ type: 'request', id: requestId, sessionId, command: message.command,
          params: message.params || {}, deadline: Date.now() + timeout - 100 });
      } catch (error) {
        clearTimeout(timer); pending.delete(requestId);
        writeLine(socket, { id: message.id, error: failure(error) });
      }
    });
    socket.on('data', chunk => { try { decoder.push(chunk); } catch { socket.destroy(); } });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clients.delete(socket);
      for (const [requestId, item] of pending) if (item.socket === socket) {
        native?.cancel(requestId);
        clearTimeout(item.timer); pending.delete(requestId);
        if (!closing) send({ type: 'cancel', id: requestId, sessionId });
      }
      if (authenticated && !closing) send({ type: 'release', sessionId });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const decoder = new NativeDecoder();
  const close = async () => {
    if (closing) return;
    closing = true;
    for (const item of pending.values()) clearTimeout(item.timer);
    await native?.close();
    pending.clear();
    for (const socket of clients) socket.destroy();
    server.close();
    // Only this host's exact discovery file is removed. No stale-file sweep.
    await unlink(record).catch(e => { if (e.code !== 'ENOENT') console.error(e.message); });
  };
  decoder.on('message', message => {
    if (message.type === 'hello' && message.version === 1 && !ready) {
      ready = true;
      send({ type: 'native-ready', available: !!native });
      const entry = { version: 1, id, pid: process.pid, endpoint, token, browser: message.browser, nativeInput: !!native, startedAt: new Date().toISOString() };
      writeFile(record, JSON.stringify(entry), { flag: 'wx', mode: 0o600 }).catch(error => { console.error(error.message); close(); });
    } else if (message.type === 'native-cancel') {
      native?.cancel(message.requestId);
    } else if (message.type === 'native-request') {
      const item = pending.get(message.requestId);
      if (!native || !item || item.nativeStarted || item.sessionId !== message.sessionId || item.tabId !== message.tabId || item.command !== message.plan?.command ||
          !['click','fill','press','drag'].includes(item.command)) {
        send({ type: 'native-response', id: message.id, error: { code: 'NATIVE_NOT_AUTHORIZED', message: 'No active owned request authorizes this native operation.' } });
        return;
      }
      item.nativeStarted = true;
      native.execute(message.requestId, message.lease, message.plan, message.deadline)
        .then(result => { if (!closing) send({ type: 'native-response', id: message.id, result }); })
        .catch(error => { if (!closing) send({ type: 'native-response', id: message.id, error: failure(error) }); });
    } else if (message.type === 'response') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      try { writeLine(item.socket, { id: item.clientId, ...(message.error ? { error: message.error } : { result: message.result }) }); }
      catch (error) { writeLine(item.socket, { id: item.clientId, error: failure(error) }); }
    }
  });
  input.on('data', chunk => { try { decoder.push(chunk); } catch (error) { console.error(error.message); close(); input.destroy(); } });
  input.on('end', close);
  input.on('error', close);
  output.on('error', close);
  return { id, endpoint, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const at = process.argv.indexOf('--data-dir');
  const home = at === -1 ? dataHome() : process.argv[at + 1];
  startHost({ home }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
