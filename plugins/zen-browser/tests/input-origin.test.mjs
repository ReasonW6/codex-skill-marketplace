import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../extension/input-origin.js', import.meta.url), 'utf8'), context);
test('trusted focus, visibility, scrolling and hover do not imply takeover', () => {
  const origin = new context.ZenInputOrigin();
  for (const type of ['focus', 'blur', 'visibilitychange', 'scroll', 'pointermove', 'mouseover', 'pointerenter']) assert.equal(origin.classify({ type, isTrusted: true }), null);
});
test('extension-marked events are distinguished from physical input', () => {
  const origin = new context.ZenInputOrigin(), event = { type: 'pointerdown', isTrusted: true, buttons: 1, pointerType: 'mouse' };
  origin.dispatch({ dispatchEvent: () => true }, event);
  assert.equal(origin.classify(event), null);
  assert.equal(origin.classify({ ...event }), 'human');
});
test('trusted browser editing events inside the execution fence do not cause false takeover', () => {
  const origin = new context.ZenInputOrigin();
  origin.runOwned(() => {
    assert.equal(origin.classify({ type: 'beforeinput', isTrusted: true }), null);
    assert.equal(origin.classify({ type: 'input', isTrusted: true }), null);
  });
  assert.equal(origin.classify({ type: 'beforeinput', isTrusted: true }), 'external-edit');
});
test('physical pointer and keyboard intent is never suppressed by the execution fence', () => {
  const origin = new context.ZenInputOrigin();
  origin.runOwned(() => {
    assert.equal(origin.classify({ type: 'pointerdown', isTrusted: true, buttons: 1, pointerType: 'mouse' }), 'human');
    assert.equal(origin.classify({ type: 'keydown', isTrusted: true, key: 'a' }), 'human');
  });
});
test('synthetic page events and modifier-only keys do not trigger takeover', () => {
  const origin = new context.ZenInputOrigin();
  assert.equal(origin.classify({ type: 'keydown', key: 'a', isTrusted: false }), null);
  assert.equal(origin.classify({ type: 'keydown', key: 'Control', isTrusted: true }), null);
});
test('native paste, composition, wheel and physical drag are recognized', () => {
  const origin = new context.ZenInputOrigin();
  for (const type of ['paste', 'drop', 'cut', 'compositionstart']) assert.equal(origin.classify({ type, isTrusted: true }), 'human');
  assert.equal(origin.classify({ type: 'wheel', deltaX: 0, deltaY: 30, isTrusted: true }), 'human');
  assert.equal(origin.classify({ type: 'dragstart', isTrusted: true }), 'human');
  assert.equal(origin.classify({ type: 'pointerdown', pointerType: 'touch', isPrimary: false, isTrusted: true }), 'human');
  assert.equal(origin.classify({ type: 'click', isTrusted: true }), 'human');
});
