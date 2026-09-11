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
let focusFile = path.join(runDir, 'foreground-windows.json'), focusStop = path.join(runDir, 'stop-focus-monitor'), focusPhase = 'background';
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

const refId = result => (result.value || result)['element-6066-11e4-a52e-4f735466cecf'];
const resultValue = result => result && Object.hasOwn(result, 'value') ? result.value : result;
const find = async selector => refId(await marionette.command('WebDriver:FindElement', { using: 'css selector', value: selector }));
async function uiElement(selector) {
  const host = await find('zen-ai-control');
  const shadow = resultValue(await marionette.command('WebDriver:GetShadowRoot', { id: host }))['shadow-6066-11e4-a52e-4f735466cecf'];
  return refId(await marionette.command('WebDriver:FindElementFromShadowRoot', { shadowRoot: shadow, using: 'css selector', value: selector }));
}
async function uiClick(action) {
  const button = await uiElement('[data-action=' + action + ']');
  for (let i = 0; i < 50; i++) {
    if (resultValue(await marionette.command('WebDriver:IsElementEnabled', { id: button }))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await marionette.command('WebDriver:ElementClick', { id: button });
}
async function uiText(selector) {
  return resultValue(await marionette.command('WebDriver:GetElementText', { id: await uiElement(selector) }));
}
async function readControl(tabId) { return (await call('tabs')).tabs.find(tab => tab.tabId === tabId)?.control; }
async function continueAndObserve(tabId) {
  await uiClick('resume');
  for (let i = 0; i < 30; i++) {
    if ((await readControl(tabId)).state === 'observing') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return call('snapshot', { tabId });
}
async function capturePage(name) {
  const shot = await marionette.command('WebDriver:TakeScreenshot', { id: null, highlights: [], full: false });
  await writeFile(path.join(runDir, name), Buffer.from(resultValue(shot), 'base64'));
}
async function stopFocusMonitor() {
  if (!focusMonitor) return;
  await writeFile(focusStop, 'stop');
  if (focusMonitor.exitCode === null) await new Promise(resolve => focusMonitor.once('exit', resolve));
  focusMonitor = null;
  const samples = JSON.parse((await readFile(focusFile, 'utf8')).replace(/^\uFEFF/, ''));
  const handles = [...new Set(samples.map(s => s.handle))];
  report.focusRuns ||= [];
  report.focusRuns.push({ phase: focusPhase, samples: samples.length, handles });
  report.foregroundWindowSamples = report.focusRuns.reduce((sum, run) => sum + run.samples, 0);
  report.foregroundWindowHandles = [...new Set(report.focusRuns.flatMap(run => run.handles))];
  if (samples.length > 10 && samples.every(s => s.handle !== 0)) {
    check('Windows foreground stays unchanged during ' + focusPhase + ' operations', handles.length === 1);
    report.foregroundWindowCheck = 'passed';
  } else {
    report.foregroundWindowCheck = samples.some(s => s.handle === 0)
      ? 'unavailable: null foreground window handles'
      : 'unavailable: fewer than 11 foreground window samples';
    if (process.env.ZEN_REQUIRE_FOREGROUND === '1') throw new Error(report.foregroundWindowCheck);
  }
}
async function startFocusMonitor(phase) {
  if (process.env.ZEN_HEADED !== '1') return;
  focusPhase = phase;
  focusFile = path.join(runDir, 'foreground-' + phase + '.json');
  focusStop = path.join(runDir, 'stop-foreground-' + phase);
  focusMonitor = spawn(process.env.ZEN_POWERSHELL || 'pwsh.exe', ['-NoProfile', '-File', path.join(root, 'tests/focus-monitor.ps1'), '-OutputFile', focusFile, '-StopFile', focusStop], { windowsHide: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await readFile(focusFile + '.ready'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  if (!ready) throw new Error('Windows foreground monitor did not start.');
}
try {
  console.log(powershell('install-host.ps1', ['-InstallRoot', bridgeHome, '-HostName', 'io.github.reasonw6.zen_browser_test']).trim());
  receipt = path.join(bridgeHome, (await readdir(bridgeHome)).filter(n => /^install-.*\.json$/.test(n)).at(-1));
  const args = ['--new-instance', '--profile', profile, '--marionette', '--remote-allow-system-access'];
  if (process.env.ZEN_HEADED !== '1') args.push('--headless');
  browserProcess = spawn(zen, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browserProcess.stdout.on('data', data => logs.push(data.toString())); browserProcess.stderr.on('data', data => logs.push(data.toString()));
  marionette = await connectMarionette(marionettePort);
  const session = await marionette.command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  report.browser = session.capabilities || session.value?.capabilities || session;
  await marionette.command('Addon:Install', { path: extension, temporary: true });
  check('Zen loads the real WebExtension', true);
  const userTab = await marionette.command('WebDriver:NewWindow', { type: 'tab' });
  await marionette.command('WebDriver:SwitchToWindow', { handle: userTab.handle ?? userTab.value?.handle });
  await marionette.command('WebDriver:Navigate', { url: base + '/foreground' });
  await evalPage('const e=document.querySelector("#foreground");e.focus();e.setSelectionRange(2,5);return true;');
  let baseline = await foreground();
  report.foregroundBaseline = baseline;
  await startFocusMonitor('background');
  mcp = startClient();
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'zen-e2e', version: '2' }, capabilities: {} });
  check('MCP starts from the shipped configuration', init.serverInfo.version === '0.4.0');
  let status;
  for (let i = 0; i < 40; i++) { status = await call('status'); if (status.connected) break; await new Promise(resolve => setTimeout(resolve, 250)); }
  check('native messaging and authenticated local pipe connect', status.connected);
  connectionId = status.connections[0].connectionId;
  check('all 25 MCP tools are discoverable', (await mcp.rpc('tools/list')).tools.length === 25);
  const beforeHandles = resultValue(await marionette.command('WebDriver:GetWindowHandles'));
  const opened = await call('open', { url: base + '/', taskTitle: 'Zen AI 观看与接管验收' });
  const tabId = opened.tabId;
  const afterHandles = resultValue(await marionette.command('WebDriver:GetWindowHandles'));
  const aiHandles = afterHandles.filter(handle => !beforeHandles.includes(handle));
  assert.equal(aiHandles.length, 1);
  const aiHandle = aiHandles[0];
  check('AI tab is created in the background', opened.active === false);
  await call('wait', { tabId, selector: '#name' });
  let snapshot = await call('snapshot', { tabId });
  report.marking = snapshot.control.marking;
  check('controlled tab has a native group or an explicit title fallback', ['native-group-and-title', 'title'].includes(snapshot.control.marking));
  check('tab title displays a real AI state', snapshot.title.startsWith('[AI·'));
  check('page observation does not expose password values or control buttons', !JSON.stringify(snapshot).includes('never-print-this') && !snapshot.elements.some(e => e.name === '暂停'));
  await call('fill', { tabId, selector: '#name', text: '后台雨瑶' });
  await call('fill', { tabId, selector: '#message', text: '真实后台填写' });
  await call('select', { tabId, selector: '#city', values: ['hz'] });
  await call('check', { tabId, selector: '#agree', checked: true });
  await call('click', { tabId, selector: '#submit' });
  await call('wait', { tabId, text: '已收到 后台雨瑶 / hz / true / 真实后台填写' });
  check('background DOM operations change the actual form and result', true);
  await call('fill', { tabId, selector: '#name', text: 'Enter 提交验证' });
  await call('press', { tabId, selector: '#name', key: 'Enter' });
  await call('wait', { tabId, text: '已收到 Enter 提交验证 / hz / true / 真实后台填写' });
  check('synthetic Enter retains real form submission semantics', true);
  assert.deepEqual(await foreground(), baseline);
  check('background work preserves the other tab focus, text and selection', true);
  await evalPage('const e=document.querySelector("#foreground");e.focus();e.setSelectionRange(e.value.length,e.value.length);return true;');
  const frontInput = await find('#foreground');
  await Promise.all([
    marionette.command('WebDriver:ElementSendKeys', { id: frontInput, text: ' 前台继续输入' }),
    (async () => { for (let i = 0; i < 3; i++) await call('fill', { tabId, selector: '#message', text: '并行后台 ' + i }); })()
  ]);
  baseline = await foreground();
  check('foreground typing continues while AI writes elsewhere', baseline.page.value === '选宝正在输入 前台继续输入' && baseline.page.active === 'foreground');
  await call('fill', { tabId, selector: '#editor', text: '富文本不会误判接管' });
  check('browser-generated editing events do not cause false takeover', (await readControl(tabId)).state === 'idle');
  await call('fill', { tabId, selector: '#shadow-input', text: '影子输入' });
  await call('click', { tabId, selector: '#shadow-button' });
  await call('wait', { tabId, text: '影子按钮已点击' });
  check('open shadow DOM still works in the background', true);
  snapshot = await call('snapshot', { tabId });
  const frame = snapshot.frames.find(f => f.url === crossOrigin + '/frame');
  await call('snapshot', { tabId, frameId: frame.frameId });
  await call('fill', { tabId, frameId: frame.frameId, selector: '#frame-input', text: '跨源内嵌输入' });
  await call('click', { tabId, frameId: frame.frameId, selector: 'button' });
  await call('wait', { tabId, frameId: frame.frameId, text: '内嵌完成' });
  check('cross-origin frame observations and actions remain isolated', true);
  await call('scroll', { tabId, selector: '#scrollbox', y: 150 });
  await call('scroll', { tabId, y: -100000 });
  const background = await call('screenshot', { tabId, format: 'png' });
  const image = background.content.find(c => c.type === 'image');
  await writeFile(path.join(runDir, 'background.png'), Buffer.from(image.data, 'base64'));
  check('background screenshot contains the real controlled page', image.mimeType === 'image/png');
  await call('navigate', { tabId, action: 'goto', url: base + '/session' });
  await call('wait', { tabId, text: '现有登录会话可用' });
  check('existing browser login session is retained', true);
  await call('snapshot', { tabId });
  await call('navigate', { tabId, action: 'goto', url: base + '/react' });
  await call('wait', { tabId, selector: '#react-name' });
  await call('snapshot', { tabId });
  await call('fill', { tabId, selector: '#react-name', text: 'React 真实状态' });
  await call('check', { tabId, selector: '#react-agree', checked: true });
  await call('select', { tabId, selector: '#react-city', values: ['hz'] });
  await call('click', { tabId, selector: '#react-submit' });
  await call('wait', { tabId, text: 'React 已收到 React 真实状态 / true / hz' });
  check('React controlled inputs still update application state', true);
  assert.deepEqual(await foreground(), baseline);
  await stopFocusMonitor();

  await call('snapshot', { tabId });
  await call('navigate', { tabId, action: 'goto', url: base + '/' });
  await call('wait', { tabId, selector: '#name' });
  await call('snapshot', { tabId });
  const epochBeforeWatching = (await readControl(tabId)).epoch;
  await marionette.command('WebDriver:SwitchToWindow', { handle: aiHandle });
  check('clicking the AI tab enters watching without losing control', (await readControl(tabId)).epoch === epochBeforeWatching);
  await startFocusMonitor('watching');
  check('page control UI is isolated in a closed shadow root', await evalPage('return document.querySelector("zen-ai-control").shadowRoot===null;'));
  const namePoint = await evalPage('const r=document.querySelector("#name").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};');
  await marionette.command('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'watch-mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', x: namePoint.x, y: namePoint.y, duration: 0 }] }] });
  check('physical hover does not take over', (await readControl(tabId)).controlled);
  await call('fill', { tabId, selector: '#name', text: '正在观看 AI 填写' });
  await call('click', { tabId, selector: '#submit' });
  check('watched fill and click update the actual page', (await evalPage('return document.querySelector("#output").textContent;')).includes('正在观看 AI 填写'));
  await capturePage('click-feedback.png');
  await call('fill', { tabId, selector: '#editor', text: '观看时的富文本编辑' });
  check('visible native editing events are attributed to the active AI operation', (await readControl(tabId)).state === 'idle');
  await capturePage('watching.png');
  for (let i = 1; i <= 40; i++) await call('fill', { tabId, selector: '#name', text: '连续观看步骤 ' + i });
  check('consecutive watched steps continue without a false takeover', (await readControl(tabId)).controlled && await evalPage('return document.querySelector("#name").value==="连续观看步骤 40";'));
  await stopFocusMonitor();
  const currentName = await evalPage('return document.querySelector("#name").value;');
  const pendingWait = call('wait', { tabId, text: 'never appears', timeoutMs: 5000 }).then(value => ({ value }), error => ({ error }));
  for (let i = 0; i < 40; i++) { if ((await uiText('.detail')).includes('等待网页')) break; await new Promise(resolve => setTimeout(resolve, 25)); }
  check('running status is driven by an actual pending command', (await readControl(tabId)).state === 'running' && (await uiText('.label')).includes('运行'));
  await capturePage('running.png');
  await uiClick('collapse');
  check('collapsed controls still expose pause and takeover', (await readControl(tabId)).collapsed && (await uiText('[data-action=pause]')) === '暂停' && (await uiText('[data-action=takeover]')) === '接管');
  const queuedFill = call('fill', { tabId, selector: '#name', text: 'MUST NEVER REPLAY' }).then(value => ({ value }), error => ({ error }));
  await uiClick('pause');
  await uiClick('resume');
  const [waitOutcome, queuedOutcome] = await Promise.all([pendingWait, queuedFill]);
  check('page pause cancels an outstanding wait', /CONTROL_CHANGED|CONTROL_STOPPED/.test(waitOutcome.error?.message));
  check('immediate Continue does not replay an already-queued write', /CONTROL_CHANGED|CONTROL_STOPPED/.test(queuedOutcome.error?.message) && await evalPage('return document.querySelector("#name").value;') === currentName);
  await call('fill', { tabId, selector: '#name', text: 'no observation' }, 'OBSERVATION_REQUIRED');
  check('Continue requires a fresh observation', true);
  await uiClick('collapse');
  await call('snapshot', { tabId });
  await call('fill', { tabId, selector: '#name', text: '观察后的新指令' });

  await marionette.command('WebDriver:ElementClick', { id: await find('#message') });
  await marionette.command('WebDriver:ElementSendKeys', { id: await find('#message'), text: '用户自己的输入' });
  const takeoverState = await readControl(tabId);
  check('actual page click and typing take over without swallowing user input', takeoverState.state === 'user_control' && (await evalPage('return document.querySelector("#message").value;')).includes('用户自己的输入'));
  await call('fill', { tabId, selector: '#message', text: 'must not overwrite' }, 'CONTROL_STOPPED');
  await capturePage('takeover.png');
  const awaitingUser = call('wait_for_control', { tabId, timeoutMs: 5000 });
  await uiClick('resume');
  const resumed = await awaitingUser;
  check('Continue wakes the waiting MCP call with a fresh observation of user edits', resumed.ready && resumed.snapshot.elements.some(e => e.id === 'message' && e.value.includes('用户自己的输入')));
  await call('fill', { tabId, selector: '#name', text: '键盘接管之前' });
  await marionette.command('WebDriver:ElementSendKeys', { id: await find('#name'), text: '键盘输入' });
  check('keyboard input alone takes over an AI-focused input', (await readControl(tabId)).state === 'user_control');
  await continueAndObserve(tabId);
  await evalPage('document.querySelector("#drag").scrollIntoView({block:"center"});return true;');
  const dragPoint = await evalPage('const r=document.querySelector("#drag").getBoundingClientRect();return {x:Math.round(r.x+30),y:Math.round(r.y+20)};');
  await marionette.command('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'drag-mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', origin: 'viewport', x: dragPoint.x, y: dragPoint.y, duration: 0 }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', origin: 'viewport', x: dragPoint.x + 120, y: dragPoint.y + 25, duration: 180 }, { type: 'pointerUp', button: 0 }
  ] }] });
  check('actual content drag takes over before further AI writes', (await readControl(tabId)).state === 'user_control' && await evalPage('return document.querySelector("#drag").dataset.dragStarted==="true";'));
  await continueAndObserve(tabId);
  await marionette.command('WebDriver:SwitchToFrame', { element: await find('#frame') });
  await marionette.command('WebDriver:ElementClick', { id: await find('#frame-input') });
  await marionette.command('WebDriver:ElementSendKeys', { id: await find('#frame-input'), text: '用户的跨源输入' });
  await marionette.command('WebDriver:SwitchToFrame', { id: null });
  check('physical input in a cross-origin iframe takes over the whole tab', (await readControl(tabId)).state === 'user_control');
  await call('fill', { tabId, selector: '#name', text: 'cannot race with iframe user' }, 'CONTROL_STOPPED');
  await continueAndObserve(tabId);
  await evalPage('document.title="网页自己更新的标题";return true;');
  check('tab marking preserves dynamic site titles', (await evalPage('return document.title;')).includes('网页自己更新的标题') && (await evalPage('return document.title;')).startsWith('[AI·'));

  await call('click', { tabId, selector: '.duplicate' }, 'AMBIGUOUS_TARGET');
  check('an actual failed operation produces a failed UI state', (await readControl(tabId)).state === 'failed');
  await capturePage('failed.png');
  await call('click', { tabId, selector: '#submit' }, 'CONTROL_STOPPED');
  await continueAndObserve(tabId);
  const staleSnapshot = await call('snapshot', { tabId });
  const staleRef = staleSnapshot.elements.find(element => element.id === 'name').ref;
  await call('snapshot', { tabId });
  await call('fill', { tabId, ref: staleRef, text: 'must not apply' }, 'STALE_REF');
  check('stale refs are rejected after a new observation', (await readControl(tabId)).state === 'failed');
  await continueAndObserve(tabId);
  for (const [command, args, code] of [
    ['click', { selector: '#disabled' }, 'ELEMENT_DISABLED'],
    ['click', { selector: '#blocked' }, 'ELEMENT_COVERED'],
    ['click', { selector: '#newtab' }, 'NEW_TAB_LINK'],
    ['fill', { selector: '#file', text: 'unsupported' }, 'UNSUPPORTED_FILE_INPUT']
  ]) {
    await call(command, { tabId, ...args }, code);
    check('invalid target remains blocked: ' + code, (await readControl(tabId)).state === 'failed');
    await continueAndObserve(tabId);
  }
  await call('click', { tabId, selector: '#trusted' });
  check('synthetic click does not claim trusted-only page behavior', await evalPage('return document.querySelector("#trusted-result").textContent === "尚无真实点击";'));
  await call('task', { tabId, outcome: 'waiting_user', message: '请确认网页结果后继续' });
  check('agent-declared need for user action is displayed accurately', (await uiText('.label')).includes('等待用户'));
  await continueAndObserve(tabId);
  await uiClick('pause');
  await capturePage('paused.png');
  await marionette.command('WebDriver:Refresh');
  for (let i = 0; i < 40; i++) { try { if ((await uiText('.label')).includes('暂停')) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  check('refresh preserves a human pause and restores the page controls', (await uiText('.label')).includes('暂停'));
  await continueAndObserve(tabId);
  await call('navigate', { tabId, action: 'goto', url: base + '/next' });
  await call('wait', { tabId, text: '后台下一页' });
  await call('click', { tabId, selector: 'a' }, 'OBSERVATION_REQUIRED');
  check('navigation invalidates old page observations', true);
  await call('snapshot', { tabId });
  await call('navigate', { tabId, action: 'back' });
  await call('wait', { tabId, selector: '#name' });
  await call('snapshot', { tabId });
  check('navigation and history rebuild the live UI and keep watching', (await readControl(tabId)).controlled && (await uiText('.mode')) === '观看');

  const primary = mcp;
  mcp = startClient(); await mcp.rpc('initialize', { protocolVersion: '2025-11-25' });
  await call('attach', { tabId }, 'TAB_BUSY'); mcp.child.stdin.end(); mcp = primary;
  check('a second MCP connection cannot control the watched tab', true);
  await marionette.command('Marionette:SetContext', { value: 'chrome' });
  const popupUrl = await evalPage('return WebExtensionPolicy.getByID("zen-browser@reasonw6.github.io").getURL("popup.html");');
  await marionette.command('Marionette:SetContext', { value: 'content' });
  await marionette.command('WebDriver:SwitchToWindow', { handle: baseline.handle });
  await marionette.command('WebDriver:Navigate', { url: popupUrl });
  for (let i = 0; i < 30; i++) { if (await evalPage('return document.querySelector("#toggle")?.disabled===false;')) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  check('extension popup lists the real task and current state', (await evalPage('return document.querySelector("#tasks").textContent;')).includes('Zen AI 观看与接管验收'));
  const popupBody = await find('body');
  const popupShot = await marionette.command('WebDriver:TakeScreenshot', { id: popupBody, highlights: [], full: false });
  await writeFile(path.join(runDir, 'popup.png'), Buffer.from(resultValue(popupShot), 'base64'));
  await marionette.command('WebDriver:ElementClick', { id: await find('#toggle') });
  for (let i = 0; i < 40; i++) { if (!(await call('status')).connected) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  check('global pause disconnects native control', !(await call('status')).connected);
  await marionette.command('WebDriver:ElementClick', { id: await find('#toggle') });
  let reconnected;
  for (let i = 0; i < 40; i++) { reconnected = await call('status'); if (reconnected.connected) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  check('native bridge reconnects with a new connection identity', reconnected.connected && reconnected.connections[0].connectionId !== connectionId);
  connectionId = reconnected.connections[0].connectionId;
  await call('attach', { tabId });
  check('reconnection and reattachment do not bypass the stopped state', (await readControl(tabId)).state === 'waiting_user');
  await marionette.command('WebDriver:SwitchToWindow', { handle: aiHandle });
  await continueAndObserve(tabId);
  await call('fill', { tabId, selector: '#name', text: '最终保留的结果' });
  await call('click', { tabId, selector: '#submit' });
  await call('wait', { tabId, text: '已收到 最终保留的结果' });
  await call('task', { tabId, outcome: 'completed', message: '网页结果已核对，页面为你保留' });
  check('explicit task completion retains the actual result page', (await readControl(tabId)).state === 'completed' && (await evalPage('return document.querySelector("#output").textContent;')).includes('最终保留的结果'));
  check('completed is shown in the page and tab title', (await uiText('.label')).includes('完成') && (await evalPage('return document.title;')).startsWith('[AI·完成]'));
  await capturePage('completed.png');
  await marionette.command('Marionette:SetContext', { value: 'chrome' });
  report.nativeGroups = await evalPage('const w=Services.wm.getMostRecentWindow("navigator:browser");return [...w.document.querySelectorAll("tab-group")].map(g=>({label:g.label||g.getAttribute("label"),color:g.color||g.getAttribute("color")}));');
  for (let i = 0; i < 40; i++) {
    report.nativeTabIcon = await evalPage('const w=Services.wm.getMostRecentWindow("navigator:browser");return w.gBrowser.selectedTab.getAttribute("image");');
    const iconUrl = report.nativeTabIcon?.startsWith('moz-remote-image:') ? new URL(report.nativeTabIcon).searchParams.get('url') : report.nativeTabIcon;
    report.completedIcon = !!iconUrl && (iconUrl.includes(';base64,') ? Buffer.from(iconUrl.split(';base64,')[1], 'base64').toString('utf8') : decodeURIComponent(iconUrl)).includes('#27785d');
    if (report.completedIcon) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  check('the native tab favicon reaches the completed state', report.completedIcon);
  await new Promise(resolve => setTimeout(resolve, 100));
  await capturePage('zen-window.png');
  await marionette.command('Marionette:SetContext', { value: 'content' });
  check('native Zen tab group displays the actual completion state', report.marking !== 'native-group-and-title' || report.nativeGroups.some(group => group.label?.includes('完成')));
  await call('click', { tabId, selector: '#submit' }, 'NOT_ATTACHED');
  report.passed = true;
} catch (error) {
  if (mcp) { try { report.failureTabs = await call('tabs'); console.error(JSON.stringify(report.failureTabs)); } catch {} }
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
