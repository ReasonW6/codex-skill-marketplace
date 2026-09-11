import { spawn } from 'node:child_process';
import { LineDecoder } from '../server/wire.mjs';

export class CodexTestClient {
  constructor(cli, cwd, env, { mcpApps = true } = {}) { this.cli = cli; this.cwd = cwd; this.env = env; this.mcpApps = mcpApps; this.pending = new Map(); this.next = 0; this.logs = ''; }
  async start() {
    this.child = spawn(this.cli, ['app-server', '--stdio'], { cwd: this.cwd, env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new LineDecoder(20 * 1024 * 1024);
    this.child.stderr.on('data', data => { this.logs = (this.logs + data.toString()).slice(-20000); });
    this.child.stdout.on('data', data => decoder.push(data));
    this.child.on('exit', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Test app-server exited.')); } this.pending.clear(); });
    decoder.on('message', message => {
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(Error(JSON.stringify(message.error))); else pending.resolve(message.result);
    });
    this.info = await this.rpc('initialize', { clientInfo: { name: 'zen-connection-user-flow', version: '0.4.0' }, capabilities: { experimentalApi: true,
      ...(this.mcpApps ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html', 'text/html;profile=mcp-app'] } } } : {}) } });
    const started = await this.rpc('thread/start', { cwd: this.cwd, ephemeral: true, experimentalRawEvents: false }); this.threadId = started.thread.id;
    const status = await this.rpc('mcpServerStatus/list', { threadId: this.threadId, detail: 'full' });
    this.server = status.data.find(server => Object.values(server.tools || {}).some(tool => tool.name === 'zen_connection'));
    if (!this.server) throw Error('The bundled Zen MCP did not start. ' + this.logs.slice(-3000));
    return this;
  }
  rpc(method, params = {}, timeout = 45000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(method + ' timed out. ' + this.logs.slice(-2000))); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  tool(name, args = {}) { return this.rpc('mcpServer/tool/call', { server: this.server.name, threadId: this.threadId, tool: name, arguments: args }); }
  resource(uri) { return this.rpc('mcpServer/resource/read', { server: this.server.name, threadId: this.threadId, uri }); }
  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    const exited = new Promise(resolve => this.child.once('exit', resolve)); this.child.stdin.end();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill(); }, 8000);
    await exited; clearTimeout(timer);
  }
}
