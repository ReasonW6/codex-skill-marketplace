(() => {
  'use strict';
  if (globalThis.ZenPageUi) return;
  const STYLE = `
    :host{all:initial!important;position:fixed!important;inset:var(--zen-ai-top,auto) var(--zen-ai-right,16px) var(--zen-ai-bottom,16px) var(--zen-ai-left,auto)!important;z-index:2147483647!important;display:block!important;width:min(326px,calc(100vw - 24px))!important;pointer-events:auto!important;contain:style!important;color-scheme:light!important}
    *{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;cursor:pointer}button:disabled{cursor:default;opacity:.5}
    .panel{position:relative;z-index:2147483647;font:13px/1.5 system-ui,-apple-system,sans-serif;color:#f5f3ff;background:#222235f5;border:1px solid #9990cd6b;border-radius:14px;box-shadow:0 8px 32px #0003;padding:12px;backdrop-filter:blur(14px)}
    .edge{position:fixed;inset:0;pointer-events:none;border:2px solid var(--edge-color,#a48be9);border-radius:8px;z-index:2147483645;box-shadow:inset 0 0 0 1px #ffffff35}
    header{display:flex;align-items:center;gap:8px}.mark{display:grid;place-items:center;width:28px;height:28px;border:1px solid #a99dea;border-radius:9px;background:#7460bf;color:#fff;font-size:10px;font-weight:800;letter-spacing:.4px}
    .heading{flex:1;min-width:0}.label{font-size:12px;font-weight:750}.mode{color:#bbb6d4;font-size:10px;margin-left:6px}.title{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#bdb8d0;font-size:11px;max-width:220px}
    .collapse{border:0;color:#ddd6f5;background:transparent;font-size:16px;width:25px;height:26px;border-radius:6px}.collapse:hover{background:#ffffff15}
    .detail{margin:9px 0 0;color:#ded9ee;overflow-wrap:anywhere;max-height:54px;overflow:auto;font-size:11px}.actions{display:flex;gap:6px;margin-top:10px}
    .actions button{border:1px solid #9287bb75;border-radius:7px;background:#ffffff0d;color:#eeeaf9;padding:6px 12px;line-height:1.3;flex:1}.actions button:hover{background:#ffffff20}.actions button[data-action=resume]{background:#8871d6;color:white;border-color:#a28de3}
    button:focus-visible{outline:2px solid #d9c9ff;outline-offset:2px}.foot{margin-top:8px;color:#9994b0;font-size:10px;display:flex;justify-content:space-between;gap:8px}.step{white-space:nowrap}
    .panel[data-state=paused] .mark,.panel[data-state=waiting_user] .mark{background:#9e7629;border-color:#e9bb60}.panel[data-state=user_control] .mark{background:#53647a;border-color:#9aabbf}.panel[data-state=completed] .mark{background:#317961;border-color:#87cdb3}.panel[data-state=failed] .mark{background:#a94b59;border-color:#e8929d}
    .panel[data-collapsed=true] .detail,.panel[data-collapsed=true] .foot,.panel[data-collapsed=true] .title{display:none}.panel[data-collapsed=true]{padding:8px 10px}.panel[data-collapsed=true] .actions{margin-top:7px}
    .target{position:fixed;pointer-events:none;border:2px solid #a48be9;border-radius:6px;box-shadow:0 0 0 3px #ac8fed21;transition:opacity 160ms;z-index:2147483646}.target[data-phase=succeeded]{border-color:#62c7a1}.target[data-phase=failed]{border-color:#eb8e91}
    .cursor{position:fixed;pointer-events:none;filter:drop-shadow(0 2px 2px #0005);z-index:2147483646;width:22px;height:27px;transition:opacity 160ms;transform:translate(-3px,-2px)}
    @media(prefers-reduced-motion:reduce){.target,.cursor{transition:none}}
  `;
  class ZenPageUi {
    constructor(onAction, documentId) {
      this.onAction = onAction;
      this.documentId = documentId;
      this.nativeLease = null;
      this.visibleSince = document.hidden ? 0 : Date.now();
      this.focusedSince = document.hasFocus() ? Date.now() : 0;
      this.host = null;
      this.baseTitle = document.title;
      this.appliedTitle = null;
      this.lastPrefix = '';
      this.state = null;
      this.timer = null;
      this.targetElement = null;
      this.onScroll = () => this.positionTarget();
      window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
      window.addEventListener('resize', this.onScroll, { passive: true });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.visibleSince = Date.now(); this.render(); this.updateBinding(); });
      window.addEventListener('focus', event => { if (event.target === window) { this.focusedSince = Date.now(); this.updateBinding(); } }, true);
    }
    mount() {
      if (this.host?.isConnected || !document.documentElement) return;
      const host = document.createElement('zen-ai-control');
      this.host = host;
      host.setAttribute('role', 'region');
      host.setAttribute('aria-label', 'Zen AI 控制');
      const root = host.attachShadow({ mode: 'closed' });
      this.binding = document.createElement('meta'); this.binding.name = 'zen-native-binding'; root.append(this.binding);
      const style = document.createElement('style'); style.textContent = STYLE; root.append(style);
      this.edge = document.createElement('div'); this.edge.className = 'edge'; this.edge.hidden = window !== window.top; root.append(this.edge);
      const panel = document.createElement('section'); panel.className = 'panel';
      panel.innerHTML = '<header><span class="mark">AI</span><div class="heading"><span class="label"></span><span class="mode"></span><span class="title"></span></div><button class="collapse" data-action="collapse" aria-label="收起或展开状态面板" title="收起 / 展开">−</button></header><p class="detail" role="status" aria-live="polite"></p><div class="actions"><button data-action="pause">暂停</button><button data-action="resume">继续</button><button data-action="takeover">接管</button></div><div class="foot"><span class="step"></span><span>点击网页会接管 · 悬停仅观看</span></div>';
      root.append(panel); this.panel = panel;
      this.ring = document.createElement('div'); this.ring.className = 'target'; this.ring.hidden = true; root.append(this.ring);
      this.cursor = document.createElement('div'); this.cursor.className = 'cursor'; this.cursor.hidden = true;
      this.cursor.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 27"><path d="M2 1v21l5-6 5 9 4-2-5-9h9z" fill="#967ee0" stroke="white" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      root.append(this.cursor);
      if (window !== window.top) panel.hidden = true;
      root.addEventListener('click', event => {
        const action = event.target.closest?.('button[data-action]')?.dataset.action;
        if (!action || !event.isTrusted) return;
        event.preventDefault();
        Promise.resolve(this.onAction(action)).catch(error => this.localMessage(error.message));
      });
      document.documentElement.append(host);
      this.titleObserver = new MutationObserver(() => this.updateTitle());
      if (document.head && window === window.top) this.titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
      this.render();
    }
    contains(event) { return !!this.host && event.composedPath().includes(this.host); }
    update(state) {
      if (state.epoch !== this.state?.epoch || !state.controlled) { this.nativeLease = null; this.nativeBlocked = false; }
      this.state = state; this.mount(); this.render(); this.updateTitle(); this.updateBinding(); this.updateIcon();
    }
    updateBinding() {
      if (!this.binding) return;
      let expected = null;
      try { const old = JSON.parse(this.binding.content); if (old.token === this.nativeLease?.token) expected = old.expected; } catch {}
      this.binding.content = JSON.stringify({ documentId: this.documentId, epoch: this.state?.epoch, controlled: !!this.state?.controlled && !this.nativeBlocked,
        token: this.nativeLease?.token || null, expected, visibleSince: this.visibleSince, focusedSince: this.focusedSince });
    }
    beginNative(deadline) {
      this.nativeBlocked = false;
      this.nativeLease = { documentId: this.documentId, epoch: this.state.epoch, token: crypto.randomUUID(), url: location.href, deadline };
      this.updateBinding(); return this.nativeLease;
    }
    endNative() { this.nativeLease = null; this.updateBinding(); }
    blockNative() { this.nativeBlocked = true; this.nativeLease = null; this.updateBinding(); }
    expectedNative() {
      if (!this.nativeLease || this.nativeBlocked || Date.now() >= this.nativeLease.deadline) return null;
      try {
        const value = JSON.parse(this.binding.content);
        if (!value.controlled || value.token !== this.nativeLease.token || value.epoch !== this.state.epoch) return null;
        return typeof value.expected === 'string' ? JSON.parse(value.expected) : value.expected;
      } catch { return null; }
    }
    localMessage(message) { this.mount(); if (this.panel) this.panel.querySelector('.detail').textContent = message; }
    render() {
      if (!this.panel || !this.state) return;
      const s = this.state, active = ['observing', 'idle', 'running'].includes(s.state);
      this.panel.dataset.state = s.state;
      this.edge.style.setProperty('--edge-color', ({ paused: '#c8a052', waiting_user: '#c8a052', user_control: '#8395ac', completed: '#62b899', failed: '#dd7885' })[s.state] || '#a48be9');
      this.panel.dataset.collapsed = String(!!s.collapsed);
      this.panel.querySelector('.label').textContent = s.stopping ? '正在停止' : s.label;
      this.panel.querySelector('.mode').textContent = active ? document.hidden ? '后台' : '观看' : s.state === 'user_control' ? '手动' : s.state === 'completed' ? '结果保留' : '';
      this.panel.querySelector('.title').textContent = s.taskTitle;
      this.panel.querySelector('.detail').textContent = s.state === 'running' && s.step ? s.step.label : s.state === 'idle' && s.step?.phase === 'succeeded' ? s.step.label + (s.step.command === 'wait' ? ' · 条件已满足' : ' · 已执行') : s.reason;
      this.panel.querySelector('.step').textContent = s.step ? '第 ' + s.step.number + ' 步 · ' + ({ preparing: '定位目标', running: '执行中', succeeded: '已执行', failed: '失败', interrupted: '已中止后续' })[s.step.phase] : '尚未执行网页操作';
      this.panel.querySelector('[data-action=pause]').hidden = !active;
      this.panel.querySelector('[data-action=resume]').hidden = active || s.state === 'completed';
      this.panel.querySelector('[data-action=resume]').disabled = !s.canResume;
      this.panel.querySelector('[data-action=takeover]').disabled = s.state === 'user_control' || s.state === 'completed';
      this.panel.querySelector('.actions').hidden = s.state === 'completed';
      this.panel.querySelector('.foot span:last-child').textContent = active ? '点击网页会接管 · 悬停仅观看' : s.state === 'completed' ? '任务已结束，页面为你保留' : '可以修改页面 · 继续后重新观察';
      this.panel.querySelector('[data-action=collapse]').textContent = s.collapsed ? '+' : '−';
      if (!active) this.clearTarget();
    }
    updateTitle() {
      if (!this.state || window !== window.top || !document.head) return;
      const current = document.title;
      if (current !== this.appliedTitle) this.baseTitle = this.lastPrefix && current.startsWith(this.lastPrefix) ? current.slice(this.lastPrefix.length) : current;
      const marker = ({ observing: '观察', idle: '待命', running: '运行', paused: '暂停', user_control: '接管', waiting_user: '待确认', completed: '完成', failed: '失败' })[this.state.state];
      this.lastPrefix = '[AI·' + marker + '] ';
      this.appliedTitle = this.lastPrefix + this.baseTitle;
      if (document.title !== this.appliedTitle) document.title = this.appliedTitle;
    }
    updateIcon() {
      if (!this.state || window !== window.top || !document.head) return;
      const state = this.state.state;
      if (this.iconState === state && this.icon?.isConnected) return;
      if (!this.icon) { this.icon = document.createElement('link'); this.icon.rel = 'icon'; this.icon.type = 'image/svg+xml'; this.icon.sizes = 'any'; }
      const color = ({ paused: '#ac7d2a', waiting_user: '#ac7d2a', user_control: '#52677f', completed: '#27785d', failed: '#ad3e54' })[state] || '#7560ce';
      const glyph = state === 'completed' ? '<path d="m8 16 5 5 11-12" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
        : state === 'paused' ? '<path d="M11 8v16M21 8v16" stroke="white" stroke-width="5"/>'
          : '<text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="18" fill="white">' + (state === 'failed' ? '!' : state === 'user_control' ? 'U' : 'AI') + '</text>';
      this.icon.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="' + color + '"/>' + glyph + '</svg>');
      document.head.append(this.icon); this.iconState = state;
    }
    target(element, phase = 'preparing', pointer = true) {
      this.mount();
      this.targetElement = element;
      this.showPointer = pointer;
      if (!this.ring) return;
      clearTimeout(this.timer);
      this.ring.dataset.phase = phase;
      this.positionTarget();
      if (phase === 'succeeded' || phase === 'failed') this.timer = setTimeout(() => this.clearTarget(), 550);
    }
    positionTarget() {
      if (!this.targetElement?.isConnected || !this.ring) return;
      const rect = this.targetElement.getBoundingClientRect();
      if (this.panel && !this.panel.hidden) {
        const panelRect = this.host.getBoundingClientRect();
        if (rect.left < panelRect.right && rect.right > panelRect.left && rect.top < panelRect.bottom && rect.bottom > panelRect.top) {
          const left = rect.left > innerWidth / 2 ? '16px' : 'auto';
          this.host.style.setProperty('--zen-ai-left', left);
          this.host.style.setProperty('--zen-ai-right', left === 'auto' ? '16px' : 'auto');
          if (rect.width > innerWidth * .75 && rect.bottom > innerHeight - 170) {
            this.host.style.setProperty('--zen-ai-top', '16px'); this.host.style.setProperty('--zen-ai-bottom', 'auto');
          }
        }
      }
      Object.assign(this.ring.style, { left: rect.x - 3 + 'px', top: rect.y - 3 + 'px', width: rect.width + 6 + 'px', height: rect.height + 6 + 'px' });
      Object.assign(this.cursor.style, { left: rect.x + rect.width / 2 + 'px', top: rect.y + rect.height / 2 + 'px' });
      this.ring.hidden = false; this.cursor.hidden = !this.showPointer;
    }
    clearTarget() { clearTimeout(this.timer); this.targetElement = null; if (this.ring) this.ring.hidden = true; if (this.cursor) this.cursor.hidden = true; }
  }
  globalThis.ZenPageUi = ZenPageUi;
})();
