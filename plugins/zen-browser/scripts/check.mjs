import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let checked = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (/\.(?:mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', name], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
      checked++;
    } else if (entry.name.endsWith('.json')) { JSON.parse(await readFile(name, 'utf8')); checked++; }
  }
}
await walk(root);
for (const name of ['.mcp.json', '.codex-plugin/plugin.json']) JSON.parse(await readFile(path.join(root, name), 'utf8'));
console.log(`Syntax and JSON checks passed (${checked + 2} files).`);
