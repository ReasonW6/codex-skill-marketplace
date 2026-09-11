import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startMcp } from '../server/mcp.mjs';
import { LineDecoder } from '../server/wire.mjs';

function fixture({ connectionManager } = {}) {
  const input = new PassThrough(), output = new PassThrough(), decoder = new LineDecoder();
  const calls = [], replies = new Map(), waiting = new Map(); let id = 0;
  const client = { connections: async () => [], close: () => calls.push('close'), request: async (command, params) => {
    calls.push({ command, params });
    if (command === 'screenshot') return { tabId: 2, dataUrl: 'data:image/png;base64,aGVsbG8=' };
    if (command === 'fill') throw Object.assign(new Error('Target was replaced'), { code: 'STALE_REF' });
    return { tabs: [] };
  } };
  startMcp({ input, output, client, ...(connectionManager ? { connectionManager } : {}) });
  decoder.on('message', message => {
    if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    else replies.set(message.id, message);
  });
  output.on('data', chunk => decoder.push(chunk));
  function response(key) { if (replies.has(key)) { const result = replies.get(key); replies.delete(key); return Promise.resolve(result); } return new Promise(resolve => waiting.set(key, resolve)); }
  return { input, calls, response, rpc(method, params = {}) {
    const key = ++id; input.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n'); return response(key);
  } };
}
test('MCP initialization, tool discovery, protocol errors and notifications', async () => {
  const f = fixture();
  assert.equal((await f.rpc('tools/list')).error.code, -32002);
  const initialized = await f.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  f.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const list = await f.rpc('tools/list'); assert.equal(list.result.tools.length, 25);
  assert.ok(list.result.tools.every(t => !('command' in t) && t.inputSchema.additionalProperties === false));
  assert.equal((await f.rpc('unknown')).error.code, -32601);
  assert.equal((await f.rpc('tools/call', { name: 'unknown' })).error.code, -32602);
  f.input.end();
});
test('MCP reports tool errors without transport failure and returns image blocks', async () => {
  const f = fixture(); await f.rpc('initialize');
  const invalid = await f.rpc('tools/call', { name: 'zen_fill', arguments: { tabId: '2', text: 'x' } });
  assert.equal(invalid.result.isError, true); assert.equal(f.calls.length, 0);
  const failed = await f.rpc('tools/call', { name: 'zen_fill', arguments: { tabId: 2, text: 'x', ref: 'a' } });
  assert.equal(JSON.parse(failed.result.content[0].text).code, 'STALE_REF');
  const captured = await f.rpc('tools/call', { name: 'zen_screenshot', arguments: { tabId: 2 } });
  assert.equal(captured.result.content[0].type, 'image'); assert.equal(captured.result.content[0].mimeType, 'image/png');
  f.input.end();
});
test('MCP rejects malformed JSON and recovers for the next request', async () => {
  const f = fixture(); f.input.write('not JSON\n');
  assert.equal((await f.response(null)).error.code, -32700);
  assert.deepEqual((await f.rpc('ping')).result, {}); f.input.end();
});

test('the MCP can provide a local connection page without setup even when a client advertises UI support', async () => {
  let reads = 0;
  const manager = { state: async () => { reads++; return { status: 'disconnected', reason: 'Awaiting user review' }; }, close() {} };
  const f = fixture({ connectionManager: manager });
  try {
    await f.rpc('initialize', { capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } } });
    const inline = await f.rpc('tools/call', { name: 'zen_connection', arguments: {} });
    assert.equal(inline.result.structuredContent.connectionPage, undefined);
    const local = await f.rpc('tools/call', { name: 'zen_connection', arguments: { localPage: true } });
    assert.match(local.result.structuredContent.connectionPage, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/$/);
    assert.equal((await fetch(local.result.structuredContent.connectionPage)).status, 200);
    assert.equal(reads, 2);
  } finally { f.input.end(); }
});
