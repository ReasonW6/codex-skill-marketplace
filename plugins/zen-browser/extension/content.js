/* global browser, ZenInputOrigin, ZenPageUi */
(() => {
  'use strict';
  if (globalThis.__reasonw6ZenPageV2) return;
  const documentId = crypto.randomUUID();
  const origin = new ZenInputOrigin();
  let refs = new Map(), lastSnapshotId = null, channel = null, state = null;
  let blocked = true, stoppedAtEpoch = null, reconnectTimer = null;
  const waiting = new Map();
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const ui = new ZenPageUi(action => control(action));
  globalThis.__reasonw6ZenPageV2 = true;
  function clearReferences() { refs.clear(); lastSnapshotId = null; }
  function applyState(next) {
    if (state && next.epoch < state.epoch) return;
    if (!state || next.epoch !== state.epoch) clearReferences();
    state = next;
    if (stoppedAtEpoch !== null && next.epoch > stoppedAtEpoch) stoppedAtEpoch = null;
    blocked = !next.controlled || stoppedAtEpoch !== null;
    ui.update(next);
  }
  function sendAndWait(message, kind, timeout = 10000) {
    const peer = channel;
    if (!peer) return Promise.reject(Object.assign(new Error('扩展连接已断开'), { code: 'DISCONNECTED' }));
    const key = kind + ':' + message.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(key); reject(Object.assign(new Error('控制确认超时，页面仍保持停止'), { code: 'TIMEOUT' })); }, timeout);
      waiting.set(key, { resolve, reject, timer, peer });
      try { peer.postMessage(message); }
      catch (error) { clearTimeout(timer); waiting.delete(key); reject(error); }
    });
  }
  function control(action, reason) {
    if (['pause', 'takeover', 'external-input'].includes(action)) {
      blocked = true;
      stoppedAtEpoch = state?.epoch ?? 0;
      clearReferences(); ui.clearTarget();
      ui.localMessage('正在停止后续指令；已发生的网页动作不会撤销');
    }
    return sendAndWait({ type: 'user-control', id: crypto.randomUUID(), action, reason, epoch: state?.epoch }, 'control-result').then(next => {
      applyState(next); return next;
    });
  }
  function userInput(event) {
    if (!state?.controlled || blocked || ui.contains(event)) return;
    const kind = origin.classify(event);
    if (!kind) return;
    control(kind === 'human' ? 'takeover' : 'external-input', 'input').catch(error => ui.localMessage(error.message));
    // Let the user's original event reach the page. The AI relinquishes control.
  }
  for (const type of ['pointerdown', 'click', 'keydown', 'wheel', 'dragstart', 'paste', 'cut', 'drop', 'compositionstart', 'beforeinput', 'input']) {
    window.addEventListener(type, userInput, { capture: true, passive: true });
  }
  function guard(message, peer) {
    if (channel !== peer || !state) fail('DISCONNECTED', 'The page connection changed before execution.');
    if (Date.now() >= message.deadline) fail('TIMEOUT', 'Request expired before the page action.');
    if (message.epoch !== state.epoch) fail('CONTROL_CHANGED', 'Control changed after this instruction was sent. It was not replayed.');
    if (message.documentId !== documentId) fail('NAVIGATION_CHANGED', 'The instruction belongs to another document.');
    if (message.write && (blocked || !state.controlled)) fail('CONTROL_STOPPED', 'Human control or a pause has stopped pending page writes.');
    if (message.write && (!lastSnapshotId || message.snapshotId !== lastSnapshotId)) fail('OBSERVATION_REQUIRED', 'Read a fresh snapshot before writing to this document.');
    if (window === window.top && location.href !== message.expectedTopUrl) fail('NAVIGATION_CHANGED', 'Navigation changed the page. Read a fresh snapshot.');
  }
  function paintOpportunity() {
    if (document.hidden) return Promise.resolve();
    return new Promise(resolve => {
      let done = false, frame;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
      const timer = setTimeout(finish, 24);
      frame = requestAnimationFrame(finish);
    });
  }
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  const roots = () => {
    const list = [document];
    for (let i = 0; i < list.length; i++) for (const element of list[i].querySelectorAll('*')) if (element.shadowRoot) list.push(element.shadowRoot);
    return list;
  };
  function visible(element) {
    if (!element?.isConnected || element.closest('[hidden], [inert]')) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return !!(rect.width && rect.height) && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && Number(style.opacity) !== 0;
  }
  function query(selector) {
    try { return roots().flatMap(root => [...root.querySelectorAll(selector)]).filter(element => !element.closest('zen-ai-control')); }
    catch { fail('INVALID_SELECTOR', 'The supplied CSS selector is invalid.'); }
  }
  function target(p, { writable = true } = {}) {
    if (!!p.ref === !!p.selector) fail('INVALID_TARGET', 'Supply exactly one element ref or CSS selector.');
    let element;
    if (p.ref) {
      element = refs.get(p.ref);
      if (!element?.isConnected) fail('STALE_REF', 'This element ref is stale. Read a new snapshot.');
    } else {
      const matches = query(p.selector).filter(visible);
      if (matches.length !== 1) fail(matches.length ? 'AMBIGUOUS_TARGET' : 'ELEMENT_NOT_FOUND', `Selector matched ${matches.length} visible elements; exactly one is required.`);
      element = matches[0];
    }
    if (!visible(element)) fail('ELEMENT_HIDDEN', 'Element is not visible in its page.');
    if (writable && (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || element.closest('[inert]'))) fail('ELEMENT_DISABLED', 'Element is disabled.');
    return element;
  }
  function role(element) {
    if (element.getAttribute('role')) return element.getAttribute('role');
    const tag = element.localName;
    if (tag === 'a') return 'link';
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(element.type))) return 'button';
    if (tag === 'input' && ['checkbox', 'radio'].includes(element.type)) return element.type;
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea' || tag === 'input' || element.isContentEditable) return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  }
  function name(element) {
    const root = element.getRootNode();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = labelledBy.split(/\s+/).map(id => root.getElementById?.(id)?.textContent || '').join(' ');
      if (clean(label)) return clean(label);
    }
    return clean(element.getAttribute('aria-label') || [...(element.labels || [])].map(l => l.innerText).join(' ') || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || (element.matches('input[type=submit],input[type=button]') ? element.value : element.innerText || element.textContent)).slice(0, 300);
  }
  function describe(element, ref) {
    const rect = element.getBoundingClientRect();
    const info = { ref, role: role(element), name: name(element), tag: element.localName,
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    if (element.id) info.id = element.id;
    if (element.type) info.type = element.type;
    if (element.href && /^https?:/.test(element.href)) info.href = element.href;
    if ('checked' in element) info.checked = element.checked;
    if ('value' in element && !['password', 'file'].includes(element.type)) info.value = String(element.value).slice(0, 2000);
    if (element.type === 'password') info.value = '[redacted]';
    if (element.localName === 'select') info.options = [...element.options].slice(0, 100).map(o => ({ value: o.value, label: o.label, selected: o.selected, disabled: o.disabled }));
    return info;
  }
  function pageText() {
    return roots().map(root => root === document ? document.body?.innerText || '' : [...root.children].map(e => e.innerText || '').join('\n')).join('\n');
  }
  function ensureClickable(element) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    ui.target(element, 'running');
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot?.elementFromPoint(x, y) && hit.shadowRoot.elementFromPoint(x, y) !== hit) hit = hit.shadowRoot.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) fail('ELEMENT_COVERED', 'Another element covers the target. Read the page before retrying.');
    return { x, y };
  }
  function pointer(element, type, point) {
    const Constructor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    return origin.dispatch(element, new Constructor(type, { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y,
      button: 0, buttons: type.endsWith('down') ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  }
  function click(element) {
    const point = ensureClickable(element);
    // New windows and target=_blank links can grab focus; open such URLs with zen_open.
    const link = element.closest('a[href]');
    const baseTarget = document.querySelector('base[target]')?.target;
    const linkTarget = link?.getAttribute('target') ?? baseTarget;
    if (link && !/^https?:/.test(link.href)) fail('UNSUPPORTED_LINK', 'Links opening native applications or non-HTTP(S) URLs are unsupported.');
    if (link && (linkTarget && linkTarget !== '_self' || link.download)) fail('NEW_TAB_LINK', 'Use zen_open with this link URL; opening a new window via click could affect foreground focus.');
    const formTarget = element.getAttribute('formtarget') ?? element.form?.getAttribute('target') ?? baseTarget;
    if (element.form && ['submit', 'image'].includes(element.type) && formTarget && formTarget !== '_self') fail('NEW_WINDOW_FORM', 'This form submits to another window and could affect foreground focus.');
    element.focus({ preventScroll: true });
    pointer(element, 'pointerover', point); pointer(element, 'mouseover', point);
    pointer(element, 'pointerdown', point); pointer(element, 'mousedown', point);
    pointer(element, 'pointerup', point); pointer(element, 'mouseup', point);
    element.click();
  }
  function fill(element, text) {
    if (element.readOnly) fail('READ_ONLY', 'Field is read-only.');
    if (element.type === 'file') fail('UNSUPPORTED_FILE_INPUT', 'Native file selection is not supported by this background extension.');
    if (!element.matches('input,textarea') && !element.isContentEditable) fail('NOT_EDITABLE', 'Target is not a text-editable field.');
    if (element.matches('input') && !['text', 'search', 'tel', 'url', 'email', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(element.type)) fail('NOT_EDITABLE', 'Use zen_check, zen_select, or zen_click for this input type.');
    element.focus({ preventScroll: true });
    if (!origin.dispatch(element, new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertReplacementText', data: text }))) fail('INPUT_CANCELLED', 'The page cancelled beforeinput.');
    if (element.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      // Firefox's editing engine supports rich-text editors and undo history here.
      if (!document.execCommand('insertText', false, text)) {
        element.textContent = text;
        origin.dispatch(element, new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      }
    } else {
      const prototype = element.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
      origin.dispatch(element, new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
    }
    origin.dispatch(element, new Event('change', { bubbles: true, composed: true }));
    return { value: element.type === 'password' ? '[redacted]' : element.isContentEditable ? element.innerText : element.value };
  }
  function press(element, p) {
    const keys = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (![...p.key].length || ([...p.key].length !== 1 && !keys.includes(p.key))) fail('UNSUPPORTED_KEY', 'Unsupported synthetic key.');
    if (p.ctrl || p.alt || p.meta) fail('UNSUPPORTED_SHORTCUT', 'Native/system shortcuts cannot be performed safely by this background bridge.');
    element.focus({ preventScroll: true });
    const options = { key: p.key, bubbles: true, cancelable: true, composed: true, shiftKey: !!p.shift };
    const allowed = origin.dispatch(element, new KeyboardEvent('keydown', options));
    if (allowed) {
      if (p.key === 'Enter') {
        if (element.matches('button,a,input[type=button],input[type=submit]')) click(element);
        else if (element.localName === 'textarea' || element.isContentEditable) fill(element, (element.value ?? element.innerText) + '\n');
        else if (element.form) {
          if (element.form.target && element.form.target !== '_self') fail('NEW_WINDOW_FORM', 'Form targets another window.');
          element.form.requestSubmit();
        }
      } else if (p.key === 'Tab') {
        const list = query('a[href],button,input,textarea,select,[tabindex],[contenteditable=true]').filter(e => visible(e) && !e.matches(':disabled') && e.tabIndex >= 0);
        const index = list.indexOf(element);
        list[(index + (p.shift ? -1 : 1) + list.length) % list.length]?.focus({ preventScroll: true });
      } else if ('selectionStart' in element && element.selectionStart !== null) {
        let start = element.selectionStart, end = element.selectionEnd;
        if (p.key === 'Backspace' || p.key === 'Delete' || [...p.key].length === 1) {
          if (p.key === 'Backspace' && start === end) start = Math.max(0, start - 1);
          if (p.key === 'Delete' && start === end) end = Math.min(element.value.length, end + 1);
          const text = [...p.key].length === 1 ? p.key : '';
          fill(element, element.value.slice(0, start) + text + element.value.slice(end));
          element.setSelectionRange(start + text.length, start + text.length);
        } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(p.key)) {
          const position = p.key === 'Home' ? 0 : p.key === 'End' ? element.value.length : Math.max(0, Math.min(element.value.length, start + (p.key === 'ArrowLeft' ? -1 : 1)));
          element.setSelectionRange(p.shift ? start : position, position);
        }
      }
    }
    origin.dispatch(element, new KeyboardEvent('keyup', options));
    return { key: p.key, dispatched: true, synthetic: true, defaultPrevented: !allowed };
  }
  const COMMAND_LABELS = { click: '点击', fill: '填写', select: '选择', check: '勾选', press: '按键', scroll: '滚动' };
  async function handle(message, peer) {
    guard(message, peer);
    const p = message.params;
    if (message.command === 'snapshot') {
      refs = new Map();
      const snapshotId = crypto.randomUUID();
      const candidates = query('a[href],button,input,textarea,select,[role],[contenteditable=true],[tabindex],summary,h1,h2,h3,h4,h5,h6').filter(visible);
      const maxElements = p.maxElements ?? 150;
      const elements = candidates.slice(0, maxElements).map((element, i) => {
        const ref = snapshotId + ':' + (i + 1); refs.set(ref, element); return describe(element, ref);
      });
      lastSnapshotId = snapshotId;
      const text = pageText(), maxChars = p.maxChars ?? 18000;
      return { snapshotId, documentId, url: location.href, title: document.title, readyState: document.readyState,
        text: text.slice(0, maxChars), textTruncated: text.length > maxChars, elements, elementsTruncated: candidates.length > maxElements,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, untrustedContent: true };
    }
    if (message.command === 'probe') return { found: (!p.text || pageText().includes(p.text)) && (!p.selector || query(p.selector).some(visible)), url: location.href };
    const element = message.command === 'scroll' && !p.ref && !p.selector ? null : target(p);
    const label = COMMAND_LABELS[message.command] + (element ? '「' + (name(element) || element.localName) + '」' : '页面');
    peer.postMessage({ type: 'target', id: message.id, label });
    if (element) ui.target(element, 'preparing', message.command === 'click' || message.command === 'check');
    await paintOpportunity();
    guard(message, peer);
    // The background process grants a single use permit immediately before commit.
    // Local input can still stop this document before the permit reply arrives.
    await sendAndWait({ type: 'authorize', id: message.id, documentId }, 'permit', Math.max(1, message.deadline - Date.now()));
    guard(message, peer);
    let result;
    try {
      result = origin.runOwned(() => {
        if (element && message.command !== 'scroll') {
          element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          ui.target(element, 'running', message.command === 'click' || message.command === 'check');
        }
        if (message.command === 'scroll') {
          const scroller = element || window;
          scroller.scrollBy({ left: p.x ?? 0, top: p.y, behavior: 'instant' });
          return { x: scroller === window ? scrollX : scroller.scrollLeft, y: scroller === window ? scrollY : scroller.scrollTop };
        }
        if (message.command === 'click') { click(element); return { dispatched: true, synthetic: true }; }
        if (message.command === 'fill') return fill(element, p.text);
        if (message.command === 'check') {
          if (!element.matches('input[type=checkbox],input[type=radio]')) fail('NOT_CHECKABLE', 'Target is not a native checkbox or radio.');
          if (element.type === 'radio' && !p.checked) fail('RADIO_UNCHECK', 'Select another radio to clear this one.');
          if (element.checked !== p.checked) click(element);
          if (element.checked !== p.checked) fail('CHECK_FAILED', 'The page did not accept the requested checked state.');
          return { checked: element.checked };
        }
        if (message.command === 'select') {
          if (element.localName !== 'select') fail('NOT_SELECT', 'Target is not a native select.');
          if (!element.multiple && p.values.length !== 1) fail('INVALID_OPTIONS', 'A single-select requires exactly one value.');
          const options = [...element.options];
          for (const value of p.values) if (!options.some(o => o.value === value && !o.disabled && !o.parentElement.disabled)) fail('OPTION_NOT_FOUND', 'No enabled option has the requested value.');
          for (const option of options) option.selected = p.values.includes(option.value);
          origin.dispatch(element, new Event('input', { bubbles: true, composed: true }));
          origin.dispatch(element, new Event('change', { bubbles: true, composed: true }));
          return { values: [...element.selectedOptions].map(o => o.value) };
        }
        if (message.command === 'press') return press(element, p);
        fail('UNKNOWN_COMMAND', 'Unsupported page command.');
      });
      if (state?.epoch === message.epoch && !blocked && element) ui.target(element, 'succeeded', message.command === 'click' || message.command === 'check');
      return { ...result, summary: label + ' · 指令已执行' };
    } catch (error) {
      if (element && state?.epoch === message.epoch) ui.target(element, 'failed');
      throw error;
    }
  }
  function connect() {
    clearTimeout(reconnectTimer);
    let peer;
    try { peer = browser.runtime.connect({ name: 'zen-page-v2' }); }
    catch { reconnectTimer = setTimeout(connect, 1000); return; }
    channel = peer;
    state = null; blocked = true; stoppedAtEpoch = null;
    peer.onMessage.addListener(message => {
      if (channel !== peer) return;
      if (message.type === 'state') applyState(message.state);
      else if (message.type === 'permit' || message.type === 'control-result') {
        const key = message.type + ':' + message.id, pending = waiting.get(key);
        if (!pending || pending.peer !== peer) return;
        waiting.delete(key); clearTimeout(pending.timer);
        if (message.error || message.allowed === false) pending.reject(Object.assign(new Error(message.error?.message || '操作许可已失效'), { code: message.error?.code || 'CONTROL_CHANGED' }));
        else pending.resolve(message.state || message);
      } else if (message.type === 'command') {
        handle(message, peer).then(result => {
          try { peer.postMessage({ type: 'result', id: message.id, result }); } catch {}
        }).catch(error => {
          try { peer.postMessage({ type: 'result', id: message.id, error: { code: error.code || 'PAGE_ERROR', message: String(error.message).slice(0, 2000) } }); } catch {}
        });
      }
    });
    peer.onDisconnect.addListener(() => {
      if (channel !== peer) return;
      channel = null; blocked = true; clearReferences(); ui.clearTarget();
      for (const [id, pending] of waiting) if (pending.peer === peer) {
        clearTimeout(pending.timer); waiting.delete(id); pending.reject(Object.assign(new Error('扩展连接已断开'), { code: 'DISCONNECTED' }));
      }
      if (state) ui.update({ ...state, controlled: false, state: 'waiting_user', label: '连接中断', reason: '页面保持停止，等待重新连接', canResume: false });
      reconnectTimer = setTimeout(connect, 1000);
    });
    peer.postMessage({ type: 'hello', documentId });
  }
  document.addEventListener('readystatechange', () => ui.mount());
  window.addEventListener('pageshow', () => {
    if (!channel) connect();
    else channel.postMessage({ type: 'hello', documentId });
  });
  connect();
})();
