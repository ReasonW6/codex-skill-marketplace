export const bidiError = (code, message) => Object.assign(new Error(message), { code });

export function localEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw bidiError('INVALID_ENDPOINT', 'Use the endpoint created by the Zen launcher.'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash ||
      !/^\/session(?:\/[\da-f-]{36})?$/.test(url.pathname)) throw bidiError('INVALID_ENDPOINT', 'The native input endpoint must be a loopback Zen session.');
  return url.href;
}

export class BidiConnection {
  constructor(endpoint, { Socket = globalThis.WebSocket, timeout = 15000, connectTimeout = timeout } = {}) {
    this.endpoint = localEndpoint(endpoint); this.Socket = Socket; this.timeout = timeout;
    this.connectTimeout = connectTimeout;
    this.pending = new Map(); this.nextId = 0; this.socket = null;
  }
  async connect() {
    const socket = new this.Socket(this.endpoint); this.socket = socket;
    socket.addEventListener('message', event => {
      let message;
      try {
        if (typeof event.data !== 'string' || event.data.length > 16 * 1024 * 1024) throw new Error('Invalid BiDi response');
        message = JSON.parse(event.data);
      } catch { this.fail(bidiError('BIDI_PROTOCOL', 'Invalid or oversized browser response.')); socket.close(); return; }
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      if (message.type === 'error') item.reject(bidiError('BIDI_ERROR', message.error + ': ' + message.message));
      else if (message.type === 'success') item.resolve(message.result);
      else item.reject(bidiError('BIDI_PROTOCOL', 'The browser returned an invalid command response.'));
    });
    socket.addEventListener('close', () => this.fail(bidiError('NATIVE_DISCONNECTED', 'Native input disconnected. The last action may already have happened; do not replay it.')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(bidiError('NATIVE_UNAVAILABLE', 'Zen native input did not connect.')); }, this.connectTimeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(bidiError('NATIVE_UNAVAILABLE', 'Zen native input is unavailable. Launch Zen with the supplied launcher.')); }, { once: true });
    });
    return this;
  }
  request(method, params = {}, timeout = this.timeout) {
    if (this.socket?.readyState !== 1) return Promise.reject(bidiError('NATIVE_DISCONNECTED', 'The native input session is closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(bidiError('NATIVE_TIMEOUT', 'Native browser request '+method+' timed out; the action may already have happened. Observe before planning another action.'));
        this.socket.close();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  close() { this.fail(bidiError('NATIVE_DISCONNECTED', 'Native input session ended.')); this.socket?.close(); }
}
