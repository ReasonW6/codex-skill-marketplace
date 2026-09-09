(() => {
  'use strict';
  if (globalThis.ZenInputOrigin) return;
  class ZenInputOrigin {
    ownEvents = new WeakSet();
    executionDepth = 0;
    lastPhysicalInput = 0;
    dispatch(element, event) { this.ownEvents.add(event); return element.dispatchEvent(event); }
    runOwned(action) { this.executionDepth++; try { return action(); } finally { this.executionDepth--; } }
    classify(event, now = Date.now()) {
      if (this.ownEvents.has(event) || event.isTrusted !== true) return null;
      const pointer = event.type === 'pointerdown' && ['mouse', 'pen', 'touch'].includes(event.pointerType) && (event.buttons > 0 || event.pointerType === 'touch');
      const key = event.type === 'keydown' && !['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock'].includes(event.key);
      const wheel = event.type === 'wheel' && (event.deltaX !== 0 || event.deltaY !== 0);
      if (pointer || key || wheel) {
        this.lastPhysicalInput = now;
        // Never ignore actual device intent just because an AI operation is active.
        return 'human';
      }
      // focus(), scrolling and execCommand can create trusted browser events.
      // Their trust bit is not proof of physical input.
      if (this.executionDepth > 0) return null;
      if (['click', 'paste', 'cut', 'drop', 'compositionstart'].includes(event.type)) return 'human';
      if (event.type === 'dragstart') return now - this.lastPhysicalInput < 2500 ? 'human' : null;
      if (event.type === 'beforeinput' || event.type === 'input') {
        return now - this.lastPhysicalInput < 2500 ? 'human' : 'external-edit';
      }
      return null;
    }
  }
  globalThis.ZenInputOrigin = ZenInputOrigin;
})();
