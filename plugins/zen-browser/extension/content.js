/* global browser */
(() => {
  'use strict';
  if (globalThis.__reasonw6ZenContent) return;
  globalThis.__reasonw6ZenContent = true;
  let refs = new Map();
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
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
  function guard(message) {
    if (Date.now() >= message.deadline) fail('TIMEOUT', 'Request expired before the page action.');
    // Zen split views can be visible even when tabs.active is false.
    if (!document.hidden) fail('FOREGROUND_TAB', 'This page is visible to the user. Background control is paused.');
    if (window === window.top && location.href !== message.expectedTopUrl) fail('NAVIGATION_CHANGED', 'Page navigation changed while preparing the action. Read a fresh snapshot.');
  }
  function query(selector) {
    try { return roots().flatMap(root => [...root.querySelectorAll(selector)]); }
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
    return element.dispatchEvent(new Constructor(type, { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y,
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
    if (!element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertReplacementText', data: text }))) fail('INPUT_CANCELLED', 'The page cancelled beforeinput.');
    if (element.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      // Firefox's editing engine supports rich-text editors and undo history here.
      if (!document.execCommand('insertText', false, text)) {
        element.textContent = text;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      }
    } else {
      const prototype = element.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { value: element.type === 'password' ? '[redacted]' : element.isContentEditable ? element.innerText : element.value };
  }
  function press(element, p) {
    const keys = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (![...p.key].length || ([...p.key].length !== 1 && !keys.includes(p.key))) fail('UNSUPPORTED_KEY', 'Unsupported synthetic key.');
    if (p.ctrl || p.alt || p.meta) fail('UNSUPPORTED_SHORTCUT', 'Native/system shortcuts cannot be performed safely by this background bridge.');
    element.focus({ preventScroll: true });
    const options = { key: p.key, bubbles: true, cancelable: true, composed: true, shiftKey: !!p.shift };
    const allowed = element.dispatchEvent(new KeyboardEvent('keydown', options));
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
    element.dispatchEvent(new KeyboardEvent('keyup', options));
    return { key: p.key, dispatched: true, synthetic: true, defaultPrevented: !allowed };
  }
  browser.runtime.onMessage.addListener(message => {
    if (message?.channel !== 'reasonw6-zen-v1') return undefined;
    try {
      const p = message.params;
      guard(message);
      let result;
      if (message.command === 'snapshot') {
        refs = new Map();
        const snapshotId = crypto.randomUUID();
        const candidates = query('a[href],button,input,textarea,select,[role],[contenteditable=true],[tabindex],summary,h1,h2,h3,h4,h5,h6').filter(visible);
        const maxElements = p.maxElements ?? 150;
        const elements = candidates.slice(0, maxElements).map((element, i) => {
          const ref = `${snapshotId}:${i + 1}`; refs.set(ref, element); return describe(element, ref);
        });
        const text = pageText(), maxChars = p.maxChars ?? 18000;
        result = { snapshotId, url: location.href, title: document.title, readyState: document.readyState, text: text.slice(0, maxChars),
          textTruncated: text.length > maxChars, elements, elementsTruncated: candidates.length > maxElements,
          viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, untrustedContent: true };
      } else if (message.command === 'probe') {
        result = { found: (!p.text || pageText().includes(p.text)) && (!p.selector || query(p.selector).some(visible)), url: location.href };
      } else if (message.command === 'scroll') {
        const element = p.ref || p.selector ? target(p) : window;
        element.scrollBy({ left: p.x ?? 0, top: p.y, behavior: 'instant' });
        result = { x: element === window ? scrollX : element.scrollLeft, y: element === window ? scrollY : element.scrollTop };
      } else {
        const element = target(p);
        guard(message);
        if (message.command === 'click') { click(element); result = { clicked: true, synthetic: true }; }
        else if (message.command === 'fill') result = fill(element, p.text);
        else if (message.command === 'check') {
          if (!element.matches('input[type=checkbox],input[type=radio]')) fail('NOT_CHECKABLE', 'Target is not a native checkbox or radio.');
          if (element.type === 'radio' && !p.checked) fail('RADIO_UNCHECK', 'Select a different radio option to clear a radio.');
          if (element.checked !== p.checked) click(element);
          if (element.checked !== p.checked) fail('CHECK_FAILED', 'The page did not accept the requested checked state.');
          result = { checked: element.checked };
        } else if (message.command === 'select') {
          if (element.localName !== 'select') fail('NOT_SELECT', 'Target is not a native select.');
          if (!element.multiple && p.values.length !== 1) fail('INVALID_OPTIONS', 'A single-select requires exactly one value.');
          const options = [...element.options];
          for (const value of p.values) if (!options.some(o => o.value === value && !o.disabled && !o.parentElement.disabled)) fail('OPTION_NOT_FOUND', `No enabled option has value ${value}.`);
          for (const option of options) option.selected = p.values.includes(option.value);
          element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          result = { values: [...element.selectedOptions].map(o => o.value) };
        } else if (message.command === 'press') result = press(element, p);
        else fail('UNKNOWN_COMMAND', 'Unsupported page command.');
      }
      return Promise.resolve({ result });
    } catch (error) { return Promise.resolve({ error: { code: error.code || 'PAGE_ERROR', message: String(error.message).slice(0, 2000) } }); }
  });
})();
