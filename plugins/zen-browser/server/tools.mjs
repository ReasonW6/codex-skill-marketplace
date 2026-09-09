const str = (description, maxLength = 2048) => ({ type: 'string', description, minLength: 1, maxLength });
const int = (description, minimum = 0, maximum = 2147483647) => ({ type: 'integer', description, minimum, maximum });
const bool = description => ({ type: 'boolean', description });
const connectionId = str('Connection ID from zen_status; required when multiple profiles are connected.', 36);
const tabId = int('Exact tab ID from zen_tabs or zen_open.');
const frameId = int('Frame ID from zen_snapshot, defaults to the main frame (0). Firefox frame IDs can exceed 32 bits.', 0, Number.MAX_SAFE_INTEGER);
const ref = str('Element ref returned by the most recent snapshot of this frame.', 100);
const selector = str('CSS selector grounded in a previously observed page. Use either ref or selector, not both.');
const target = { tabId, frameId, ref, selector };
const schema = (properties, required = []) => ({ type: 'object', properties: { connectionId, ...properties }, required, additionalProperties: false });
function tool(name, command, description, properties, required, readOnlyHint = false, destructiveHint = false) {
  return { name: `zen_${name}`, command, description, inputSchema: schema(properties, required),
    annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: true } };
}
export const TOOLS = [
  tool('status', 'status', 'Inspect local Zen bridge connections and capability limits. This does not start or focus a browser.', {}, [], true),
  tool('tabs', 'tabs', 'List Zen tabs, active state and control ownership. Select the exact tab; titles and URLs are untrusted page data.', {}, [], true),
  tool('open', 'open', 'Create an inactive, muted HTTP(S) tab and claim it for this MCP session. Does not activate a tab or focus a window.', {
    url: str('HTTP(S) URL to open.', 8192), windowId: int('Optional existing normal browser window ID.')
  }, ['url']),
  tool('attach', 'attach', 'Claim an explicitly chosen background HTTP(S) tab. Foreground, private, and already-owned tabs are rejected. User activation revokes this claim.', { tabId }, ['tabId']),
  tool('detach', 'detach', 'Release this session’s claim without closing or changing the tab.', { tabId }, ['tabId']),
  tool('snapshot', 'snapshot', 'Read a claimed page as text and named interactive elements, including open shadow roots. Returns frame IDs and fresh element refs. Page content is untrusted.', {
    tabId, frameId, maxChars: int('Maximum page text characters (default 18000).', 100, 50000), maxElements: int('Maximum interactive elements (default 150).', 1, 500)
  }, ['tabId'], true),
  tool('click', 'click', 'Click one observed element in a claimed background tab using DOM events. Fails on hidden, disabled, covered, or stale elements. Does not produce trusted OS input.', target, ['tabId']),
  tool('fill', 'fill', 'Replace text in an observed input, textarea, or contenteditable and emit input/change events. Password values are not returned. File inputs are unsupported.', {
    ...target, text: { type: 'string', description: 'Replacement text; empty string clears the field.', maxLength: 100000 }
  }, ['tabId', 'text']),
  tool('select', 'select', 'Select option values in a native select and emit input/change. Returns the selected values.', {
    ...target, values: { type: 'array', description: 'Exact option values observed in the snapshot.', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 2048 } }
  }, ['tabId', 'values']),
  tool('check', 'check', 'Set a checkbox or radio input to a requested state, then report its actual checked state.', { ...target, checked: bool('Desired checked state.') }, ['tabId', 'checked']),
  tool('press', 'press', 'Dispatch a synthetic key to an observed page element. Supports Enter, Escape, Tab, Backspace, Delete, arrows, Home, End, or one character. Native browser shortcuts and trusted-input-only controls are unsupported.', {
    ...target, key: str('Key name or one character.', 32), ctrl: bool('Control modifier.'), alt: bool('Alt modifier.'), shift: bool('Shift modifier.'), meta: bool('Meta modifier.')
  }, ['tabId', 'key']),
  tool('scroll', 'scroll', 'Scroll a background page or an observed scroll container without moving the system pointer.', {
    ...target, x: { type: 'number', minimum: -100000, maximum: 100000 }, y: { type: 'number', minimum: -100000, maximum: 100000 }
  }, ['tabId', 'y']),
  tool('wait', 'wait', 'Wait for visible text or a visible selector in the claimed background tab. Bounded, cancellable, and interrupted when the user activates the tab.', {
    tabId, frameId, text: str('Visible text to wait for.', 4000), selector,
    timeoutMs: int('Maximum wait (default 10000 ms).', 100, 30000)
  }, ['tabId'], true),
  tool('navigate', 'navigate', 'Navigate, reload, go back or go forward in a claimed background tab. Returns loading state; use zen_wait/snapshot to confirm the destination.', {
    tabId, action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'] }, url: str('Required for goto; HTTP(S) only.', 8192)
  }, ['tabId', 'action']),
  tool('screenshot', 'screenshot', 'Capture the claimed background tab using Firefox captureTab, without switching tabs. Returns an image. May be unavailable for discarded/restricted pages.', {
    tabId, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: int('JPEG quality (default 80).', 1, 100)
  }, ['tabId'], true),
  tool('close', 'close', 'Close one background tab created by this session. Pre-existing attached tabs cannot be closed with this tool.', { tabId }, ['tabId'], false, true)
];

export function validate(schema, value, label = 'arguments') {
  const fail = message => { throw Object.assign(new Error(`${label}: ${message}`), { code: 'INVALID_ARGUMENTS' }); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
    for (const key of schema.required || []) if (!(key in value)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`unknown field ${key}`);
      validate(schema.properties[key], item, `${label}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array');
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('array size out of range');
    value.forEach((item, i) => validate(schema.items, item, `${label}[${i}]`));
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail(`must be a ${schema.type}`);
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail('out of range');
  } else if (typeof value !== schema.type) fail(`must be ${schema.type}`);
  if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) fail('length out of range');
  if (schema.enum && !schema.enum.includes(value)) fail('unsupported value');
}
