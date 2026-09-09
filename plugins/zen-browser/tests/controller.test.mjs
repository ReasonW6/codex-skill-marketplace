import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const sources = await Promise.all(['control-state.js', 'background.js'].map(file => readFile(new URL('../extension/' + file, import.meta.url), 'utf8')));
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = [], states = [], writes = [];
  const tabs = new Map([[1, { id: 1, windowId: 10, active: true, url: 'https://example.com/user', title: 'User', groupId: -1, splitViewId: -1 }],
    [2, { id: 2, windowId: 10, active: false, url: 'https://example.com/work', title: 'Work', groupId: -1, splitViewId: -1 }]]);
  const api = {
    tabs: {
      onActivated: event(), onRemoved: event(), onUpdated: event(),
      query: async () => [...tabs.values()], get: async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return { ...tabs.get(id) }; },
      create: async properties => { calls.push(['create', properties]); const tab = { id: 3, ...properties, groupId: -1, splitViewId: -1 }; tabs.set(3, tab); return tab; },
      group: async properties => { calls.push(['group', properties]); return 4; },
      update: async (id, properties) => { calls.push(['update', id, properties]); Object.assign(tabs.get(id), properties); return tabs.get(id); },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); api.tabs.onRemoved.emit(id); },
      captureTab: async id => { calls.push(['capture', id]); return 'data:image/png;base64,aGVsbG8='; },
      executeScript: async () => {}
    },
    tabGroups: { update: async (...args) => { calls.push(['group-state', ...args]); } },
    windows: { getAll: async () => [{ id: 10, focused: true, incognito: false }] },
    webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), getAllFrames: async () => [{ frameId: 0, url: 'https://example.com/work' }] },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
    runtime: { onMessage: event(), onConnect: event(), id: 'fixture', getURL: () => 'moz-extension://fixture/' },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} }
  };
  const context = vm.createContext({ URL, console, setTimeout, clearTimeout, crypto: webcrypto });
  sources.forEach(source => vm.runInContext(source, context));
  const controller = new context.ZenController(api);
  controller.port = { postMessage: message => replies.push(message), disconnect: () => {} };
  const replies = [], connectedPages = new Map(), deferred = [], deferredReads = [];
  let snapshot = 0, documents = 0, holdPrepare = false, holdReads = false, failure = null;
  controller.inject = async (tabId, selectedFrame) => {
    const frameId = selectedFrame ?? 0, key = tabId + ':' + frameId;
    if (connectedPages.has(key)) return;
    const documentId = 'document-' + key + ':' + (++documents);
    let pageState;
    const requests = new Map();
    const port = {
      name: 'zen-page-v2', sender: { id: 'fixture', tab: tabs.get(tabId), frameId, url: tabs.get(tabId).url },
      onMessage: event(), onDisconnect: event(), disconnect() { connectedPages.delete(key); this.onDisconnect.emit(); },
      postMessage(message) {
        if (message.type === 'state') { pageState = message.state; states.push(message.state); }
        if (message.type === 'command') {
          requests.set(message.id, message);
          if (!message.write) {
            const read = () => port.onMessage.emit({ type: 'result', id: message.id, result: message.command === 'snapshot'
              ? { snapshotId: 'snapshot-' + (++snapshot), documentId, text: 'Test page', elements: [] } : { found: true } });
            if (holdReads) deferredReads.push(read); else queueMicrotask(read);
          }
          else {
            const prepare = () => port.onMessage.emit({ type: 'authorize', id: message.id, documentId });
            if (holdPrepare) deferred.push(prepare); else queueMicrotask(prepare);
          }
        }
        if (message.type === 'permit') {
          const request = requests.get(message.id);
          if (!message.allowed || request.epoch !== pageState.epoch || !pageState.controlled) queueMicrotask(() => port.onMessage.emit({ type: 'result', id: message.id, error: message.error || { code: 'CONTROL_CHANGED', message: 'Page stopped' } }));
          else if (failure) queueMicrotask(() => port.onMessage.emit({ type: 'result', id: message.id, error: failure }));
          else { writes.push(request.command); queueMicrotask(() => port.onMessage.emit({ type: 'result', id: message.id, result: { executed: true } })); }
        }
      }
    };
    connectedPages.set(key, port); api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'hello', documentId });
  };
  const request = (command, params = {}, extras = {}) => ({ id: webcrypto.randomUUID(), command, params, sessionId: 'session-a', deadline: Date.now() + 5000,
    transportEpoch: controller.transportEpoch, tabEpoch: controller.store.capture(params.tabId), stopEpoch: controller.store.get(params.tabId)?.stopEpoch, ...extras });
  const run = (command, params, extras) => controller.execute(request(command, params, extras));
  return { controller, api, calls, tabs, states, writes, request, run, replies,
    hold: () => { holdPrepare = true; }, release: () => { holdPrepare = false; deferred.splice(0).forEach(fn => fn()); },
    holdReads: () => { holdReads = true; }, releaseReads: () => { holdReads = false; deferredReads.splice(0).forEach(fn => fn()); },
    setFailure: value => { failure = value; }, connectedPages };
}
test('selecting and watching retains control and permits real subsequent commands', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.run('snapshot', { tabId: 2 });
  f.tabs.get(2).active = true; f.api.tabs.onActivated.emit({ tabId: 2, windowId: 10 });
  await f.run('fill', { tabId: 2, selector: 'input', text: 'watched' });
  assert.equal(f.controller.store.get(2).owner, 'session-a'); assert.deepEqual(f.writes, ['fill']);
});
test('an explicitly selected visible tab can be attached without activation or focusing', async () => {
  const f = fixture(); await f.run('attach', { tabId: 1 }); await f.run('snapshot', { tabId: 1 }); await f.run('click', { tabId: 1, selector: 'button' });
  assert.deepEqual(f.writes, ['click']); assert.equal(f.calls.some(c => c[0] === 'update' && 'active' in c[2]), false);
});
test('new tabs are inactive, muted and marked in their own window', async () => {
  const f = fixture(); const tab = await f.run('open', { url: 'https://example.com/new', taskTitle: 'Test task' });
  assert.equal(tab.active, false); assert.equal(f.calls.find(c => c[0] === 'create')[1].muted, true);
  assert.equal(f.calls.find(c => c[0] === 'group')[1].createProperties.windowId, 10);
  assert.equal(tab.control.marking, 'native-group-and-title');
});
test('pinned and already-grouped tabs keep their existing layout', async () => {
  const f = fixture(); f.tabs.get(2).groupId = 42; await f.run('attach', { tabId: 2 });
  assert.equal(f.calls.some(c => c[0] === 'group'), false);
  assert.equal(f.controller.store.get(2).marking, 'title');
});
test('private, restricted and other-session tabs remain protected', async () => {
  const f = fixture(); f.tabs.get(2).incognito = true;
  await assert.rejects(f.run('attach', { tabId: 2 }), { code: 'PRIVATE_TAB' });
  f.tabs.get(2).incognito = false; f.tabs.get(2).url = 'about:config';
  await assert.rejects(f.run('attach', { tabId: 2 }), { code: 'RESTRICTED_URL' });
  f.tabs.get(2).url = 'https://example.com/'; await f.run('attach', { tabId: 2 });
  await assert.rejects(f.run('attach', { tabId: 2 }, { sessionId: 'session-b' }), { code: 'TAB_BUSY' });
});
test('initial writes require an observed document', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 });
  await assert.rejects(f.run('fill', { tabId: 2, selector: 'input', text: 'no' }), { code: 'OBSERVATION_REQUIRED' });
  assert.deepEqual(f.writes, []);
});
test('pause invalidates prepared writes before their commit permit', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.run('snapshot', { tabId: 2 }); f.hold();
  const write = f.run('click', { tabId: 2, selector: 'button' });
  const rejected = assert.rejects(write, { code: 'CONTROL_CHANGED' });
  await settle();
  const pause = f.controller.userControl(2, 'pause'); f.release(); await Promise.all([rejected, pause]);
  assert.deepEqual(f.writes, []); assert.equal(f.controller.store.get(2).state, 'paused');
});
test('pause followed by continue cannot replay an old queued write', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.run('snapshot', { tabId: 2 });
  const stale = f.request('fill', { tabId: 2, selector: 'input', text: 'stale' });
  await f.controller.userControl(2, 'pause'); await f.controller.userControl(2, 'resume');
  await assert.rejects(f.controller.execute(stale), { code: 'CONTROL_CHANGED' });
  await assert.rejects(f.run('fill', stale.params), { code: 'OBSERVATION_REQUIRED' });
  await f.run('snapshot', { tabId: 2 }); await f.run('fill', { tabId: 2, selector: 'input', text: 'new plan' });
  assert.deepEqual(f.writes, ['fill']);
});
test('re-attachment cannot bypass human takeover', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.controller.userControl(2, 'takeover');
  await f.run('attach', { tabId: 2 }); await f.run('snapshot', { tabId: 2 });
  await assert.rejects(f.run('click', { tabId: 2, selector: 'button' }), { code: 'CONTROL_STOPPED' });
  assert.equal(f.controller.store.get(2).state, 'user_control');
});
test('task completion is explicit and retains the result tab', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.run('snapshot', { tabId: 2 });
  await f.run('task', { tabId: 2, outcome: 'completed', message: 'Verified result' });
  assert.equal(f.controller.store.get(2).state, 'completed'); assert.equal(f.tabs.has(2), true);
  await assert.rejects(f.run('click', { tabId: 2, selector: 'button' }), { code: 'NOT_ATTACHED' });
});
test('operation failure is visible and is not retried automatically', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.run('snapshot', { tabId: 2 });
  f.setFailure({ code: 'ELEMENT_COVERED', message: 'Covered target' });
  await assert.rejects(f.run('click', { tabId: 2, selector: 'button' }), { code: 'ELEMENT_COVERED' });
  assert.equal(f.controller.store.get(2).state, 'failed'); assert.equal(f.controller.store.get(2).step.phase, 'failed');
  await assert.rejects(f.run('click', { tabId: 2, selector: 'button' }), { code: 'CONTROL_STOPPED' });
});
test('connection loss preserves presentation and requires a deliberate continuation', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 });
  f.controller.receive({ type: 'release', sessionId: 'session-a' });
  assert.equal(f.controller.store.get(2).state, 'waiting_user'); assert.equal(f.controller.store.get(2).owner, null);
  await f.run('attach', { tabId: 2 }, { sessionId: 'session-b' });
  assert.equal(f.controller.store.get(2).state, 'waiting_user');
  await assert.rejects(f.run('click', { tabId: 2, selector: 'button' }, { sessionId: 'session-b' }), { code: 'CONTROL_STOPPED' });
});
test('web content cannot send popup control messages', () => {
  const f = fixture();
  assert.equal(f.api.runtime.onMessage.emit({ type: 'popup-control', tabId: 2, action: 'resume' }, { id: 'fixture', tab: { id: 2 }, url: 'https://example.com' }), undefined);
  assert.equal(f.controller.store.records.size, 0);
});
test('a watched result tab cannot be closed by AI', async () => {
  const f = fixture(); await f.run('open', { url: 'https://example.com/new' }); await f.run('snapshot', { tabId: 3 }); f.tabs.get(3).active = true;
  await assert.rejects(f.run('close', { tabId: 3 }), { code: 'VISIBLE_TAB' }); assert.equal(f.tabs.has(3), true);
});
test('waiting for Continue times out without changing human control', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.controller.userControl(2, 'takeover');
  const result = await f.run('wait_for_control', { tabId: 2, timeoutMs: 100 });
  assert.equal(result.ready, false); assert.equal(f.controller.store.get(2).state, 'user_control'); assert.deepEqual(f.writes, []);
});
test('Continue wakes a pending control wait with a new document observation', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); const original = await f.run('snapshot', { tabId: 2 });
  await f.controller.userControl(2, 'pause');
  const waiting = f.run('wait_for_control', { tabId: 2, timeoutMs: 2000 }); await settle(); await f.controller.userControl(2, 'resume');
  const result = await waiting;
  assert.equal(result.ready, true); assert.notEqual(result.snapshot.snapshotId, original.snapshotId); assert.equal(result.snapshot.frames.length, 1);
  assert.equal(f.controller.store.get(2).frames.get(0).observed, true); assert.deepEqual(f.writes, []);
});
test('a read wait can follow expected navigation but cannot cross a human stop', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 });
  const request = f.request('wait', { tabId: 2, text: 'Test', timeoutMs: 100 });
  const record = f.controller.store.get(2); record.pendingUntil = Date.now() + 30000;
  f.controller.store.interrupt(record, 'observing', 'expected navigation', { navigation: true });
  assert.equal((await f.controller.execute(request)).found, true);
  const stopped = f.request('wait', { tabId: 2, text: 'Test', timeoutMs: 100 });
  await f.controller.userControl(2, 'pause'); await f.controller.userControl(2, 'resume');
  await assert.rejects(f.controller.execute(stopped), { code: 'CONTROL_CHANGED' });
});
test('disconnect during a stop cannot leave the UI stuck in stopping', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.run('snapshot', { tabId: 2 }); f.hold();
  const write = f.run('click', { tabId: 2, selector: 'button' }); const rejected = assert.rejects(write, { code: 'CANCELLED' });
  await settle(); const stopping = f.controller.userControl(2, 'pause'); f.controller.receive({ type: 'release', sessionId: 'session-a' }); f.release();
  await Promise.all([rejected, stopping]); await f.run('attach', { tabId: 2 }, { sessionId: 'session-b' });
  assert.equal(f.controller.store.get(2).stopping, false); assert.equal(f.controller.store.public(f.controller.store.get(2)).canResume, true);
});
test('one paused tab does not block metadata or work in another tab', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 }); await f.controller.userControl(2, 'pause');
  const waitRequest = f.request('wait_for_control', { tabId: 2, timeoutMs: 100 });
  f.controller.receive(waitRequest.type ? waitRequest : { type: 'request', ...waitRequest }, f.controller.port);
  const inventory = f.request('tabs'); f.controller.receive({ type: 'request', ...inventory }, f.controller.port);
  const other = f.request('open', { url: 'https://example.com/other' }, { sessionId: 'session-b' }); f.controller.receive({ type: 'request', ...other }, f.controller.port);
  for (let i = 0; i < 20 && !f.replies.some(r => r.id === other.id); i++) await settle();
  assert.ok(f.replies.some(r => r.id === inventory.id)); assert.ok(f.replies.some(r => r.id === other.id));
  assert.equal(f.replies.some(r => r.id === waitRequest.id), false);
  await new Promise(resolve => setTimeout(resolve, 120));
});
test('navigation invalidates a live-looking frozen document port and its pending reads', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 });
  const original = await f.run('snapshot', { tabId: 2 }); f.holdReads();
  const staleRead = f.run('snapshot', { tabId: 2 });
  const rejected = assert.rejects(staleRead, { code: 'NAVIGATION_CHANGED' }); await settle();
  const record = f.controller.store.get(2); record.navigationIntentUntil = Date.now() + 30000;
  await f.controller.navigated({ tabId: 2, frameId: 0, url: f.tabs.get(2).url });
  await rejected; f.releaseReads();
  const refreshed = await f.run('snapshot', { tabId: 2 });
  assert.notEqual(refreshed.documentId, original.documentId);
  assert.equal(record.frames.get(0).snapshotId, refreshed.snapshotId);
  await f.run('fill', { tabId: 2, selector: 'input', text: 'new document' });
  assert.deepEqual(f.writes, ['fill']);
});
test('title notifications from the AI marker do not rebroadcast the same state', async () => {
  const f = fixture(); await f.run('attach', { tabId: 2 });
  const states = f.states.length, groupChanges = f.calls.filter(call => call[0] === 'group-state').length;
  for (let i = 0; i < 20; i++) f.api.tabs.onUpdated.emit(2, { title: '[AI·观察] Work' });
  assert.equal(f.states.length, states);
  assert.equal(f.calls.filter(call => call[0] === 'group-state').length, groupChanges);
  f.api.tabs.onUpdated.emit(2, { title: 'Updated page title' });
  assert.equal(f.controller.store.get(2).pageTitle, 'Updated page title');
  assert.equal(f.states.length, states + 1);
});
