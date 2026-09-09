import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDecoder, nativeFrame, LineDecoder, MAX_REQUEST } from '../server/wire.mjs';
import { validate, TOOLS } from '../server/tools.mjs';

test('native protocol handles partial headers, multibyte text and coalesced messages', () => {
  const input = Buffer.concat([nativeFrame({ text: '选宝 🌧️' }), nativeFrame({ count: 42 })]);
  const decoder = new NativeDecoder(), messages = [];
  decoder.on('message', message => messages.push(message));
  for (const byte of input) decoder.push(Buffer.from([byte]));
  decoder.finish();
  assert.deepEqual(messages, [{ text: '选宝 🌧️' }, { count: 42 }]);
});
test('native frames reject zero, oversized, malformed and truncated input', () => {
  for (const size of [0, 30 * 1024 * 1024]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(size);
    assert.throws(() => new NativeDecoder().push(header), /INVALID_NATIVE_FRAME/);
  }
  const partial = new NativeDecoder(); partial.push(Buffer.from([1]));
  assert.throws(() => partial.finish(), /TRUNCATED/);
  assert.throws(() => nativeFrame({ text: 'x'.repeat(MAX_REQUEST) }), /MESSAGE_TOO_LARGE/);
});
test('line protocol preserves Unicode split across chunks and enforces byte limits', () => {
  const decoder = new LineDecoder(100), messages = [];
  decoder.on('message', message => messages.push(message));
  for (const byte of Buffer.from('{"text":"雨瑶"}\n\n{"ok":true}\n')) decoder.push(Buffer.from([byte]));
  assert.deepEqual(messages, [{ text: '雨瑶' }, { ok: true }]);
  assert.throws(() => new LineDecoder(2).push(Buffer.from('abc')), /MESSAGE_TOO_LARGE/);
});
test('tool validation rejects extra fields, invalid IDs and oversized inputs', () => {
  const fill = TOOLS.find(t => t.name === 'zen_fill').inputSchema;
  validate(fill, { tabId: 3, ref: 'snapshot:1', text: '' });
  validate(fill, { tabId: 3, frameId: 4294967297, selector: 'input', text: 'Firefox frame' });
  for (const args of [{ tabId: -1, text: 'a' }, { tabId: 1, text: 'a', activate: true }, { tabId: '1', text: 'a' }, { tabId: 1, text: 'x'.repeat(100001) }]) assert.throws(() => validate(fill, args));
});
