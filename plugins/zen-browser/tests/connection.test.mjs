import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { ConnectionManager } from '../server/connection-manager.mjs';
import { chooseProfile, readProfiles } from '../server/profiles.mjs';
import { CONNECTION_TOOLS, CONNECTION_RESOURCE, connectionResult } from '../server/connection-tools.mjs';
import { recommendedPreferencesDisabled } from '../server/launch-zen.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture({ locked = false, owned = false, healthy = true, installed = false, launchFailure = false, launchWait = false, launchReason = 'onboarding', closeDeclined = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zen-connection-unit-'));
  const roaming = path.join(root, 'roaming'), profile = path.join(roaming, 'zen', 'Profiles', 'existing');
  const home = path.join(root, 'bridge'), binary = path.join(root, 'Zen', 'zen.exe');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(roaming, 'zen', 'profiles.ini'), '[Profile0]\nName=Existing\nIsRelative=1\nPath=Profiles/existing\nDefault=1\n');
  const calls = [], buildId = 'a'.repeat(64), entries = [];
  const state = { locked, manifest: installed ? path.join(home, 'host.json') : null, healthy, sourceChanged: false };
  const receipt = { buildId, healthy, receipt: path.join(home, 'install-20260101-000000-000.json'), extensionPath: path.join(home, 'extension') };
  const manager = new ConnectionManager({ home, roaming, connections: async () => entries,
    lock: async () => { calls.push('lock'); return () => calls.push('unlock'); },
    platform: async request => {
      if (request.action === 'profile-catalog') return { source: await readFile(path.join(roaming, 'zen', 'profiles.ini'), 'utf8') };
      if (request.action === 'inspect') return { binaries: [{ path: binary, version: '1.22b' }], processes: [], currentManifest: state.manifest,
        profiles: [{ path: profile, exists: true, locked: state.locked, recommendedPreferencesDisabled: await recommendedPreferencesDisabled(profile), processes: owned && state.locked ? [{ pid: process.pid, started: '123', binary, profile }] : [] }] };
      if (request.action === 'profile-state') return { locked: state.locked };
      calls.push(request.action);
      if (request.action === 'install') { await mkdir(home, { recursive: true }); state.manifest = path.join(home, 'host.json'); state.healthy = true; return receipt; }
      if (request.action === 'prepare-profile') { await writeFile(path.join(profile, 'user.js'), 'user_pref("remote.prefs.recommended", false);\n'); return { receipt: path.join(home, 'profile-receipt.json'), preferenceChanged: true }; }
      if (request.action === 'close-profile') {
        if (closeDeclined) throw Object.assign(Error('The browser has not finished exiting.'), { code: 'CLOSE_DECLINED' });
        state.locked = false; return { requested: true };
      }
      if (request.action === 'restore-host') { state.manifest = null; return { restored: true }; }
      return { restored: true };
    },
    launch: async options => {
      calls.push('launch');
      if (launchFailure) throw Object.assign(Error('Simulated browser startup failure'), { code: 'NATIVE_UNAVAILABLE' });
      if (launchWait) await options.onWaitingForBrowser({ launchRecord: path.join(home, 'launches', 'test.json'), reason: launchReason });
      await mkdir(path.join(home, 'launches'), { recursive: true });
      const launchRecord = path.join(home, 'launches', 'test.json');
      await writeFile(launchRecord, JSON.stringify({ ready: true, browserPid: process.pid, profile }));
      entries.push({ id: 'test-browser', extensionVersion: '0.4.0', nativeInput: true, launchRecord }); state.locked = true;
      return { extensionVersion: '0.4.0', launchRecord };
    }
  });
  manager.version = async () => '0.4.0'; manager.buildId = async () => buildId;
  manager.installed = async () => state.manifest ? { ...receipt, healthy: state.healthy } : null;
  return { manager, state, calls, home, profile, roaming, entries };
}

test('profile discovery chooses only an unambiguous existing, accessible profile', async () => {
  const profiles = [{ id: 'a', exists: true, isDefault: true }, { id: 'b', exists: true }];
  assert.equal(chooseProfile(profiles), 'a');
  profiles[1].locked = true; assert.equal(chooseProfile(profiles), 'b');
  profiles[0].locked = true; assert.equal(chooseProfile(profiles), null);
  assert.equal(chooseProfile(profiles, 'a'), 'a');
  profiles[0].accessible = false; assert.equal(chooseProfile(profiles, 'a'), 'b');
  profiles[1].locked = false; profiles[0].accessible = true; profiles[0].locked = false; profiles[0].isDefault = false;
  assert.equal(chooseProfile(profiles), null);
  const f = await fixture(); const found = await readProfiles(f.roaming);
  assert.equal(found.profiles.length, 1); assert.equal(found.profiles[0].path, f.profile);
});

test('discovery and confirmation preview are read-only and expose no script setup', async () => {
  const f = await fixture();
  const state = await f.manager.state({ refresh: true }), plan = await f.manager.plan({});
  assert.equal(state.status, 'disconnected'); assert.equal(state.canConnect, true);
  assert.equal(plan.public.needsConfirmation, true); assert.equal(plan.public.needsRestart, false);
  assert.deepEqual(f.calls, []); assert.equal(await stat(f.home).then(() => true, () => false), false);
  assert.equal(await stat(path.join(f.profile, 'user.js')).then(() => true, () => false), false);
});

test('the UI advertises a real MCP resource and keeps mutation helpers app-only', () => {
  assert.equal(CONNECTION_TOOLS[0]._meta.ui.resourceUri, CONNECTION_RESOURCE);
  assert.equal(CONNECTION_TOOLS[0]._meta['openai/ui'].entrypoints[0].quickAction.target.name, 'zen_connection');
  for (const tool of CONNECTION_TOOLS.slice(1)) assert.deepEqual(tool._meta.ui.visibility, ['app']);
  const state = { status: 'disconnected', reason: 'Connect', diagnostics: { profile: 'private path' } };
  const result = connectionResult(state);
  assert.equal(result._meta.uiState, state); assert.ok(!result.content[0].text.includes('private path'));
});

test('confirmation is one-use and an unrecognized or expired ticket cannot mutate', async () => {
  const f = await fixture();
  await assert.rejects(f.manager.apply('invented'), { code: 'CONFIRMATION_EXPIRED' });
  const expired = await f.manager.plan({}); f.manager.tickets.get(expired.token).expires = 0;
  await assert.rejects(f.manager.apply(expired.token), { code: 'CONFIRMATION_EXPIRED' });
  assert.deepEqual(f.calls, []);
  const plan = await f.manager.plan({}); await f.manager.apply(plan.token); await f.manager.job.promise;
  await assert.rejects(f.manager.apply(plan.token), { code: 'CONFIRMATION_EXPIRED' });
  assert.equal((await f.manager.state()).status, 'connected');
  assert.deepEqual(f.calls, ['lock', 'install', 'prepare-profile', 'launch', 'unlock']);
});

for (const change of ['profile lock', 'profile catalog', 'native registration']) test('a changed ' + change + ' invalidates the reviewed plan before mutation', async () => {
  const f = await fixture(), plan = await f.manager.plan({});
  if (change === 'profile lock') f.state.locked = true;
  if (change === 'profile catalog') await writeFile(path.join(f.roaming, 'zen', 'profiles.ini'), '[Profile0]\nName=Changed\nIsRelative=1\nPath=Profiles/existing\n');
  if (change === 'native registration') f.state.manifest = 'a different registration';
  await f.manager.apply(plan.token); await f.manager.job.promise;
  assert.equal(f.manager.lastError.code, 'BROWSER_CHANGED');
  assert.deepEqual(f.calls, ['lock', 'unlock']);
});

test('ordinary running profiles with unproven process identity require manual normal exit', async () => {
  const f = await fixture({ locked: true }), plan = await f.manager.plan({});
  assert.equal(plan.public.manualExit, true); assert.equal(plan.public.needsRestart, true);
  await f.manager.apply(plan.token);
  while (f.manager.job.phase !== 'waiting_exit') await delay(10);
  assert.equal((await f.manager.state()).canCancel, true);
  await f.manager.cancel(); await f.manager.job.promise;
  assert.equal(f.calls.includes('close-profile'), false); assert.equal(f.calls.includes('prepare-profile'), false);
  assert.equal(f.state.locked, true); assert.equal((await f.manager.state()).status, 'disconnected');
  assert.equal((await f.manager.state()).canRollback, true);
});

test('an explicitly identified running profile closes only after confirmation and then reconnects', async () => {
  const f = await fixture({ locked: true, owned: true }), plan = await f.manager.plan({});
  assert.equal(plan.public.manualExit, false); assert.deepEqual(f.calls, []);
  await f.manager.apply(plan.token); await f.manager.job.promise;
  assert.ok(f.calls.indexOf('close-profile') < f.calls.indexOf('prepare-profile'));
  assert.equal((await f.manager.state()).status, 'connected');
});

test('a failed launch retains rollback records and reports failure with a usable retry', async () => {
  const f = await fixture({ launchFailure: true }), plan = await f.manager.plan({});
  await f.manager.apply(plan.token); await f.manager.job.promise;
  const state = await f.manager.state(), settings = JSON.parse(await readFile(path.join(f.home, 'connection-settings.json'), 'utf8'));
  assert.equal(state.status, 'failed'); assert.equal(state.error.code, 'NATIVE_UNAVAILABLE');
  assert.equal(state.canConnect, true); assert.equal(state.canRollback, true);
  assert.ok(settings.pending.setupReceipt); assert.ok(settings.pending.installReceipt); assert.equal(settings.pending.pid, undefined);
});

test('a detected damaged runtime stays failed across normal UI polls until repair', async () => {
  const f = await fixture(), plan = await f.manager.plan({});
  await f.manager.apply(plan.token); await f.manager.job.promise;
  f.state.healthy = false;
  assert.equal((await f.manager.state({ refresh: true })).error.code, 'RUNTIME_INTEGRITY');
  const polled = await f.manager.state(); assert.equal(polled.status, 'failed'); assert.equal(polled.canConnect, true);
});

test('an old extension requires a reviewed restart instead of silently reusing its channel', async () => {
  const f = await fixture(), first = await f.manager.plan({});
  await f.manager.apply(first.token); await f.manager.job.promise;
  f.entries[0].extensionVersion = '0.3.0';
  const state = await f.manager.state({ refresh: true }); assert.equal(state.status, 'disconnected'); assert.equal(state.updateAvailable, true);
  const plan = await f.manager.plan({}); assert.equal(plan.public.needsRestart, true); assert.equal(plan.public.needsConfirmation, true);
});

test('first-run completion waits for its own UI ticket and does not claim connection early', async () => {
  const f = await fixture({ launchWait: true }), plan = await f.manager.plan({});
  await f.manager.apply(plan.token);
  while (!f.manager.job.browserReadyTicket) await delay(10);
  const state = await f.manager.state();
  assert.equal(state.status, 'connecting'); assert.equal(state.connectionId, null); assert.ok(state.browserReadyTicket);
  assert.throws(() => f.manager.resume('invented'), { code: 'CONFIRMATION_EXPIRED' });
  await f.manager.resume(state.browserReadyTicket); await f.manager.job.promise;
  assert.equal((await f.manager.state()).status, 'connected');
  assert.throws(() => f.manager.resume(state.browserReadyTicket), { code: 'CONFIRMATION_EXPIRED' });
});

test('cancelling browser onboarding cannot continue into a usable connection', async () => {
  const f = await fixture({ launchWait: true }), plan = await f.manager.plan({});
  await f.manager.apply(plan.token);
  while (!f.manager.job.browserReadyTicket) await delay(10);
  await f.manager.cancel(); await f.manager.job.promise;
  assert.equal(f.manager.lastError.code, 'CONNECTION_CANCELLED'); assert.deepEqual(f.entries, []);
  assert.equal((await f.manager.state()).canRollback, true);
});

test('a browser that has not finished closing is allowed to exit normally without another close request', async () => {
  const f = await fixture({ locked: true, owned: true, closeDeclined: true });
  await f.manager.apply((await f.manager.plan({})).token);
  for (let i = 0; i < 30 && f.manager.job.phase !== 'waiting_exit'; i++) await delay(20);
  assert.equal(f.manager.job.phase, 'waiting_exit');
  assert.equal(f.calls.filter(call => call === 'close-profile').length, 1);
  assert.ok(!f.calls.includes('prepare-profile') && !f.calls.includes('launch'));
  f.state.locked = false;
  await f.manager.job.promise;
  assert.equal((await f.manager.state()).status, 'connected');
});

test('window activation is an explicit UI acknowledgement before connection is claimed', async () => {
  const f = await fixture({ launchWait: true, launchReason: 'activate' });
  await f.manager.apply((await f.manager.plan({})).token);
  for (let i = 0; i < 30 && !f.manager.job.browserReadyTicket; i++) await delay(20);
  const waiting = await f.manager.state();
  assert.equal(waiting.status, 'connecting');
  assert.match(waiting.reason, /点击刚打开的 Zen 窗口/);
  assert.equal(waiting.browserReadyLabel, '窗口已打开，继续连接');
  assert.equal(waiting.connectionId, null);
  f.manager.resume(waiting.browserReadyTicket);
  await f.manager.job.promise;
  assert.equal((await f.manager.state()).status, 'connected');
});

test('profile parsing uses the desktop catalog when the caller sees different local file contents', async () => {
  const f = await fixture();
  const desktop = '[Profile0]\nName=Desktop catalog\nIsRelative=1\nPath=Profiles/desktop-profile\nDefault=1\n';
  const selected = await readProfiles(f.roaming, desktop);
  assert.equal(selected.profiles[0].name, 'Desktop catalog');
  assert.equal(selected.profiles[0].path, path.join(f.roaming, 'zen', 'Profiles', 'desktop-profile'));
  assert.deepEqual(await readProfiles(f.roaming, null), { profiles: [], sourceHash: null });
});

test('a changed connection preference invalidates confirmation before any setup or close', async () => {
  const f = await fixture();
  const plan = await f.manager.plan({});
  await writeFile(path.join(f.profile, 'user.js'), 'user_pref("remote.prefs.recommended", false);\n');
  await f.manager.apply(plan.token); await f.manager.job.promise;
  assert.equal((await f.manager.state()).error.code, 'BROWSER_CHANGED');
  assert.deepEqual(f.calls, ['lock', 'unlock']);
});
