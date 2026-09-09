/* global browser, ZenControlStore, ZenControlActive */
'use strict';

class ZenController {
  constructor(api) {
    this.api = api;
    this.store = new ZenControlStore();
    this.pages = new Map();
    this.rpcs = new Map();
    this.cancelled = new Set();
    this.releasedSessions = new Set();
    this.enabled = true;
    this.port = null;
    this.transportEpoch = 0;
    this.lastError = '';
    this.queues = new Map();
    this.saveQueue = Promise.resolve();
    this.retry = null;
    api.tabs.onActivated.addListener(({ tabId, windowId }) => {
      for (const record of this.store.records.values()) if (record.windowId === windowId || record.tabId === tabId) {
        record.selected = record.tabId === tabId;
        this.publish(record);
      }
    });
    api.tabs.onRemoved.addListener(tabId => { this.store.records.delete(tabId); this.pages.delete(tabId); this.persist(); this.badge(); });
    api.runtime.onConnect.addListener(port => this.connectPage(port));
    api.runtime.onMessage.addListener((message, sender) => {
      if (sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(''))) return undefined;
      if (message?.type === 'popup-status') return Promise.resolve(this.status());
      if (message?.type === 'popup-toggle') return this.setEnabled(message.enabled);
      if (message?.type === 'popup-control') return this.userControl(message.tabId, message.action);
      return undefined;
    });
    api.webNavigation.onCommitted.addListener(details => this.navigated(details).catch(error => { this.lastError = error.message; }));
    api.webNavigation.onHistoryStateUpdated.addListener(details => this.navigated({ ...details, sameDocument: true }).catch(error => { this.lastError = error.message; }));
    api.tabs.onUpdated.addListener((tabId, change) => {
      const record = this.store.get(tabId);
      if (record && (change.title !== undefined || change.url !== undefined)) {
        const title = change.title === undefined ? record.pageTitle : change.title.replace(/^\[AI·[^\]]+\] /, '');
        let site = record.site;
        if (change.url !== undefined) { try { site = new URL(change.url).host; } catch { site = ''; } }
        if (title !== record.pageTitle || site !== record.site) { record.pageTitle = title; record.site = site; this.publish(record); }
      }
      if (change.status === 'complete' && this.store.get(tabId)) this.inject(tabId).catch(error => this.presentationError(tabId, error));
    });
  }
  error(code, message) { return Object.assign(new Error(message), { code }); }
  status() {
    return { enabled: this.enabled, connected: !!this.port,
      controlledTabs: [...this.store.records.values()].filter(r => r.owner && ZenControlActive.has(r.state)).length,
      tabs: [...this.store.records.values()].map(r => this.store.public(r)), lastError: this.lastError };
  }
  persist() {
    if (!this.api.storage.session) return;
    const records = [...this.store.records.values()].map(record => ({ ...this.store.public(record), windowId: record.windowId }));
    this.saveQueue = this.saveQueue.then(() => this.api.storage.session.set({ tabStates: records })).catch(error => { this.lastError = error.message; });
  }
  async badge() {
    await this.api.browserAction.setBadgeText({ text: !this.enabled ? 'OFF' : !this.port ? '!' : '' }).catch(() => {});
    for (const record of this.store.records.values()) {
      const text = ({ running: 'AI', idle: 'AI', observing: 'AI', paused: 'Ⅱ', user_control: 'YOU', waiting_user: '?', completed: 'OK', failed: '!' })[record.state];
      const color = ({ paused: '#b88324', user_control: '#69727d', waiting_user: '#b88324', failed: '#b94e52', completed: '#327762' })[record.state] || '#7560cc';
      await this.api.browserAction.setBadgeText({ tabId: record.tabId, text }).catch(() => {});
      await this.api.browserAction.setBadgeBackgroundColor({ tabId: record.tabId, color }).catch(() => {});
      await this.api.browserAction.setTitle({ tabId: record.tabId, title: 'Zen AI · ' + this.store.public(record).label }).catch(() => {});
    }
  }
  publish(record) {
    if (this.store.get(record.tabId) !== record) return;
    const state = this.store.public(record);
    for (const page of this.pages.get(record.tabId)?.values() || []) {
      try { page.port.postMessage({ type: 'state', state }); } catch { /* Port disconnect is handled separately. */ }
    }
    if (record.groupId !== null && this.api.tabGroups?.update) {
      const color = ({ paused: 'yellow', user_control: 'grey', waiting_user: 'yellow', completed: 'green', failed: 'red' })[record.state] || 'purple';
      const signature = record.groupId + ':' + state.label + ':' + color;
      if (record.groupSignature !== signature) {
        record.groupSignature = signature;
        this.api.tabGroups.update(record.groupId, { title: 'AI · ' + state.label, color }).catch(error => {
          record.marking = 'title'; record.groupId = null; record.markingNote = error.message;
        });
      }
    }
    this.persist();
    this.badge();
  }
  presentationError(tabId, error) {
    const record = this.store.get(tabId);
    if (!record) return;
    record.markingNote = error.message;
    // Restricted pages remain visible in the extension popup; they are never acted on.
    if (record.owner && ZenControlActive.has(record.state)) this.store.interrupt(record, 'waiting_user', '页面暂不可访问，等待重新连接页面');
    this.publish(record);
  }
  async mark(record, tab) {
    record.windowId = tab.windowId;
    record.selected = tab.active;
    record.pageTitle = tab.title || ''; record.site = new URL(tab.url || 'about:blank').host;
    if (this.api.tabs.group && this.api.tabGroups?.update && !tab.pinned && (tab.groupId === undefined || tab.groupId === -1) && (tab.splitViewId === undefined || tab.splitViewId === -1)) {
      try {
        record.groupId = await this.api.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
        record.marking = 'native-group-and-title';
      } catch (error) { record.markingNote = error.message; }
    } else record.markingNote = '保留已有分组、固定或分屏布局，使用标题标识';
    this.publish(record);
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw this.error('INVALID_ARGUMENTS', 'enabled must be boolean');
    this.enabled = enabled;
    this.transportEpoch++;
    await this.api.storage.local.set({ enabled });
    clearTimeout(this.retry);
    if (!enabled) {
      for (const record of this.store.records.values()) if (record.owner) {
        this.store.interrupt(record, 'paused', '你已暂停全部 AI 操作');
        this.publish(record);
      }
      const old = this.port;
      this.port = null;
      old?.disconnect();
      for (const record of this.store.disconnect(null, '全局控制已暂停；重新连接后点击继续')) this.publish(record);
      await this.quiesce();
    } else this.connect();
    await this.badge();
    return this.status();
  }
  async start() {
    const settings = await this.api.storage.local.get('enabled');
    this.enabled = settings.enabled !== false;
    const saved = await this.api.storage.session?.get('tabStates');
    for (const value of saved?.tabStates || []) {
      try {
        const tab = await this.api.tabs.get(value.tabId);
        if (tab.incognito) continue;
        const record = this.store.create(tab.id, null, { taskTitle: value.taskTitle });
        Object.assign(record, { state: value.state === 'completed' ? 'completed' : 'waiting_user',
          reason: value.state === 'completed' ? value.reason : '扩展已重启；请重新连接并确认继续', connected: false,
          step: value.step, history: value.history || [], marking: value.marking, groupId: value.groupId,
          collapsed: !!value.collapsed, windowId: tab.windowId, selected: tab.active });
        this.inject(tab.id).catch(error => this.presentationError(tab.id, error));
      } catch { /* A closed tab is not restored from presentation state. */ }
    }
    if (this.enabled) this.connect();
    this.badge();
  }
  connect() {
    if (!this.enabled || this.port) return;
    try {
      const port = this.api.runtime.connectNative('io.github.reasonw6.zen_browser');
      this.port = port;
      this.lastError = '';
      port.onMessage.addListener(message => this.receive(message, port));
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.lastError = port.error?.message || 'Native host disconnected.';
        this.port = null;
        this.transportEpoch++;
        for (const record of this.store.disconnect()) this.publish(record);
        if (this.enabled) this.retry = setTimeout(() => this.connect(), 3000);
      });
      this.api.runtime.getBrowserInfo().then(info => {
        if (this.port === port) port.postMessage({ type: 'hello', version: 1, browser: info });
      }).catch(error => { this.lastError = error.message; port.disconnect(); });
      this.badge();
    } catch (error) {
      this.lastError = error.message;
      this.port = null;
      if (this.enabled) this.retry = setTimeout(() => this.connect(), 3000);
    }
  }
  receive(message, port) {
    if (message?.type === 'cancel') {
      this.cancelled.add(message.id);
      const rpc = [...this.rpcs.values()].find(item => item.request.id === message.id);
      const record = rpc && this.store.get(rpc.tabId);
      if (record) { this.store.interrupt(record, 'waiting_user', '指令已取消；已发生的动作不会撤销，请检查页面'); this.publish(record); }
      return;
    }
    if (message?.type === 'release') {
      this.releasedSessions.add(message.sessionId);
      for (const record of this.store.disconnect(message.sessionId)) this.publish(record);
      return;
    }
    if (message?.type !== 'request') return;
    const request = { ...message, transportEpoch: this.transportEpoch, tabEpoch: this.store.capture(message.params?.tabId), stopEpoch: this.store.get(message.params?.tabId)?.stopEpoch };
    const respond = async () => {
      try {
        if (this.port !== port) throw this.error('DISCONNECTED', 'Connection changed before execution.');
        const result = await this.execute(request);
        if (this.port === port) port.postMessage({ type: 'response', id: request.id, result });
      } catch (error) {
        if (this.port === port) port.postMessage({ type: 'response', id: request.id, error: { code: error.code || 'BROWSER_ERROR', message: String(error.message).slice(0, 2000) } });
      } finally { this.cancelled.delete(request.id); }
    };
    // Stop commands must not wait behind a long page wait.
    if (request.command === 'tabs' || (request.command === 'control' && request.params.action === 'pause')) respond();
    else {
      const key = Number.isInteger(request.params?.tabId) ? 'tab:' + request.params.tabId : 'session:' + request.sessionId;
      const queued = (this.queues.get(key) || Promise.resolve()).then(respond).catch(error => { this.lastError = error.message; });
      this.queues.set(key, queued);
      queued.finally(() => { if (this.queues.get(key) === queued) this.queues.delete(key); });
    }
  }
  alive(request) {
    if (!this.enabled || this.cancelled.has(request.id) || this.releasedSessions.has(request.sessionId)) throw this.error('CANCELLED', 'Control was stopped or this MCP session disconnected.');
    if (request.transportEpoch !== undefined && request.transportEpoch !== this.transportEpoch) throw this.error('CONTROL_CHANGED', 'The connection changed while this request was queued.');
    if (!Number.isFinite(request.deadline) || Date.now() >= request.deadline) throw this.error('TIMEOUT', 'Request expired before execution.');
  }
  webUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw this.error('INVALID_URL', 'Use an absolute HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw this.error('RESTRICTED_URL', 'Only HTTP(S) pages without URL credentials are supported.');
    return url.href;
  }
  tabInfo(tab, sessionId) {
    const record = this.store.get(tab.id);
    return { tabId: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active,
      status: tab.status, discarded: tab.discarded, cookieStoreId: tab.cookieStoreId,
      controlled: !!record?.owner && ZenControlActive.has(record.state), ownedByThisSession: record?.owner === sessionId,
      createdByThisSession: record?.createdBy === sessionId, control: record ? this.store.public(record) : null };
  }
  async eligible(tabId, request, options = {}) {
    this.alive(request);
    if (!Number.isInteger(tabId)) throw this.error('INVALID_ARGUMENTS', 'A numeric tabId is required.');
    const tab = await this.api.tabs.get(tabId);
    this.alive(request);
    if (tab.incognito) throw this.error('PRIVATE_TAB', 'Private tabs are not supported.');
    const record = this.store.require(tabId, request.sessionId, request.tabEpoch ?? undefined, options);
    if (tab.url === 'about:blank' && record.pendingUntil > Date.now()) throw this.error('PAGE_LOADING', 'The tab is still navigating. Use zen_wait.');
    this.webUrl(tab.url);
    return { tab, record };
  }
  async inject(tabId, frameId) {
    // One injection is atomic with respect to a document navigation. Separate
    // helper injections could land in different iframe documents during a redirect.
    this.pageSource ||= Promise.all(['input-origin.js', 'page-ui.js', 'content.js'].map(async file => {
      const response = await fetch(this.api.runtime.getURL(file));
      if (!response.ok) throw this.error('MISSING_PAGE_SOURCE', 'Missing packaged page source: ' + file);
      return response.text();
    })).then(sources => sources.join('\n'));
    await this.api.tabs.executeScript(tabId, { code: await this.pageSource, ...(frameId === undefined ? { allFrames: true, matchAboutBlank: true } : { frameId }), runAt: 'document_start' });
  }
  connectPage(port) {
    const sender = port.sender;
    if (port.name !== 'zen-page-v2' || sender?.id !== this.api.runtime.id || !sender.tab) return;
    const tabId = sender.tab.id, frameId = sender.frameId ?? 0;
    const record = this.store.get(tabId);
    if (!record || sender.tab.incognito) { port.disconnect(); return; }
    const page = { port, tabId, frameId, documentId: null };
    let frames = this.pages.get(tabId);
    if (!frames) { frames = new Map(); this.pages.set(tabId, frames); }
    frames.set(frameId, page);
    port.onDisconnect.addListener(() => {
      if (frames.get(frameId) === page) frames.delete(frameId);
      for (const [id, rpc] of this.rpcs) if (rpc.page === page) {
        this.rpcs.delete(id); clearTimeout(rpc.timer);
        rpc.reject(this.error('NAVIGATION_CHANGED', 'The page connection closed. Observe the new document before another write.'));
      }
    });
    port.onMessage.addListener(message => {
      if (frames.get(frameId) !== page) return;
      if (message.type === 'hello' && typeof message.documentId === 'string') {
        page.documentId = message.documentId;
        this.store.frame(record, frameId, page.documentId);
        port.postMessage({ type: 'state', state: this.store.public(record) });
      } else if (message.type === 'result') {
        const rpc = this.rpcs.get(message.id);
        if (!rpc || rpc.page !== page) return;
        this.rpcs.delete(message.id); clearTimeout(rpc.timer);
        if (message.error) rpc.reject(this.error(message.error.code || 'PAGE_ERROR', message.error.message));
        else rpc.resolve(message.result);
      } else if (message.type === 'authorize') {
        const rpc = this.rpcs.get(message.id);
        try {
          if (!rpc || rpc.page !== page || rpc.authorized || !rpc.write) throw this.error('INVALID_PERMIT', 'No pending write matches this authorization.');
          this.alive(rpc.request);
          const current = this.store.require(tabId, rpc.request.sessionId, rpc.epoch, { observed: true, frameId });
          if (page.documentId !== message.documentId || current.frames.get(frameId)?.snapshotId !== rpc.snapshotId) throw this.error('OBSERVATION_REQUIRED', 'The document or observation changed.');
          rpc.authorized = true;
          current.navigationIntentUntil = Date.now() + 2000;
          if (current.step) current.step.phase = 'running';
          this.publish(current);
          port.postMessage({ type: 'permit', id: message.id, epoch: rpc.epoch, allowed: true });
        } catch (error) { port.postMessage({ type: 'permit', id: message.id, allowed: false, error: { code: error.code, message: error.message } }); }
      } else if (message.type === 'target') {
        const rpc = this.rpcs.get(message.id);
        if (rpc?.page === page && record.epoch === rpc.epoch && record.step) {
          record.step.label = String(message.label || rpc.command).slice(0, 160);
          record.step.phase = 'preparing';
          this.publish(record);
        }
      } else if (message.type === 'user-control') {
        // UI controls and physical-intent events use the same immediate barrier.
        this.userControl(tabId, message.action, message.reason).then(state => {
          try { port.postMessage({ type: 'control-result', id: message.id, state }); } catch {}
        }).catch(error => {
          try { port.postMessage({ type: 'control-result', id: message.id, error: { code: error.code, message: error.message } }); } catch {}
        });
      }
    });
  }
  async quiesce(tabId) {
    const work = [...this.rpcs.values()].filter(rpc => tabId === undefined || rpc.tabId === tabId).map(rpc => rpc.promise);
    await Promise.allSettled(work);
  }
  async userControl(tabId, action, reason) {
    const record = this.store.get(tabId);
    if (!record) throw this.error('NOT_ATTACHED', 'This tab has no AI task.');
    if (action === 'collapse') record.collapsed = !record.collapsed;
    else if (action === 'pause') this.store.interrupt(record, 'paused', '你已暂停；已完成的动作不会撤销');
    else if (action === 'takeover') this.store.interrupt(record, 'user_control', reason === 'input' ? '检测到你的实际网页输入，后续 AI 操作已停止' : '你已接管页面，AI 不会继续写入');
    else if (action === 'external-input') this.store.interrupt(record, 'waiting_user', '检测到外部编辑，已暂停以避免覆盖页面变化');
    else if (action === 'resume') {
      if (!this.enabled || !this.port) throw this.error('NOT_CONNECTED', 'Enable the bridge and reconnect before continuing.');
      if (record.stopping) throw this.error('CONTROL_STOPPING', 'Wait until pending instructions have stopped before continuing.');
      this.store.resume(record);
    } else throw this.error('INVALID_CONTROL', 'Unsupported control action.');
    const epoch = record.epoch;
    if (action !== 'collapse' && action !== 'resume') record.stopping = true;
    this.publish(record);
    if (action !== 'collapse') await this.quiesce(tabId);
    if (record.epoch === epoch) { record.stopping = false; this.publish(record); }
    return this.store.public(record);
  }
  async navigated(details) {
    const record = this.store.get(details.tabId);
    if (!record) return;
    const frameId = details.frameId ?? 0;
    if (!details.sameDocument) {
      // A BFCache document can keep its port alive while its JS is frozen.
      // Never route the new document's command to that old live-looking port.
      const pages = this.pages.get(details.tabId);
      for (const [id, page] of [...(pages?.entries() || [])]) if (frameId === 0 || id === frameId) {
        pages.delete(id);
        for (const [rpcId, rpc] of this.rpcs) if (rpc.page === page) {
          this.rpcs.delete(rpcId); clearTimeout(rpc.timer);
          rpc.reject(this.error('NAVIGATION_CHANGED', 'The document navigated; the previous page channel was invalidated.'));
        }
        try { page.port.disconnect(); } catch {}
      }
    }
    if (frameId === 0) {
      const expected = record.navigationIntentUntil > Date.now();
      const active = ZenControlActive.has(record.state);
      this.store.interrupt(record, active ? expected ? 'observing' : 'waiting_user' : record.state,
        active ? expected ? '页面已导航，等待重新观察' : '页面发生了外部导航；确认后点击继续' : record.reason, { navigation: active && expected });
      record.pendingUntil = Date.now() + 30000;
      if (expected) record.navigationIntentUntil = Date.now() + 2000;
      this.publish(record);
    } else record.frames.delete(frameId);
    try { this.webUrl(details.url); await this.inject(details.tabId, frameId); }
    catch (error) {
      if (frameId === 0 && error.code !== 'RESTRICTED_URL') this.presentationError(details.tabId, error);
    }
  }
  async page(tabId, frameId, request) {
    let page = this.pages.get(tabId)?.get(frameId);
    if (page?.documentId) return page;
    await this.inject(tabId, frameId);
    for (let i = 0; i < 40; i++) {
      this.alive(request);
      page = this.pages.get(tabId)?.get(frameId);
      if (page?.documentId) return page;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw this.error('CONTENT_UNAVAILABLE', 'Frame ' + frameId + ' did not connect. Connected frames: ' + [...(this.pages.get(tabId)?.keys() || [])].join(', '));
  }
  async content(command, params, request, write = false) {
    const frameId = params.frameId ?? 0;
    const { tab, record } = await this.eligible(params.tabId, request, { readOnly: !write, observed: write, frameId });
    if (tab.status === 'loading') throw this.error('PAGE_LOADING', 'The document is still loading. Use zen_wait.');
    const page = await this.page(tab.id, frameId, request);
    this.store.require(tab.id, request.sessionId, request.tabEpoch ?? record.epoch, { readOnly: !write, observed: write, frameId });
    const id = crypto.randomUUID(), epoch = record.epoch;
    const snapshotId = record.frames.get(frameId)?.snapshotId;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      this.rpcs.delete(id);
      reject(this.error('TIMEOUT', 'Page response timed out; the action may already have happened. Observe before retrying.'));
    }, Math.max(1, request.deadline - Date.now()));
    this.rpcs.set(id, { id, page, tabId: tab.id, command, request, epoch, write, snapshotId, promise, timer, resolve, reject });
    try { page.port.postMessage({ type: 'command', id, command, params, write, epoch, snapshotId, documentId: page.documentId, deadline: request.deadline, expectedTopUrl: tab.url }); }
    catch (error) { this.rpcs.delete(id); clearTimeout(timer); reject(error); }
    const result = await promise;
    if (command === 'snapshot' && this.store.get(tab.id) === record && record.epoch === epoch) {
      this.store.observe(record, frameId, page.documentId, result.snapshotId);
      this.publish(record);
    }
    return result;
  }
  async execute(request) {
    this.alive(request);
    const p = request.params || {}, command = request.command;
    if (command === 'tabs') return { tabs: (await this.api.tabs.query({ windowType: 'normal' })).filter(t => !t.incognito).map(t => this.tabInfo(t, request.sessionId)) };
    if (command === 'open') {
      const url = this.webUrl(p.url), windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
      const window = p.windowId !== undefined ? windows.find(w => w.id === p.windowId) : windows.find(w => w.focused && !w.incognito) || windows.find(w => !w.incognito);
      if (!window || window.incognito) throw this.error('NO_WINDOW', 'An existing non-private Zen window is required.');
      this.alive(request);
      const tab = await this.api.tabs.create({ windowId: window.id, url, active: false, muted: true });
      this.alive(request);
      const record = this.store.create(tab.id, request.sessionId, { created: true, taskTitle: p.taskTitle });
      record.pendingUntil = Date.now() + 30000;
      record.navigationIntentUntil = Date.now() + 30000;
      await this.mark(record, tab);
      this.inject(tab.id).catch(error => {
        if (this.store.get(tab.id) === record) record.markingNote = error.message;
      });
      return this.tabInfo(await this.api.tabs.get(tab.id), request.sessionId);
    }
    if (command === 'attach') {
      const tab = await this.api.tabs.get(p.tabId);
      this.alive(request);
      if (tab.incognito) throw this.error('PRIVATE_TAB', 'Private tabs are not supported.');
      this.webUrl(tab.url);
      const previous = this.store.get(tab.id);
      const record = this.store.create(tab.id, request.sessionId, { taskTitle: p.taskTitle });
      record.windowId = tab.windowId; record.selected = tab.active;
      record.pageTitle = (tab.title || '').replace(/^\[AI·[^\]]+\] /, ''); record.site = new URL(tab.url).host;
      if (!previous) await this.mark(record, tab);
      await this.inject(tab.id);
      this.publish(record);
      return this.tabInfo(tab, request.sessionId);
    }
    if (command === 'detach') {
      const record = this.store.require(p.tabId, request.sessionId, undefined, { readOnly: true });
      this.store.interrupt(record, 'user_control', 'AI 已释放控制，页面由你操作');
      record.lastOwner = record.owner; record.owner = null; record.connected = false;
      this.publish(record);
      return { tabId: p.tabId, released: true };
    }
    if (command === 'control') {
      const record = this.store.require(p.tabId, request.sessionId, undefined, { readOnly: true });
      if (p.action !== 'pause') throw this.error('INVALID_CONTROL', 'MCP may pause; only the user interface can resume a human stop.');
      this.store.interrupt(record, 'paused', p.message || 'AI 已暂停，等待你继续');
      this.publish(record); await this.quiesce(p.tabId);
      return this.store.public(record);
    }
    if (command === 'task') {
      const { record } = await this.eligible(p.tabId, request);
      this.store.finish(record, p.outcome, p.message || ({ completed: '任务已完成，结果页面为你保留', failed: '任务未完成，请检查页面', waiting_user: '需要你处理后再继续' })[p.outcome]);
      this.publish(record);
      return this.store.public(record);
    }
    if (command === 'snapshot') {
      const result = await this.content(command, p, request);
      const frames = await this.api.webNavigation.getAllFrames({ tabId: p.tabId });
      return { ...result, tabId: p.tabId, frameId: p.frameId ?? 0, control: this.store.public(this.store.get(p.tabId)),
        frames: frames.map(({ frameId, parentFrameId, url, errorOccurred }) => ({ frameId, parentFrameId, url, errorOccurred })) };
    }
    if (command === 'screenshot') {
      const { tab } = await this.eligible(p.tabId, request, { readOnly: true });
      if (tab.discarded) throw this.error('DISCARDED_TAB', 'Load the tab before capturing it.');
      const dataUrl = await this.api.tabs.captureTab(tab.id, { format: p.format || 'jpeg', quality: p.quality ?? 80 });
      if (dataUrl.length > 16 * 1024 * 1024) throw this.error('SCREENSHOT_TOO_LARGE', 'Use JPEG or lower quality.');
      return { tabId: tab.id, url: tab.url, dataUrl, background: !tab.active };
    }
    if (command === 'wait_for_control') {
      const record = this.store.require(p.tabId, request.sessionId, undefined, { readOnly: true });
      const until = Math.min(request.deadline, Date.now() + (p.timeoutMs ?? 30000));
      do {
        this.alive(request);
        this.store.require(p.tabId, request.sessionId, undefined, { readOnly: true });
        if (record.state === 'completed') return { ready: false, completed: true, control: this.store.public(record) };
        if (record.owner === request.sessionId && ZenControlActive.has(record.state) && !record.stopping) {
          request.tabEpoch = record.epoch;
          try {
            const snapshot = await this.content('snapshot', { tabId: p.tabId, frameId: p.frameId ?? 0 }, request);
            const frames = await this.api.webNavigation.getAllFrames({ tabId: p.tabId });
            if (record.epoch === request.tabEpoch && ZenControlActive.has(record.state)) return { ready: true,
              snapshot: { ...snapshot, tabId: p.tabId, frameId: p.frameId ?? 0, frames: frames.map(({ frameId, parentFrameId, url }) => ({ frameId, parentFrameId, url })) },
              control: this.store.public(record) };
          } catch (error) {
            if (!['PAGE_LOADING', 'CONTROL_CHANGED', 'NAVIGATION_CHANGED'].includes(error.code)) throw error;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < until);
      return { ready: false, control: this.store.public(record), message: '仍在等待用户；没有执行或重放网页写入' };
    }
    if (command === 'wait') {
      if (!p.text && !p.selector) throw this.error('INVALID_ARGUMENTS', 'Supply text or selector to wait for.');
      const pendingRecord = this.store.get(p.tabId);
      if (request.stopEpoch !== undefined && pendingRecord?.stopEpoch === request.stopEpoch && ZenControlActive.has(pendingRecord.state)) request.tabEpoch = pendingRecord.epoch;
      const record = this.store.require(p.tabId, request.sessionId, request.tabEpoch ?? undefined, { readOnly: true });
      const originalEpoch = record.epoch, stopEpoch = request.stopEpoch ?? record.stopEpoch, number = this.store.begin(record, 'wait');
      record.step.label = '等待网页内容'; this.publish(record);
      const until = Math.min(request.deadline, Date.now() + (p.timeoutMs ?? 10000));
      try {
        do {
          this.alive(request);
          // A read-only wait may follow an expected navigation, but never a human stop/resume.
          if (record.stopEpoch === stopEpoch && ZenControlActive.has(record.state)) request.tabEpoch = record.epoch;
          try {
            const result = await this.content('probe', p, request);
            if (result.found) { this.store.end(record, request.tabEpoch ?? originalEpoch, number, result); this.publish(record); return result; }
          } catch (error) {
            const expectedNavigation = record.stopEpoch === stopEpoch && ZenControlActive.has(record.state) && record.pendingUntil > Date.now();
            if (error.code !== 'PAGE_LOADING' && !(expectedNavigation && ['CONTROL_CHANGED', 'NAVIGATION_CHANGED'].includes(error.code))) throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < until);
        throw this.error('WAIT_TIMEOUT', 'The requested content did not appear.');
      } catch (error) { this.store.fail(record, record.stopEpoch === stopEpoch ? record.epoch : originalEpoch, number, error); this.publish(record); throw error; }
    }
    const writes = ['click', 'fill', 'select', 'check', 'press', 'scroll', 'navigate', 'close'];
    if (!writes.includes(command)) throw this.error('UNKNOWN_COMMAND', 'Unknown browser command: ' + command);
    const { tab, record } = await this.eligible(p.tabId, request, { observed: true, frameId: p.frameId ?? 0 });
    const epoch = record.epoch, number = this.store.begin(record, command);
    this.publish(record);
    try {
      let result;
      if (command === 'navigate') {
        record.pendingUntil = Date.now() + 30000;
        record.navigationIntentUntil = Date.now() + 30000;
        if (p.action === 'goto') await this.api.tabs.update(tab.id, { url: this.webUrl(p.url) });
        else if (p.action === 'reload') await this.api.tabs.reload(tab.id);
        else if (p.action === 'back') await this.api.tabs.goBack(tab.id);
        else if (p.action === 'forward') await this.api.tabs.goForward(tab.id);
        else throw this.error('INVALID_ARGUMENTS', 'Unknown navigation action.');
        result = this.tabInfo(await this.api.tabs.get(tab.id), request.sessionId);
      } else if (command === 'close') {
        if (tab.active) throw this.error('VISIBLE_TAB', 'A watched tab is kept open. Close it yourself or finish the task to retain the result.');
        if (record.createdBy !== request.sessionId) throw this.error('NOT_CREATED', 'Only this session’s newly-created background tabs can be closed.');
        await this.api.tabs.remove(tab.id);
        this.store.records.delete(tab.id);
        result = { tabId: tab.id, closed: true };
      } else result = await this.content(command, p, request, true);
      this.store.end(record, epoch, number, result);
      this.publish(record);
      return { ...result, control: this.store.get(tab.id) ? this.store.public(record) : null };
    } catch (error) {
      this.store.fail(record, epoch, number, error);
      this.publish(record);
      throw error;
    }
  }
}

globalThis.ZenController = ZenController;
if (typeof browser !== 'undefined') {
  const controller = new ZenController(browser);
  controller.start().catch(error => { controller.lastError = error.message; controller.badge(); });
}
