import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { invokeConnectionTool } from './connection-tools.mjs';
import { failure } from './wire.mjs';

// Compatibility view for MCP clients that do not advertise MCP Apps. Opening a
// URL is the user's action; initialization never opens a browser or writes files.
export class ConnectionPage {
  constructor(manager, source) { this.manager = manager; this.source = source; }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.listen().catch(error => { this.starting = null; throw error; });
    return this.starting;
  }
  async listen() {
    const component = await readFile(path.join(this.source, 'ui', 'connection.html'), 'utf8');
    const token = randomBytes(32).toString('hex'), prefix = '/' + token + '/';
    const script = `const frame=document.querySelector('#app');
window.addEventListener('message',async event=>{
  if(event.source!==frame.contentWindow||event.origin!==location.origin||event.data?.jsonrpc!=='2.0')return;
  const message=event.data;
  if(message.method==='ui/notifications/size-changed'){frame.style.height=Math.max(480,Math.min(1600,Number(message.params?.height)||640))+'px';return;}
  if(message.id===undefined)return;
  let result,error;
  try{
    if(message.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'Zen Browser local connection page',version:'0.4.0'},hostCapabilities:{serverTools:{}},hostContext:{theme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}};
    else if(message.method==='tools/call'){
      const reply=await fetch(${JSON.stringify(prefix + 'rpc')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message.params)});
      if(!reply.ok)throw Error('连接页面已过期或不可用。请在 Codex 中重新打开“连接 Zen”。');
      result=await reply.json();
    }else throw Error('Unsupported connection page request.');
  }catch(cause){error={code:-32603,message:cause.message};}
  frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result,error},location.origin);
});`;
    const wrapper = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Zen · 本地页面</title><style>:root{color-scheme:light dark}body{margin:0;background:#f2f4f2;font:13px/1.6 system-ui;color:#67706a}main{max-width:642px;margin:22px auto}p{padding:0 16px}iframe{display:block;border:1px solid #e0e5e1;border-radius:14px;width:100%;height:640px;box-sizing:border-box;background:white}@media(prefers-color-scheme:dark){body{background:#181c19;color:#b5bdb6}iframe{border-color:#3c443d;background:#202320}}</style><main><p>此连接页仅在本机运行。连接完成后可以关闭页面。</p><iframe id="app" title="Zen 连接设置" src="' + prefix + 'component"></iframe></main><script>' + script + '</script></html>';
    const policy = (html, ancestors) => {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'").join(' ');
      return "default-src 'none'; script-src " + scripts + "; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self'; frame-ancestors " + ancestors + "; base-uri 'none'; form-action 'none'";
    };
    const server = this.server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.headers.host !== this.authority || !request.url?.startsWith(prefix)) { response.writeHead(403).end(); return; }
      if (request.method === 'GET' && [prefix, prefix + 'component'].includes(request.url)) {
        const embedded = request.url.endsWith('component'), html = embedded ? component : wrapper;
        response.setHeader('Content-Security-Policy', policy(html, embedded ? "'self'" : "'none'"));
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return;
      }
      if (request.method !== 'POST' || request.url !== prefix + 'rpc') { response.writeHead(404).end(); return; }
      if (request.headers.origin !== this.origin || request.headers['content-type']?.split(';')[0] !== 'application/json') { response.writeHead(403).end(); return; }
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 65536) { response.writeHead(413).end(); return; } chunks.push(chunk); }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await invokeConnectionTool(message.name, message.arguments || {}, this.manager);
        response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(result));
      } catch (error) {
        if (response.writableEnded || response.destroyed) return;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: JSON.stringify(failure(error)) }] }));
      }
    });
    server.requestTimeout = 10000; server.headersTimeout = 5000; server.maxConnections = 16;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.authority = '127.0.0.1:' + server.address().port; this.origin = 'http://' + this.authority;
    this.url = this.origin + prefix;
    if (this.closed) { this.close(); throw Error('The Codex connection ended before the page opened.'); }
    return this.url;
  }
  close() { this.closed = true; if (this.server) { this.server.closeAllConnections(); this.server.close(); } }
}
