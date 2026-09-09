import { EventEmitter } from 'node:events';

export const MAX_REQUEST = 512 * 1024;
export const MAX_RESPONSE = 20 * 1024 * 1024;

// Native Messaging is UTF-8 JSON preceded by its byte length, not character count.
export function nativeFrame(value, limit = MAX_REQUEST) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > limit) throw new Error('MESSAGE_TOO_LARGE');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class NativeDecoder extends EventEmitter {
  buffer = Buffer.alloc(0);
  constructor(limit = MAX_RESPONSE) { super(); this.limit = limit; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (!size || size > this.limit) throw new Error('INVALID_NATIVE_FRAME');
      if (this.buffer.length < size + 4) return;
      const body = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      this.emit('message', JSON.parse(body.toString('utf8')));
    }
  }
  finish() { if (this.buffer.length) throw new Error('TRUNCATED_NATIVE_FRAME'); }
}

export class LineDecoder extends EventEmitter {
  buffer = Buffer.alloc(0);
  constructor(limit = MAX_REQUEST) { super(); this.limit = limit; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > this.limit) throw new Error('MESSAGE_TOO_LARGE');
      const line = this.buffer.subarray(0, end).toString('utf8').trim();
      this.buffer = this.buffer.subarray(end + 1);
      if (line) this.emit('message', JSON.parse(line));
    }
    if (this.buffer.length > this.limit) throw new Error('MESSAGE_TOO_LARGE');
  }
}

export function writeLine(stream, value) {
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > MAX_RESPONSE) throw new Error('MESSAGE_TOO_LARGE');
  if (!stream.destroyed) stream.write(line);
}

export function failure(error, fallback = 'BRIDGE_ERROR') {
  return { code: typeof error?.code === 'string' ? error.code : fallback,
    message: String(error?.message || error).slice(0, 2000) };
}
