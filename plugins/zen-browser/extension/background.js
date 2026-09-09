/* global browser */
'use strict';

class ZenController {
  constructor(api) {
    this.api = api;
    this.claims = new Map();
    this.cancelled = new Set();
    this.releasedSessions = new Set();
    this.enabled = true;
    this.port = null;
    this.lastError = '';
    this.queue = Promise.resolve();
    this.retry = null;
    api.tabs.onActivated.addListener(({ tabId }) => {
      // Never switch the user away from a tab to regain control.
      this.claims.delete(tabId);
      this.badge();
    });
    api.tabs.onRemoved.addListener(tabId => { this.claims.delete(tabId); this.badge(); });
    api.runtime.onMessage.addListener((message, sender) => {
      // Only our own extension popup can use management messages.
      if (sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(''))) return undefined;
      if (message?.type === 'popup-status') return Promise.resolve(this.status());
      if (message?.type === 'popup-toggle') return this.setEnabled(message.enabled);
      return undefined;
    });
  }
  error(code, message) { return Object.assign(new Error(message), { code }); }
  status() { return { enabled: this.enabled, connected: !!this.port, controlledTabs: this.claims.size, lastError: this.lastError }; }
  async badge() {
    await this.api.browserAction.setBadgeText({ text: !this.enabled ? 'OFF' : !this.port ? '!' : this.claims.size ? String(this.claims.size) : '' }).catch(() => {});
    await this.api.browserAction.setBadgeBackgroundColor({ color: this.port ? '#356b58' : '#9b443d' }).catch(() => {});
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw this.error('INVALID_ARGUMENTS', 'enabled must be boolean');
    this.enabled = enabled;
    await this.api.storage.local.set({ enabled });
    clearTimeout(this.retry);
    if (!enabled) {
      this.claims.clear();
      this.port?.disconnect();
      this.port = null;
    } else this.connect();
    await this.badge();
    return this.status();
  }
  async start() {
    const settings = await this.api.storage.local.get('enabled');
    this.enabled = settings.enabled !== false;
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
        this.claims.clear();
        this.badge();
        if (this.enabled) this.retry = setTimeout(() => this.connect(), 3000);
      });
      this.api.runtime.getBrowserInfo().then(info => {
        if (this.port === port) port.postMessage({ type: 'hello', version: 1, browser: info });
      }).catch(error => { this.lastError = error.message; port.disconnect(); });
      this.badge();
    } catch (error) {
      this.lastError = error.message;
      this.port = null;
      this.badge();
      if (this.enabled) this.retry = setTimeout(() => this.connect(), 3000);
    }
  }
  receive(message, port) {
    if (message?.type === 'cancel') { this.cancelled.add(message.id); return; }
    if (message?.type === 'release') {
      this.releasedSessions.add(message.sessionId);
      for (const [tabId, claim] of this.claims) if (claim.sessionId === message.sessionId) this.claims.delete(tabId);
      this.badge(); return;
    }
    if (message?.type !== 'request') return;
    this.queue = this.queue.then(async () => {
      try {
        if (this.port !== port) throw this.error('DISCONNECTED', 'Connection changed before execution.');
        const result = await this.execute(message);
        if (this.port === port) port.postMessage({ type: 'response', id: message.id, result });
      } catch (error) {
        if (this.port === port) port.postMessage({ type: 'response', id: message.id,
          error: { code: error.code || 'BROWSER_ERROR', message: String(error.message).slice(0, 2000) } });
      } finally {
        this.cancelled.delete(message.id);
        this.badge();
      }
    }).catch(error => { this.lastError = error.message; });
  }
  alive(request) {
    if (!this.enabled || this.cancelled.has(request.id) || this.releasedSessions.has(request.sessionId)) throw this.error('CANCELLED', 'Control was stopped or this MCP session disconnected.');
    if (!Number.isFinite(request.deadline) || Date.now() >= request.deadline) throw this.error('TIMEOUT', 'Request expired before execution.');
  }
  webUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw this.error('INVALID_URL', 'Use an absolute HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw this.error('RESTRICTED_URL', 'Only HTTP(S) pages without credentials in the URL are supported.');
    return url.href;
  }
  tabInfo(tab, sessionId) {
    const claim = this.claims.get(tab.id);
    return { tabId: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url,
      active: tab.active, status: tab.status, discarded: tab.discarded, cookieStoreId: tab.cookieStoreId,
      controlled: !!claim, ownedByThisSession: claim?.sessionId === sessionId,
      createdByThisSession: claim?.sessionId === sessionId && claim.created };
  }
  async eligible(tabId, request, claimed = true) {
    this.alive(request);
    if (!Number.isInteger(tabId)) throw this.error('INVALID_ARGUMENTS', 'A numeric tabId is required.');
    const tab = await this.api.tabs.get(tabId);
    this.alive(request);
    if (tab.incognito) throw this.error('PRIVATE_TAB', 'Private tabs are not supported.');
    if (tab.active) {
      this.claims.delete(tabId);
      throw this.error('FOREGROUND_TAB', 'The user is using this tab. Control was released; do not switch it away or retry automatically.');
    }
    const claim = this.claims.get(tabId);
    if (claim && claim.sessionId !== request.sessionId) throw this.error('TAB_BUSY', 'This tab belongs to another MCP session.');
    if (claimed && !claim) throw this.error('NOT_ATTACHED', 'Attach this background tab explicitly before operating it.');
    if (tab.url === 'about:blank' && claim?.pendingUntil > Date.now()) throw this.error('PAGE_LOADING', 'The background tab is still navigating. Use zen_wait.');
    this.webUrl(tab.url);
    return tab;
  }
  async content(command, params, request) {
    const tab = await this.eligible(params.tabId, request);
    if (tab.status === 'loading') throw this.error('PAGE_LOADING', 'The background document is still loading. Use zen_wait.');
    const frameId = params.frameId ?? 0;
    try {
      await this.api.tabs.executeScript(tab.id, { file: 'content.js', frameId, runAt: 'document_idle' });
    } catch (error) {
      const current = await this.api.tabs.get(tab.id);
      if (current.status === 'loading' || current.url !== tab.url) throw this.error('PAGE_LOADING', 'Navigation changed the document before injection. Use zen_wait.');
      throw error;
    }
    await this.eligible(tab.id, request);
    const response = await this.api.tabs.sendMessage(tab.id, { channel: 'reasonw6-zen-v1', command, params,
      deadline: request.deadline, expectedTopUrl: tab.url }, { frameId });
    if (!response || response.error) throw this.error(response?.error?.code || 'CONTENT_UNAVAILABLE', response?.error?.message || 'Page content script did not respond.');
    return response.result;
  }
  async execute(request) {
    this.alive(request);
    const p = request.params || {};
    const command = request.command;
    if (command === 'tabs') return { tabs: (await this.api.tabs.query({ windowType: 'normal' })).filter(t => !t.incognito).map(t => this.tabInfo(t, request.sessionId)) };
    if (command === 'open') {
      const url = this.webUrl(p.url);
      const windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
      const window = p.windowId !== undefined ? windows.find(w => w.id === p.windowId) : windows.find(w => w.focused && !w.incognito) || windows.find(w => !w.incognito);
      if (!window || window.incognito) throw this.error('NO_WINDOW', 'An existing non-private Zen window is required.');
      this.alive(request);
      const tab = await this.api.tabs.create({ windowId: window.id, url, active: false, muted: true });
      this.alive(request);
      this.claims.set(tab.id, { sessionId: request.sessionId, created: true, pendingUntil: Date.now() + 30000 });
      const actual = await this.api.tabs.get(tab.id);
      try { this.alive(request); } catch (error) { this.claims.delete(tab.id); throw error; }
      if (actual.active) { this.claims.delete(tab.id); throw this.error('FOREGROUND_TAB', 'The created tab became active. Control was released.'); }
      return this.tabInfo(actual, request.sessionId);
    }
    if (command === 'attach') {
      const tab = await this.eligible(p.tabId, request, false);
      if (!this.claims.has(tab.id)) this.claims.set(tab.id, { sessionId: request.sessionId, created: false });
      return this.tabInfo(tab, request.sessionId);
    }
    if (command === 'detach') {
      const claim = this.claims.get(p.tabId);
      if (claim && claim.sessionId !== request.sessionId) throw this.error('TAB_BUSY', 'This tab belongs to another session.');
      this.claims.delete(p.tabId);
      return { tabId: p.tabId, released: true };
    }
    if (command === 'snapshot') {
      const result = await this.content(command, p, request);
      const frames = await this.api.webNavigation.getAllFrames({ tabId: p.tabId });
      return { ...result, tabId: p.tabId, frameId: p.frameId ?? 0, frames: frames.map(({ frameId, parentFrameId, url, errorOccurred }) => ({ frameId, parentFrameId, url, errorOccurred })) };
    }
    if (['click', 'fill', 'select', 'check', 'press', 'scroll'].includes(command)) return this.content(command, p, request);
    if (command === 'wait') {
      if (!p.text && !p.selector) throw this.error('INVALID_ARGUMENTS', 'Supply text or selector to wait for.');
      const until = Math.min(request.deadline, Date.now() + (p.timeoutMs ?? 10000));
      do {
        this.alive(request);
        try {
          const result = await this.content('probe', p, request);
          if (result.found) return result;
        } catch (error) {
          if (error.code !== 'PAGE_LOADING') throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < until);
      throw this.error('WAIT_TIMEOUT', 'The requested visible content did not appear.');
    }
    if (command === 'navigate') {
      const tab = await this.eligible(p.tabId, request);
      this.claims.get(tab.id).pendingUntil = Date.now() + 30000;
      if (p.action === 'goto') await this.api.tabs.update(tab.id, { url: this.webUrl(p.url) });
      else if (p.action === 'reload') await this.api.tabs.reload(tab.id);
      else if (p.action === 'back') await this.api.tabs.goBack(tab.id);
      else if (p.action === 'forward') await this.api.tabs.goForward(tab.id);
      else throw this.error('INVALID_ARGUMENTS', 'Unknown navigation action.');
      return this.tabInfo(await this.api.tabs.get(tab.id), request.sessionId);
    }
    if (command === 'screenshot') {
      const tab = await this.eligible(p.tabId, request);
      if (tab.discarded) throw this.error('DISCARDED_TAB', 'Load the tab with zen_navigate before capturing it.');
      const dataUrl = await this.api.tabs.captureTab(tab.id, { format: p.format || 'jpeg', quality: p.quality ?? 80 });
      if (dataUrl.length > 16 * 1024 * 1024) throw this.error('SCREENSHOT_TOO_LARGE', 'Use JPEG or lower quality for this large page.');
      return { tabId: tab.id, url: tab.url, dataUrl, background: true };
    }
    if (command === 'close') {
      const tab = await this.eligible(p.tabId, request);
      if (!this.claims.get(tab.id).created) throw this.error('NOT_CREATED', 'Only tabs created by this session can be closed.');
      await this.api.tabs.remove(tab.id);
      this.claims.delete(tab.id);
      return { tabId: tab.id, closed: true };
    }
    throw this.error('UNKNOWN_COMMAND', `Unknown browser command: ${command}`);
  }
}

globalThis.ZenController = ZenController;
if (typeof browser !== 'undefined') {
  const controller = new ZenController(browser);
  controller.start().catch(error => { controller.lastError = error.message; controller.badge(); });
}
