// Test-only transport. The shipped MCP server never opens a debugging port.
import net from 'node:net';

export async function connectMarionette(port, timeoutMs = 45000) {
  const until = Date.now() + timeoutMs;
  let socket;
  while (Date.now() < until) {
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = net.createConnection({ host: '127.0.0.1', port });
        candidate.once('connect', () => resolve(candidate));
        candidate.once('error', reject);
      });
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  if (!socket) throw new Error('Isolated Zen did not start its test Marionette endpoint.');
  let buffer = Buffer.alloc(0), nextId = 0;
  const pending = new Map();
  let welcomeResolve;
  const welcome = new Promise(resolve => { welcomeResolve = resolve; });
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) return;
      const size = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + size) return;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size).toString('utf8'));
      buffer = buffer.subarray(colon + 1 + size);
      if (!Array.isArray(message)) { welcomeResolve(message); continue; }
      const [, id, error, result] = message;
      const item = pending.get(id);
      if (!item) continue;
      pending.delete(id); clearTimeout(item.timer);
      if (error) item.reject(new Error(`${error.error}: ${error.message}`)); else item.resolve(result);
    }
  });
  socket.on('error', error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); });
  socket.on('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Marionette closed')); } pending.clear(); });
  await welcome;
  return {
    command(name, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Marionette timed out: ${name}`)); }, 45000);
        pending.set(id, { resolve, reject, timer });
        const data = JSON.stringify([0, id, name, params]);
        socket.write(`${Buffer.byteLength(data)}:${data}`);
      });
    },
    close() { socket.destroy(); }
  };
}
