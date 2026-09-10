import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,writeFile,readFile,readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recommendedPreferencesDisabled } from '../server/launch-zen.mjs';

test('profile startup honors the last user.js override without editing files',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'zen-pref-read-'));
  const text='user_pref("remote.prefs.recommended", true);\nuser_pref("remote.prefs.recommended", false);\n';
  await writeFile(path.join(dir,'user.js'),text);assert.equal(await recommendedPreferencesDisabled(dir),true);assert.equal(await readFile(path.join(dir,'user.js'),'utf8'),text);
});
test('explicit profile setup and rollback preserve unrelated preferences',{skip:process.platform!=='win32'},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'zen-profile-setup-'));
  const original='// 原配置\nuser_pref("test.keep", "用户数据");\n';
  const before='user_pref("other.option", 42);\nuser_pref("remote.prefs.recommended", true);\n';
  await writeFile(path.join(dir,'user.js'),original);await writeFile(path.join(dir,'prefs.js'),before);
  const script=fileURLToPath(new URL('../scripts/configure-native-profile.ps1',import.meta.url));
  const run=(...args)=>spawnSync('pwsh.exe',['-NoProfile','-File',script,'-ProfilePath',dir,...args],{encoding:'utf8',windowsHide:true});
  const preview=run();assert.equal(preview.status,0,preview.stderr);assert.equal(await readFile(path.join(dir,'user.js'),'utf8'),original);
  const applied=run('-Apply');assert.equal(applied.status,0,applied.stderr);assert.equal(await recommendedPreferencesDisabled(dir),true);
  await writeFile(path.join(dir,'prefs.js'),before.replace('recommended", true','recommended", false')+'user_pref("later.option", 99);\n');
  const receipt=path.join(dir,(await readdir(dir)).find(n=>n.startsWith('zen-native-setup-')));
  const restored=run('-Apply','-RestoreReceipt',receipt);assert.equal(restored.status,0,restored.stderr);
  assert.equal(await readFile(path.join(dir,'user.js'),'utf8'),original);
  assert.equal(await readFile(path.join(dir,'prefs.js'),'utf8'),before+'user_pref("later.option", 99);\n');
});
