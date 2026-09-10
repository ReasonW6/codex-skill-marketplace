import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { startHost } from '../server/native-host.mjs';
import { NativeDecoder, nativeFrame, LineDecoder } from '../server/wire.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function fixture(t, nativeDriver) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'reasonw6-zen-host-test-'));
  const input = new PassThrough(), output = new PassThrough();
  const host = await startHost({ input, output, home, nativeDriver });
  const messages = [], decoder = new NativeDecoder();
  decoder.on('message', message => messages.push(message)); output.on('data', chunk => decoder.push(chunk));
  input.write(nativeFrame({ type: 'hello', version: 1, browser: { name: 'test' } }));
  let entry;
  for (let i = 0; i < 50; i++) {
    try { entry = JSON.parse(await readFile(path.join(home, 'connections', `${host.id}.json`), 'utf8')); break; } catch { await tick(); }
  }
  assert.ok(entry);
  assert.deepEqual(messages.shift(), { type: 'native-ready', available: !!nativeDriver });
  t.after(async () => { input.end(); await host.close(); });
  return { host, input, messages, entry, home };
}
async function connect(endpoint) {
  const socket = net.createConnection(endpoint); await once(socket, 'connect');
  const decoder = new LineDecoder(), replies = [];
  decoder.on('message', message => replies.push(message)); socket.on('data', chunk => decoder.push(chunk));
  return { socket, replies, send: message => socket.write(JSON.stringify(message) + '\n') };
}
async function until(predicate) { for (let i = 0; i < 250; i++) { if (predicate()) return; await tick(); } assert.fail('Timed out awaiting protocol evidence'); }

test('native host rejects unauthenticated pipes and relays authenticated requests', async t => {
  const f = await fixture(t);
  const bad = await connect(f.host.endpoint); bad.send({ token: 'wrong', id: 'bad', command: 'tabs' });
  await once(bad.socket, 'close'); assert.equal(f.messages.length, 0);
  const good = await connect(f.host.endpoint); t.after(() => good.socket.destroy());
  good.send({ token: f.entry.token, id: 'client-1', command: 'tabs' });
  await until(() => f.messages.length > 0);
  const request = f.messages[0]; assert.equal(request.command, 'tabs'); assert.ok(request.sessionId); assert.notEqual(request.id, 'client-1');
  f.input.write(nativeFrame({ type: 'response', id: request.id, result: { tabs: [{ tabId: 42 }] } }));
  await until(() => good.replies.length > 0);
  assert.deepEqual(good.replies[0], { id: 'client-1', result: { tabs: [{ tabId: 42 }] } });
});
test('different clients get distinct sessions; disconnect cancels pending work and releases claims', async t => {
  const f = await fixture(t), a = await connect(f.host.endpoint), b = await connect(f.host.endpoint);
  t.after(() => { a.socket.destroy(); b.socket.destroy(); });
  a.send({ token: f.entry.token, id: 'same-id', command: 'fill', params: { tabId: 2 } });
  b.send({ token: f.entry.token, id: 'same-id', command: 'tabs' });
  await until(() => f.messages.length === 2);
  assert.notEqual(f.messages[0].sessionId, f.messages[1].sessionId);
  a.socket.destroy();
  await until(() => f.messages.some(m => m.type === 'release'));
  assert.ok(f.messages.some(m => m.type === 'cancel' && m.id === f.messages[0].id));
  assert.equal(f.messages.find(m => m.type === 'release').sessionId, f.messages[0].sessionId);
});
test('timeout cancels a queued operation and late responses are ignored', async t => {
  const f = await fixture(t), client = await connect(f.host.endpoint); t.after(() => client.socket.destroy());
  client.send({ token: f.entry.token, id: 'slow', command: 'click', timeoutMs: 1000 });
  await until(() => client.replies.length > 0);
  assert.equal(client.replies[0].error.code, 'TIMEOUT');
  assert.ok(f.messages.some(m => m.type === 'cancel'));
  f.input.write(nativeFrame({ type: 'response', id: f.messages[0].id, result: { clicked: true } }));
  await tick(); assert.equal(client.replies.length, 1);
});
test('a native permit is tied to its owned request and can be consumed only once',async t=>{
  const executed=[];const driver={execute:async(...args)=>{executed.push(args);return{native:true};},cancel(){},async close(){}};
  const f=await fixture(t,driver),client=await connect(f.host.endpoint);t.after(()=>client.socket.destroy());
  client.send({token:f.entry.token,id:'owned',command:'click',params:{tabId:8}});await until(()=>f.messages.some(m=>m.type==='request'));
  const request=f.messages.find(m=>m.type==='request');
  const native={type:'native-request',id:'native-1',requestId:request.id,sessionId:request.sessionId,tabId:8,plan:{command:'click'},lease:{},deadline:Date.now()+1000};
  f.input.write(nativeFrame({...native,sessionId:'another-session'}));await until(()=>f.messages.some(m=>m.type==='native-response'));
  assert.equal(executed.length,0);assert.equal(f.messages.find(m=>m.type==='native-response').error.code,'NATIVE_NOT_AUTHORIZED');
  f.input.write(nativeFrame(native));await until(()=>executed.length===1);await tick();
  f.input.write(nativeFrame({...native,id:'duplicate'}));await tick();assert.equal(executed.length,1);
  assert.equal(f.messages.find(m=>m.id==='duplicate').error.code,'NATIVE_NOT_AUTHORIZED');
});
