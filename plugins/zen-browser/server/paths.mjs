import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';

export const EXTENSION_ID = 'zen-browser@reasonw6.github.io';
export const HOST_NAME = 'io.github.reasonw6.zen_browser';
export function dataHome() {
  return process.env.ZEN_BRIDGE_HOME || path.join(os.homedir(), '.zen-browser');
}
export async function connectionDir(home = dataHome()) {
  const dir = path.join(home, 'connections');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export async function discover(home = dataHome()) {
  let names;
  const dir = path.join(home, 'connections');
  try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const name of names) {
    if (!/^[\da-f-]{36}\.json$/.test(name)) continue;
    try {
      const entry = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (entry.version !== 1 || entry.id + '.json' !== name || !/^[\da-f]{64}$/.test(entry.token)) continue;
      if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue;
      // An orphaned discovery file is never enough to authorize a connection.
      process.kill(entry.pid, 0);
      result.push(entry);
    } catch { /* A dead host or partially written entry is not a usable browser. */ }
  }
  return result;
}
