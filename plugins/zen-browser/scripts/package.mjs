import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
// Small, deterministic, uncompressed ZIPs keep packaging dependency-free.
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(data) { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
async function files(dir, prefix = '') {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (['dist', '.artifacts', 'node_modules'].includes(entry.name)) continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(path.join(dir, entry.name), rel + '/'));
    else if (entry.isFile()) result.push({ name: rel, data: await readFile(path.join(dir, entry.name)) });
  }
  return result;
}
export function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = entry.data, crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const body = Buffer.concat(local), directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}
const out = path.join(root, 'dist');
await mkdir(out, { recursive: true });
const extension = zip(await files(path.join(root, 'extension')));
const plugin = zip((await files(root)).map(entry => ({ ...entry, name: `zen-browser/${entry.name}` })));
const artifacts = [ [`zen-browser-extension-${version}-unsigned.xpi`, extension], [`zen-browser-${version}.zip`, plugin] ];
const hashes = [];
for (const [name, data] of artifacts) {
  await writeFile(path.join(out, name), data);
  const sha256 = createHash('sha256').update(data).digest('hex');
  hashes.push(`${sha256}  ${name}`);
  console.log(JSON.stringify({ path: path.join(out, name), bytes: data.length, sha256, signing: 'NotSigned' }));
}
await writeFile(path.join(out, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
