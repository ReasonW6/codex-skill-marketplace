import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { LineDecoder, MAX_RESPONSE, writeLine } from './wire.mjs';
import { discover } from './paths.mjs';

export class BridgeClient {
  sockets = new Map();
  async connections() {
    const entries = await discover();
    const live = [];
    for (const entry of entries) {
      try {
        await this.requestTo(entry, '_ping', {}, 1500);
        live.push(entry);
      } catch { this.disconnect(entry.id); }
    }
    return live;
  }
  async request(command, params = {}, timeoutMs = 15000) {
    const entries = await this.connections();
    const selected = params.connectionId ? entries.find(e => e.id === params.connectionId) : entries.length === 1 ? entries[0] : null;
    if (!selected) {
      const error = new Error(entries.length ? 'Multiple Zen profiles are connected. Supply the connectionId from zen_status.' : 'Zen is not connected. Open zen_connection and use the Connect Zen page to review setup or reconnect; no installation scripts are needed.');
      error.code = entries.length ? 'CONNECTION_REQUIRED' : 'NOT_CONNECTED';
      throw error;
    }
    const { connectionId, ...browserParams } = params;
    return this.requestTo(selected, command, browserParams, timeoutMs);
  }
  async requestTo(entry, command, params, timeoutMs) {
    let state = this.sockets.get(entry.id);
    if (!state) {
      const socket = net.createConnection(entry.endpoint);
      state = { socket, pending: new Map() };
      this.sockets.set(entry.id, state);
      const decoder = new LineDecoder(MAX_RESPONSE);
      decoder.on('message', message => {
        const item = state.pending.get(message.id);
        if (!item) return;
        state.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else item.resolve(message.result);
      });
      const rejectAll = error => {
        if (this.sockets.get(entry.id) === state) this.sockets.delete(entry.id);
        for (const item of state.pending.values()) { clearTimeout(item.timer); item.reject(error); }
        state.pending.clear();
      };
      socket.on('data', chunk => { try { decoder.push(chunk); } catch (e) { rejectAll(e); socket.destroy(); } });
      socket.on('error', rejectAll);
      socket.on('close', () => rejectAll(Object.assign(new Error('Zen bridge disconnected; observe before retrying an operation.'), { code: 'DISCONNECTED' })));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        // Closing the pipe cancels this session's queued browser operations.
        state.socket.destroy();
        reject(Object.assign(new Error('Zen request timed out. Observe before retrying a write.'), { code: 'TIMEOUT' }));
      }, timeoutMs + 500);
      state.pending.set(id, { resolve, reject, timer });
      try { writeLine(state.socket, { id, token: entry.token, command, params, timeoutMs }); }
      catch (error) { clearTimeout(timer); state.pending.delete(id); reject(error); }
    });
  }
  disconnect(id) { this.sockets.get(id)?.socket.destroy(); this.sockets.delete(id); }
  close() { for (const id of this.sockets.keys()) this.disconnect(id); }
}
