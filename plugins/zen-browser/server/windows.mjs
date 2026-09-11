import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const platformExecutable = path.join(pluginRoot, 'bin', 'zen-platform.exe');
export const platformError = (code, message) => Object.assign(new Error(message), { code });

function start(payload, { executable = platformExecutable, timeoutMs = 15000, hold = false } = {}) {
  if (process.platform !== 'win32') throw platformError('UNSUPPORTED_PLATFORM', 'This connection package currently supports Windows x64.');
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', settled = false;
  const decoder = new StringDecoder('utf8');
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdin.end();
      if (!hold) child.kill();
      fail(platformError('PLATFORM_TIMEOUT', 'Windows did not finish the requested connection operation. Check the browser before retrying.'));
    }, timeoutMs);
    const fail = error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    child.on('error', error => fail(platformError('PLATFORM_UNAVAILABLE', 'The bundled Windows helper could not start: ' + error.message)));
    child.stdin.on('error', error => fail(platformError('PLATFORM_DISCONNECTED', error.message)));
    child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-2000); });
    child.stdout.on('data', data => {
      output += decoder.write(data);
      if (output.length > 4 * 1024 * 1024) { child.stdin.end(); fail(platformError('INVALID_PLATFORM_RESPONSE', 'Windows returned an oversized response.')); return; }
      if (!output.includes('\n') || settled) return;
      try {
        const message = JSON.parse(output.slice(0, output.indexOf('\n')));
        if (!message || typeof message.ok !== 'boolean') throw new Error('Invalid response envelope.');
        settled = true; clearTimeout(timer);
        if (!message.ok) reject(platformError(message.error?.code || 'PLATFORM_ERROR', message.error?.message || 'The Windows operation failed.'));
        else resolve(message.result);
      } catch { fail(platformError('INVALID_PLATFORM_RESPONSE', 'The Windows helper returned an invalid response.')); }
    });
    child.on('exit', code => { if (!settled) fail(platformError('PLATFORM_EXITED', 'The Windows helper exited (' + code + '). ' + errors)); });
    child.stdin.write(JSON.stringify(payload) + '\n');
    if (!hold) child.stdin.end();
  });
  return { child, result };
}

export async function runPlatform(payload, { executable = platformExecutable, timeoutMs = 15000 } = {}) {
  if (process.platform !== 'win32') throw platformError('UNSUPPORTED_PLATFORM', 'This connection package currently supports Windows x64.');
  // Use the same registry and filesystem view as Explorer and Zen. A packaged
  // Codex process can have a different HKCU view even with the same Windows SID.
  // Discovery uses one authenticated local pipe and makes no filesystem writes.
  const pipe = 'ReasonW6.ZenBrowser.' + randomBytes(20).toString('hex');
  const nonce = randomBytes(32).toString('hex');
  const address = '\\\\.\\pipe\\' + pipe, sockets = new Set();
  let authenticated = false, finished = false, timer;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Attach immediately: dispatch can fail before the caller awaits the result.
  result.catch(() => {});
  const finish = (error, value) => {
    if (finished) return;
    finished = true; clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    server.close();
    if (error) rejectResult(error); else resolveResult(value);
  };
  const server = net.createServer(socket => {
    sockets.add(socket);
    const decoder = new StringDecoder('utf8');
    let buffer = '', accepted = false;
    socket.on('close', () => {
      sockets.delete(socket);
      if (accepted && !finished) finish(platformError('PLATFORM_DISCONNECTED', 'The Windows desktop helper disconnected before completing the operation.'));
    });
    socket.on('error', error => { if (accepted) finish(platformError('PLATFORM_DISCONNECTED', error.message)); else socket.destroy(); });
    socket.on('data', bytes => {
      buffer += decoder.write(bytes);
      if (buffer.length > 4 * 1024 * 1024) { socket.destroy(); return; }
      while (buffer.includes('\n') && !finished) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.destroy(); return; }
        if (!accepted) {
          if (authenticated || message.nonce !== nonce) { socket.destroy(); return; }
          authenticated = accepted = true;
          socket.write(JSON.stringify(payload) + '\n');
        } else {
          if (typeof message.ok !== 'boolean') { finish(platformError('INVALID_PLATFORM_RESPONSE', 'The Windows helper returned an invalid response.')); return; }
          finish(message.ok ? null : platformError(message.error?.code || 'PLATFORM_ERROR', message.error?.message || 'The Windows operation failed.'), message.result);
        }
      }
    });
  });
  server.on('error', error => finish(platformError('PLATFORM_UNAVAILABLE', error.message)));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    timer = setTimeout(() => finish(platformError('PLATFORM_TIMEOUT', 'Windows did not finish the requested connection operation. Check the browser before retrying.')), timeoutMs);
    await start({ action: 'desktop-rpc', pipe, nonce }, { executable, timeoutMs: Math.min(timeoutMs, 10000) }).result;
    return await result;
  } catch (error) { finish(error); throw error; }
}

export async function acquireConnectionLock(home, options = {}) {
  const { child, result } = start({ action: 'hold-lock', home }, { ...options, hold: true });
  try { await result; } catch (error) { child.stdin.end(); throw error; }
  return () => { child.stdin.end(); };
}
