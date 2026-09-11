import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { ConnectionPage } from '../server/connection-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture() {
  const calls = [];
  const manager = {
    state: async () => ({ status: 'disconnected', reason: 'ready for review', browsers: [], profiles: [], selection: {} }),
    plan: async () => { calls.push('plan'); return { public: { needsConfirmation: true }, token: 'one-use-ticket' }; },
    apply: async token => { calls.push(token); return { status: 'connected' }; }
  };
  const page = new ConnectionPage(manager, root), url = await page.start();
  const request = (body, headers = {}) => fetch(url + 'rpc', { method: 'POST', headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { page, url, calls, request };
}

test('local connection page reuses the shipped UI with no external scripts or setup side effects', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.url), html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(html, /<iframe id="app"/);
    const component = await fetch(f.url + 'component'); assert.equal(component.status, 200);
    assert.match(await component.text(), /确认连接 Zen/);
    assert.deepEqual(f.calls, []);
    assert.equal(await f.page.start(), f.url);
  } finally { f.page.close(); }
});

test('local page rejects other origins, hostnames, missing access paths and non-connection tools', async () => {
  const f = await fixture();
  try {
    const body = { name: 'zen_connection_apply', arguments: { ticket: 'one-use-ticket' } };
    assert.equal((await f.request(body, { Origin: 'https://example.invalid' })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const request = httpRequest(f.url + 'rpc', { method: 'POST', headers: { Host: 'example.invalid', Origin: new URL(f.url).origin, 'Content-Type': 'application/json' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end(JSON.stringify(body));
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(new URL('/', f.url))).status, 403);
    assert.equal((await f.request(body, { 'Content-Type': 'text/plain' })).status, 403);
    const rejected = await (await f.request({ name: 'zen_click', arguments: { tabId: 1 } })).json();
    assert.equal(rejected.isError, true);
    assert.deepEqual(f.calls, []);
  } finally { f.page.close(); }
});

test('oversized local page requests are rejected before invoking a connection operation', async () => {
  const f = await fixture();
  try {
    const response = await f.request({ name: 'zen_connection_plan', arguments: { value: '测'.repeat(24000) } });
    assert.equal(response.status, 413); assert.deepEqual(f.calls, []);
  } finally { f.page.close(); }
});

test('local page validates arguments and keeps preview separate from the explicit apply request', async () => {
  const f = await fixture();
  try {
    const invalid = await (await f.request({ name: 'zen_connection_apply', arguments: { ticket: 'one-use-ticket', force: true } })).json();
    assert.equal(invalid.isError, true); assert.deepEqual(f.calls, []);
    const plan = await (await f.request({ name: 'zen_connection_plan', arguments: {} })).json();
    assert.equal(plan._meta.confirmationTicket, 'one-use-ticket'); assert.deepEqual(f.calls, ['plan']);
    const apply = await (await f.request({ name: 'zen_connection_apply', arguments: { ticket: plan._meta.confirmationTicket } })).json();
    assert.equal(apply.structuredContent.status, 'connected'); assert.deepEqual(f.calls, ['plan', 'one-use-ticket']);
  } finally { f.page.close(); }
});
