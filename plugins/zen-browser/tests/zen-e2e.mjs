import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineDecoder, MAX_RESPONSE } from '../server/wire.mjs';
import { connectMarionette } from './marionette.mjs';
import { build } from 'esbuild';

if (process.platform !== 'win32') throw new Error('The real Zen integration runner currently supports Windows.');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const zen = process.env.ZEN_BINARY;
const mcpConfig = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers.zen_browser;
if (!zen) throw new Error('Set ZEN_BINARY to the installed Zen executable. A fresh test profile is always used.');
const runDir = path.join(root, '.artifacts', `zen-${Date.now()}`);
const profile = path.join(runDir, 'profile');
const bridgeHome = path.join(runDir, 'native-home 空格%');
const extension = path.join(runDir, 'extension');
await mkdir(profile, { recursive: true }); await mkdir(extension, { recursive: true });
const logs = [], checks = [];
const report = { startedAt: new Date().toISOString(), mode: process.env.ZEN_HEADED === '1' ? 'headed-hidden' : 'headless', checks };
function check(name, value) { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); }
const portProbe = createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const marionettePort = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
const prefs = {
  'marionette.port': marionettePort, 'browser.shell.checkDefaultBrowser': false, 'browser.startup.page': 0,
  'browser.startup.homepage': 'about:blank', 'browser.aboutwelcome.enabled': false,
  'zen.welcome-screen.seen': true, 'zen.welcome-screen.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false,
  'app.update.auto': false, 'browser.tabs.warnOnClose': false
};
await writeFile(path.join(profile, 'user.js'), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
for (const entry of await readdir(path.join(root, 'extension'))) {
  let data = await readFile(path.join(root, 'extension', entry));
  if (entry === 'background.js') data = Buffer.from(data.toString().replace("'io.github.reasonw6.zen_browser'", "'io.github.reasonw6.zen_browser_test'"));
  await writeFile(path.join(extension, entry), data);
}
const fixture = await readFile(new URL('./fixtures/page.html', import.meta.url));
const react = await build({ entryPoints: [path.join(root, 'tests/fixtures/react.jsx')], bundle: true, write: false, minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
let crossOrigin;
const http = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/foreground') response.setHeader('set-cookie', 'zen_fixture_login=local-test-session; HttpOnly; SameSite=Lax; Path=/');
  if (request.url === '/react.js') { response.setHeader('content-type', 'text/javascript'); response.end(react.outputFiles[0].contents); }
  else if (request.url === '/session') response.end(`<html><title>登录会话验证</title><p>${request.headers.cookie?.includes('zen_fixture_login=local-test-session') ? '现有登录会话可用' : '没有登录会话'}</p></html>`);
  else if (request.url === '/react') response.end('<!doctype html><html lang="zh-CN"><title>React 验收</title><meta charset="utf-8"><div id="root"></div><script src="/react.js"></script></html>');
  else if (request.url === '/next') response.end('<!doctype html><html lang="zh-CN"><title>导航成功</title><h1>导航成功</h1><p>后台下一页</p><a href="/">返回</a></html>');
  else if (request.url === '/frame') response.end('<!doctype html><html lang="zh-CN"><title>内嵌页面</title><label>内嵌输入<input id="frame-input"></label><button onclick="document.querySelector(\'p\').textContent=\'内嵌完成\'">内嵌按钮</button><p>等待内嵌操作</p></html>');
  else response.end(fixture.toString().replace('src="/frame"', `src="${crossOrigin}/frame"`));
});
const frameServer = createServer(http.listeners('request')[0]);
await new Promise(resolve => frameServer.listen(0, '127.0.0.1', resolve));
crossOrigin = `http://127.0.0.1:${frameServer.address().port}`;
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${http.address().port}`;
let marionette, browserProcess, mcp, receipt, focusMonitor;
const focusFile = path.join(runDir, 'foreground-windows.json'), focusStop = path.join(runDir, 'stop-focus-monitor');
function powershell(script, args) {
  const result = spawnSync(process.env.ZEN_POWERSHELL || 'pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', script), ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}
function startClient() {
  const child = spawn(mcpConfig.command, mcpConfig.args, { cwd: path.resolve(root, mcpConfig.cwd), env: { ...process.env, ZEN_BRIDGE_HOME: bridgeHome }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', data => logs.push(data.toString()));
  const decoder = new LineDecoder(MAX_RESPONSE), pending = new Map(); let nextId = 0;
  decoder.on('message', message => {
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  child.stdout.on('data', chunk => decoder.push(chunk));
  return { child, rpc(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 45000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  } };
}
let connectionId;
async function call(name, args = {}, expectedError) {
  const result = await mcp.rpc('tools/call', { name: `zen_${name}`, arguments: { ...(connectionId ? { connectionId } : {}), ...args } });
  const text = result.content.find(c => c.type === 'text')?.text;
  const data = text ? JSON.parse(text) : null;
  if (expectedError) { assert.equal(result.isError, true); assert.equal(data.code, expectedError); return data; }
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(data)}`);
  return result.content.some(c => c.type === 'image') ? result : data;
}
const evalPage = async script => (await marionette.command('WebDriver:ExecuteScript', { script, args: [], newSandbox: false, sandbox: 'default' })).value;
async function foreground() {
  return { handle: (await marionette.command('WebDriver:GetWindowHandle')).value,
    page: await evalPage('const e=document.querySelector("#foreground");return {url:location.href,active:document.activeElement.id,value:e.value,start:e.selectionStart,end:e.selectionEnd,visible:!document.hidden};') };
}
try {
  console.log(powershell('install-host.ps1', ['-InstallRoot', bridgeHome, '-HostName', 'io.github.reasonw6.zen_browser_test']).trim());
  const receipts = (await readdir(bridgeHome)).filter(n => /^install-.*\.json$/.test(n)); receipt = path.join(bridgeHome, receipts.at(-1));
  const args = ['--no-remote', '--profile', profile, '--marionette', '--remote-allow-system-access'];
  if (process.env.ZEN_HEADED !== '1') args.push('--headless');
  browserProcess = spawn(zen, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browserProcess.stdout.on('data', data => logs.push(data.toString())); browserProcess.stderr.on('data', data => logs.push(data.toString()));
  marionette = await connectMarionette(marionettePort);
  const session = await marionette.command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  report.browser = session.capabilities || session.value?.capabilities || session;
  console.log(`Zen session created: ${JSON.stringify(session).slice(0, 500)}`);
  await marionette.command('Addon:Install', { path: extension, temporary: true });
  check('actual Zen installed the temporary WebExtension', true);
  // Zen's startup zen-empty-tab is deliberately excluded from WebExtension APIs.
  // Create a regular user tab instead of navigating that internal placeholder.
  const userTab = await marionette.command('WebDriver:NewWindow', { type: 'tab' });
  await marionette.command('WebDriver:SwitchToWindow', { handle: userTab.handle ?? userTab.value?.handle });
  await marionette.command('WebDriver:Navigate', { url: base + '/foreground' });
  await marionette.command('Marionette:SetContext', { value: 'chrome' });
  report.chromeWindows = await evalPage('return [...Services.wm.getEnumerator(null)].map(w=>({type:w.document.documentElement.getAttribute("windowtype"),private:w.gPrivateBrowsingUI?.privateWindow,tabs:w.gBrowser?[...w.gBrowser.tabs].map(t=>({selected:t.selected,url:t.linkedBrowser.currentURI.spec})):[]}));');
  console.log(`Windows: ${JSON.stringify(report.chromeWindows)}`);
  await marionette.command('Marionette:SetContext', { value: 'content' });
  await evalPage('const e=document.querySelector("#foreground");e.focus();e.setSelectionRange(2,5);return true;');
  let baseline = await foreground();
  report.foregroundBaseline = baseline;
  if (process.env.ZEN_HEADED === '1') {
    focusMonitor = spawn(process.env.ZEN_POWERSHELL || 'pwsh.exe', ['-NoProfile', '-File', path.join(root, 'tests/focus-monitor.ps1'), '-OutputFile', focusFile, '-StopFile', focusStop], { windowsHide: true, stdio: 'ignore' });
    let monitorReady = false;
    for (let i = 0; i < 100; i++) {
      try { await readFile(focusFile + '.ready'); monitorReady = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!monitorReady) throw new Error('Windows foreground monitor failed to start.');
  }
  mcp = startClient();
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'zen-e2e', version: '1' }, capabilities: {} });
  check('MCP stdio handshake succeeds', init.serverInfo.name === 'reasonw6-zen-browser');
  let status;
  for (let i = 0; i < 30; i++) { status = await call('status'); if (status.connected) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  check('native messaging connects through registered host and authenticated pipe', status.connected);
  connectionId = status.connections[0].connectionId;
  const toolList = await mcp.rpc('tools/list'); check('all 16 tools are discoverable', toolList.tools.length === 16);
  const tabs = await call('tabs');
  report.initialTabs = tabs;
  console.log(`Initial tabs: ${JSON.stringify(tabs)}`);
  const front = tabs.tabs.find(t => t.url === base + '/foreground');
  check('foreground tab appears in the live inventory', front?.active);
  await call('attach', { tabId: front.tabId }, 'FOREGROUND_TAB'); check('foreground tab control is rejected', true);
  const opened = await call('open', { url: base + '/' }); const tabId = opened.tabId;
  check('created tab is inactive', opened.active === false);
  await call('wait', { tabId, selector: '#name', timeoutMs: 10000 });
  let snapshot = await call('snapshot', { tabId });
  check('background snapshot contains names and masks passwords', snapshot.elements.some(e => e.name === '姓名') && !JSON.stringify(snapshot).includes('never-print-this'));
  const nameRef = snapshot.elements.find(e => e.id === 'name').ref;
  await call('fill', { tabId, ref: nameRef, text: '雨瑶' });
  await call('fill', { tabId, selector: '#message', text: '后台输入通过 ✓' });
  await call('select', { tabId, selector: '#city', values: ['hz'] });
  await call('check', { tabId, selector: '#agree', checked: true });
  await call('click', { tabId, selector: '#submit' });
  await call('wait', { tabId, text: '已收到 雨瑶 / hz / true / 后台输入通过 ✓' });
  check('fill, select, checkbox and form submission work in the background', true);
  assert.deepEqual(await foreground(), baseline); check('foreground tab, DOM focus, text and selection are unchanged', true);
  await evalPage('const e=document.querySelector("#foreground");e.focus();e.setSelectionRange(e.value.length,e.value.length);return true;');
  const foregroundElement = await marionette.command('WebDriver:FindElement', { using: 'css selector', value: '#foreground' });
  const elementId = foregroundElement.value?.['element-6066-11e4-a52e-4f735466cecf'] ?? foregroundElement['element-6066-11e4-a52e-4f735466cecf'];
  await Promise.all([
    marionette.command('WebDriver:ElementSendKeys', { id: elementId, text: ' 前台继续输入' }),
    (async () => { for (let i = 0; i < 4; i++) await call('fill', { tabId, selector: '#message', text: `后台并行 ${i}` }); })()
  ]);
  baseline = await foreground();
  check('foreground typing continues during background edits', baseline.page.value === '选宝正在输入 前台继续输入' && baseline.page.active === 'foreground');
  await call('fill', { tabId, selector: '#shadow-input', text: '影子文本' });
  await call('click', { tabId, selector: '#shadow-button' });
  await call('wait', { tabId, text: '影子按钮已点击' }); check('open shadow DOM read, fill and click work', true);
  await call('fill', { tabId, selector: '#editor', text: '富文本验证' });
  snapshot = await call('snapshot', { tabId }); check('contenteditable fill is readable', snapshot.text.includes('富文本验证'));
  await call('fill', { tabId, ref: nameRef, text: 'stale' }, 'STALE_REF'); check('stale snapshot refs cannot edit', true);
  await call('click', { tabId, selector: '.duplicate' }, 'AMBIGUOUS_TARGET');
  await call('click', { tabId, selector: '#disabled' }, 'ELEMENT_DISABLED');
  await call('click', { tabId, selector: '#blocked' }, 'ELEMENT_COVERED');
  await call('click', { tabId, selector: '#newtab' }, 'NEW_TAB_LINK');
  await call('fill', { tabId, selector: '#file', text: 'no' }, 'UNSUPPORTED_FILE_INPUT');
  check('ambiguous, disabled, covered, new-window and file targets return explicit errors', true);
  const frame = snapshot.frames.find(f => f.url === crossOrigin + '/frame');
  check('iframe is discoverable', Number.isInteger(frame?.frameId));
  await call('fill', { tabId, frameId: frame.frameId, selector: '#frame-input', text: '内嵌文本' });
  await call('click', { tabId, frameId: frame.frameId, selector: 'button' });
  await call('wait', { tabId, frameId: frame.frameId, text: '内嵌完成' }); check('cross-origin iframe background fill and click work', true);
  await call('fill', { tabId, selector: '#name', text: '回车提交' });
  await call('press', { tabId, selector: '#name', key: 'Enter' });
  await call('wait', { tabId, text: '已收到 回车提交' }); check('Enter form semantics work', true);
  const scrolled = await call('scroll', { tabId, selector: '#scrollbox', y: 160 }); check('nested scrolling works', scrolled.y > 0);
  await call('scroll', { tabId, y: -100000 });
  const screenshot = await call('screenshot', { tabId, format: 'png' });
  const image = screenshot.content.find(c => c.type === 'image');
  const bytes = Buffer.from(image.data, 'base64');
  check('inactive tab screenshot is a real PNG', bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  await writeFile(path.join(runDir, 'background.png'), bytes);
  assert.deepEqual(await foreground(), baseline); check('screenshots and scrolling preserve foreground state', true);
  await call('click', { tabId, selector: '#trusted' });
  snapshot = await call('snapshot', { tabId });
  check('trusted-only controls are honestly identified as unsupported', snapshot.text.includes('尚无真实点击'));
  await call('navigate', { tabId, action: 'goto', url: base + '/next' });
  await call('wait', { tabId, text: '后台下一页' });
  await call('navigate', { tabId, action: 'back' });
  await call('wait', { tabId, selector: '#name' });
  await call('navigate', { tabId, action: 'forward' });
  await call('wait', { tabId, text: '后台下一页' });
  await call('navigate', { tabId, action: 'reload' });
  await call('wait', { tabId, text: '后台下一页' }); check('navigation, history and reload work without activation', true);
  assert.deepEqual(await foreground(), baseline);
  await call('wait', { tabId, text: 'never exists', timeoutMs: 200 }, 'WAIT_TIMEOUT'); check('bounded wait reports timeout', true);
  await call('navigate', { tabId, action: 'goto', url: base + '/session' });
  await call('wait', { tabId, text: '现有登录会话可用' }); check('new background tabs reuse the existing browser login session', true);
  await call('navigate', { tabId, action: 'goto', url: base + '/react' });
  await call('wait', { tabId, selector: '#react-name' });
  await call('fill', { tabId, selector: '#react-name', text: 'React 雨瑶' });
  await call('check', { tabId, selector: '#react-agree', checked: true });
  await call('select', { tabId, selector: '#react-city', values: ['hz'] });
  await call('click', { tabId, selector: '#react-submit' });
  await call('wait', { tabId, text: 'React 已收到 React 雨瑶 / true / hz' });
  check('React controlled inputs, state and submission work', true);
  assert.deepEqual(await foreground(), baseline);
  const primary = mcp;
  mcp = startClient(); await mcp.rpc('initialize', { protocolVersion: '2025-11-25' });
  await call('attach', { tabId }, 'TAB_BUSY');
  mcp.child.stdin.end(); mcp = primary;
  check('another live MCP session cannot take the tab', true);
  await call('close', { tabId }); check('owned background tab closes while foreground is retained', !(await call('tabs')).tabs.some(t => t.tabId === tabId));
  assert.deepEqual(await foreground(), baseline);
  if (focusMonitor) {
    await writeFile(focusStop, 'stop');
    await new Promise(resolve => focusMonitor.once('exit', resolve));
    focusMonitor = null;
    const samples = JSON.parse((await readFile(focusFile, 'utf8')).replace(/^\uFEFF/, ''));
    report.foregroundWindowSamples = samples.length;
    report.foregroundWindowHandles = [...new Set(samples.map(s => s.handle))];
    if (samples.length > 10 && samples.every(s => s.handle !== 0)) {
      check('Windows foreground window never changes during background operations', report.foregroundWindowHandles.length === 1);
      report.foregroundWindowCheck = 'passed';
    } else {
      report.foregroundWindowCheck = 'unavailable: Windows returned null foreground window handles';
      console.log('UNVERIFIED Windows foreground window: null handles cannot prove focus preservation.');
      if (process.env.ZEN_REQUIRE_FOREGROUND === '1') throw new Error(report.foregroundWindowCheck);
    }
  }
  const takeover = await call('open', { url: base + '/' });
  await call('wait', { tabId: takeover.tabId, selector: '#name' });
  // Simulate the user selecting that tab using test-only browser chrome access.
  await marionette.command('Marionette:SetContext', { value: 'chrome' });
  await evalPage(`const w=Services.wm.getMostRecentWindow('navigator:browser');const t=[...w.gBrowser.tabs].find(t=>t.linkedBrowser.currentURI.spec===${JSON.stringify(base + '/')});w.gBrowser.selectedTab=t;return true;`);
  await marionette.command('Marionette:SetContext', { value: 'content' });
  await call('fill', { tabId: takeover.tabId, selector: '#name', text: 'must not be typed' }, 'FOREGROUND_TAB');
  check('real user tab activation blocks subsequent writes', true);
  await marionette.command('WebDriver:SwitchToWindow', { handle: baseline.handle });
  await call('fill', { tabId: takeover.tabId, selector: '#name', text: 'must not be typed' }, 'NOT_ATTACHED');
  check('switching away does not silently restore control', true);
  await call('attach', { tabId: takeover.tabId });
  await call('close', { tabId: takeover.tabId }, 'NOT_CREATED');
  check('re-attached tabs cannot be closed as newly-created tabs', true);
  await marionette.command('Marionette:SetContext', { value: 'chrome' });
  const popupUrl = await evalPage('return WebExtensionPolicy.getByID("zen-browser@reasonw6.github.io").getURL("popup.html");');
  await marionette.command('Marionette:SetContext', { value: 'content' });
  await marionette.command('WebDriver:Navigate', { url: popupUrl });
  for (let i = 0; i < 30; i++) { if (await evalPage('return document.querySelector("#toggle")?.disabled===false;')) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  check('popup displays the actual bridge connection state', (await evalPage('return document.querySelector("#status").textContent;')).includes('已连接'));
  const popupBody = await marionette.command('WebDriver:FindElement', { using: 'css selector', value: 'body' });
  const popupId = popupBody.value?.['element-6066-11e4-a52e-4f735466cecf'] ?? popupBody['element-6066-11e4-a52e-4f735466cecf'];
  const popupShot = await marionette.command('WebDriver:TakeScreenshot', { id: popupId, highlights: [], full: false });
  await writeFile(path.join(runDir, 'popup.png'), Buffer.from(popupShot.value, 'base64'));
  await evalPage('document.querySelector("#toggle").click();return true;');
  for (let i = 0; i < 30; i++) { if (!(await call('status')).connected) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  check('popup pause disconnects the native host', !(await call('status')).connected);
  await evalPage('document.querySelector("#toggle").click();return true;');
  let reconnected;
  for (let i = 0; i < 30; i++) { reconnected = await call('status'); if (reconnected.connected) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  check('popup resume establishes a fresh native connection', reconnected.connected);
  const previousConnection = connectionId; connectionId = reconnected.connections[0].connectionId;
  check('reconnect changes the connection identity', connectionId !== previousConnection);
  const remaining = (await call('tabs')).tabs.find(t => t.tabId === takeover.tabId);
  check('pause and reconnect preserve tabs and release ownership', remaining && !remaining.controlled);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; console.error(error.stack); process.exitCode = 1;
} finally {
  if (focusMonitor) { await writeFile(focusStop, 'stop'); await new Promise(resolve => focusMonitor.once('exit', resolve)); }
  mcp?.child.stdin.end();
  if (marionette) {
    await marionette.command('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {});
    marionette.close();
  }
  if (browserProcess?.exitCode === null) browserProcess.kill();
  http.close();
  frameServer.close();
  if (receipt) {
    try { powershell('unregister-host.ps1', ['-Receipt', receipt]); report.registrationRestored = true; }
    catch (error) { report.registrationRestored = false; report.cleanupError = error.message; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(runDir, 'browser.log'), logs.join(''));
  console.log(`Evidence: ${runDir}`);
}
