import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
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
const hashFile = async name => createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
const runtime = JSON.parse(await readFile(path.join(root, 'runtime/manifest.json'), 'utf8'));
if (await hashFile('runtime/node.exe') !== runtime.sha256) throw new Error('Bundled Node runtime integrity check failed.');
if (await hashFile('runtime/LICENSE.node.txt') !== runtime.licenseSha256) throw new Error('The complete upstream Node license changed.');
for (const helper of JSON.parse(await readFile(path.join(root, 'bin/manifest.json'), 'utf8'))) {
  if (await hashFile('bin/' + helper.file) !== helper.sha256 || await hashFile(helper.source) !== helper.sourceSha256)
    throw new Error('Bundled Windows helper or its source changed: ' + helper.file + '. Maintainers must rebuild the helpers.');
}
console.log(`Syntax and JSON checks passed (${checked + 2} files).`);
