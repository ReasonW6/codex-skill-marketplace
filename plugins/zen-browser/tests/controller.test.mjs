import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
function fixture() {
  const events = {}, calls = [];
  const tabs = new Map([[1, { id: 1, windowId: 10, active: true, url: 'https://example.com/user', title: 'User' }], [2, { id: 2, windowId: 10, active: false, url: 'https://example.com/work', title: 'Work' }]]);
  const api = {
    tabs: {
      onActivated: { addListener: cb => { events.activate = cb; } }, onRemoved: { addListener: cb => { events.remove = cb; } },
      query: async () => [...tabs.values()], get: async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return { ...tabs.get(id) }; },
      create: async options => { calls.push(['create', options]); const t = { id: 3, ...options }; tabs.set(3, t); return t; },
      update: async (id, props) => { calls.push(['update', id, props]); Object.assign(tabs.get(id), props); return tabs.get(id); },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); },
      captureTab: async id => { calls.push(['capture', id]); return 'data:image/png;base64,aGVsbG8='; },
      executeScript: async (...args) => { calls.push(['execute', ...args]); },
      sendMessage: async (...args) => { calls.push(['send', ...args]); return { result: { clicked: true } }; }
    },
    windows: { getAll: async () => [{ id: 10, focused: true, incognito: false }] },
    runtime: { onMessage: { addListener: cb => { events.popup = cb; } }, id: 'test', getURL: () => 'moz-extension://test/' },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
  };
  const context = vm.createContext({ URL, console, setTimeout, clearTimeout });
  vm.runInContext(code, context);
  const controller = new context.ZenController(api);
  const run = (command, params = {}, extra = {}) => controller.execute({ id: 'request', command, params, sessionId: 'session-a', deadline: Date.now() + 5000, ...extra });
  return { run, controller, calls, tabs, events, api };
}
test('background open, screenshot and close never activate tabs or focus windows', async () => {
  const { run, calls, tabs } = fixture();
  const opened = await run('open', { url: 'https://example.com/new' });
  assert.equal(opened.active, false);
  await run('screenshot', { tabId: 3 }); await run('close', { tabId: 3 });
  assert.equal(tabs.get(1).active, true);
  assert.equal(calls.find(c => c[0] === 'create')[1].active, false);
  assert.equal(calls.some(c => c[0] === 'update' && 'active' in c[2]), false);
});
test('active, private, restricted and cross-session tabs are rejected', async () => {
  const { run, tabs } = fixture();
  await assert.rejects(run('attach', { tabId: 1 }), { code: 'FOREGROUND_TAB' });
  tabs.get(2).incognito = true;
  await assert.rejects(run('attach', { tabId: 2 }), { code: 'PRIVATE_TAB' });
  tabs.get(2).incognito = false; tabs.get(2).url = 'about:config';
  await assert.rejects(run('attach', { tabId: 2 }), { code: 'RESTRICTED_URL' });
  tabs.get(2).url = 'https://example.com/'; await run('attach', { tabId: 2 });
  await assert.rejects(run('attach', { tabId: 2 }, { sessionId: 'session-b' }), { code: 'TAB_BUSY' });
});
test('user activation revokes ownership; it is never restored automatically', async () => {
  const { run, events } = fixture();
  await run('attach', { tabId: 2 }); events.activate({ tabId: 2 });
  await assert.rejects(run('click', { tabId: 2, selector: '#button' }), { code: 'NOT_ATTACHED' });
});
test('pre-existing tabs cannot be closed and detach preserves them', async () => {
  const { run, tabs } = fixture();
  await run('attach', { tabId: 2 });
  await assert.rejects(run('close', { tabId: 2 }), { code: 'NOT_CREATED' });
  await run('detach', { tabId: 2 }); assert.equal(tabs.has(2), true);
});
test('cancellation, expiry and session release prevent queued writes', async () => {
  const { run, controller, calls } = fixture();
  await run('attach', { tabId: 2 });
  controller.cancelled.add('request');
  await assert.rejects(run('click', { tabId: 2 }), { code: 'CANCELLED' });
  controller.cancelled.clear();
  await assert.rejects(run('click', { tabId: 2 }, { deadline: Date.now() - 1 }), { code: 'TIMEOUT' });
  controller.receive({ type: 'release', sessionId: 'session-a' });
  await assert.rejects(run('click', { tabId: 2 }), { code: 'CANCELLED' });
  assert.equal(calls.length, 0);
});
test('page navigation and new tabs only accept HTTP(S) without URL credentials', async () => {
  const { run, calls } = fixture();
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'http://user:secret@example.com/']) await assert.rejects(run('open', { url }), { code: 'RESTRICTED_URL' });
  assert.equal(calls.length, 0);
});
test('messages from web content cannot pause or enable the native bridge', () => {
  const { events } = fixture();
  assert.equal(events.popup({ type: 'popup-toggle', enabled: false }, { id: 'test', tab: { id: 2 }, url: 'https://example.com' }), undefined);
});
test('cancelled tab creation leaves no orphaned session claim', async () => {
  const { run, api, controller } = fixture();
  const create = api.tabs.create;
  api.tabs.create = async options => { const tab = await create(options); controller.releasedSessions.add('session-a'); return tab; };
  await assert.rejects(run('open', { url: 'https://example.com/' }), { code: 'CANCELLED' });
  assert.equal(controller.claims.size, 0);
});
test('only bridge-initiated navigation may wait through transient about:blank', async () => {
  const { run, tabs, controller } = fixture();
  await run('attach', { tabId: 2 });
  tabs.get(2).url = 'about:blank'; tabs.get(2).status = 'loading';
  await assert.rejects(run('snapshot', { tabId: 2 }), { code: 'RESTRICTED_URL' });
  controller.claims.get(2).pendingUntil = Date.now() + 1000;
  await assert.rejects(run('snapshot', { tabId: 2 }), { code: 'PAGE_LOADING' });
  controller.claims.get(2).pendingUntil = Date.now() - 1;
  await assert.rejects(run('snapshot', { tabId: 2 }), { code: 'RESTRICTED_URL' });
});
