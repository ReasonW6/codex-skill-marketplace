import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, cp, stat } from 'node:fs/promises';
import { CodexTestClient } from './codex-client.mjs';
import { connectMarionette } from './marionette.mjs';
import { runPlatform } from '../server/windows.mjs';
import { CONNECTION_RESOURCE } from '../server/connection-tools.mjs';
import { BidiConnection } from '../server/bidi.mjs';

if (process.platform !== 'win32') throw Error('This user-flow test requires Windows and an installed Zen.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zen = process.env.ZEN_BINARY, cli = process.env.CODEX_TEST_BINARY;
const mode = process.env.ZEN_CONNECTION_MODE || 'existing';
const localUi = process.env.ZEN_CONNECTION_UI === 'local';
if (!['fresh', 'existing', 'inspect'].includes(mode)) throw Error('ZEN_CONNECTION_MODE must be fresh, existing or inspect.');
if (!zen || !cli) throw Error('Maintainers must set ZEN_BINARY and CODEX_TEST_BINARY. End users do not use this runner.');
const run = path.join(root, '.artifacts', 'connection-flow-' + Date.now());
const market = path.join(run, 'market'), source = path.join(market, 'plugins', 'zen-browser');
const codexHome = path.join(run, 'codex-home'), bridgeHome = path.join(run, 'native-home 空格%'), roaming = path.join(run, 'roaming');
const profile = path.join(roaming, 'zen', 'Profiles', 'primary 测试'), harnessProfile = path.join(run, 'ui-harness-profile');
const report = { mode, view: localUi ? 'production local page, MCP Apps disabled' : 'MCP App resource in test host', startedAt: new Date().toISOString(), checks: [], confirmations: [], fixture: { isolatedProfiles: true, targetProfileInitiallyEmpty: mode === 'fresh', targetDebuggingPreconfigured: false, uiHarnessUsesSeparateMarionetteProfile: true } };
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
await mkdir(profile, { recursive: true }); await mkdir(harnessProfile, { recursive: true }); await mkdir(source, { recursive: true }); await mkdir(codexHome, { recursive: true });
await mkdir(path.join(market, '.agents', 'plugins'), { recursive: true });
for (const folder of ['server', 'extension', 'runtime', 'bin', 'ui', 'skills', '.codex-plugin']) await cp(path.join(root, folder), path.join(source, folder), { recursive: true });
for (const file of ['.mcp.json', 'package.json']) await cp(path.join(root, file), path.join(source, file));
const mcpManifest = JSON.parse(await readFile(path.join(source, '.mcp.json'), 'utf8'));
mcpManifest.mcpServers.zen_browser.env = { ZEN_BRIDGE_HOME: bridgeHome, ZEN_BRIDGE_HOST_NAME: 'io.github.reasonw6.zen_browser_test', APPDATA: roaming, PATH: process.env.SystemRoot + '\\System32' };
if (process.env.ZEN_DEBUG_FAILURE_HOLD === '1') mcpManifest.mcpServers.zen_browser.env.ZEN_BRIDGE_DIAGNOSTICS = '1';
await writeFile(path.join(source, '.mcp.json'), JSON.stringify(mcpManifest, null, 2));
const background = path.join(source, 'extension', 'background.js');
await writeFile(background, (await readFile(background, 'utf8')).replace("'io.github.reasonw6.zen_browser'", "'io.github.reasonw6.zen_browser_test'"));
await writeFile(path.join(roaming, 'zen', 'profiles.ini'), '[Profile0]\nName=连接验收\nIsRelative=1\nPath=Profiles/primary 测试\nDefault=1\n\n[General]\nStartWithLastProfile=1\nVersion=2\n');
await writeFile(path.join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'zen-user-flow', plugins: [{ name: 'zen-browser', source: { source: 'local', path: './plugins/zen-browser' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }));
await writeFile(path.join(codexHome, 'config.toml'), '[features]\nplugins = true\nenable_mcp_apps = ' + !localUi + '\n');
const installEnv = { ...process.env, CODEX_HOME: codexHome, ZEN_BRIDGE_HOME: bridgeHome, ZEN_BRIDGE_HOST_NAME: 'io.github.reasonw6.zen_browser_test', APPDATA: roaming };
const env = { ...installEnv, PATH: process.env.SystemRoot + '\\System32' };
const initialProcesses = (await runPlatform({ action: 'inspect', profiles: [], hostName: 'io.github.reasonw6.zen_browser_test' })).processes;
const registryBefore = (await runPlatform({ action: 'inspect', profiles: [], hostName: 'io.github.reasonw6.zen_browser_test' })).currentManifest;
const productionRegistryBefore = (await runPlatform({ action: 'inspect', profiles: [] })).currentManifest;
let app, marionette, uiProcess, uiHtml, connectionId, targetPid, ordinaryProcess, originalUserSource = '', sessionStarted = false;
const trace = [], nonce = randomUUID();
function install() {
  for (const args of [['plugin', 'marketplace', 'add', market], ['plugin', 'add', 'zen-browser@zen-user-flow']]) {
    const result = spawnSync(cli, args, { cwd: market, env: installEnv, windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr || result.stdout); console.log(result.stdout.trim());
  }
}
async function startApp() { app = await new CodexTestClient(cli, market, env, { mcpApps: !localUi }).start(); return app; }
async function call(name, args = {}) {
  const result = await app.tool('zen_' + name, { ...(connectionId && !name.startsWith('connection') ? { connectionId } : {}), ...args });
  if (result.isError) throw Error(result.content.find(c => c.type === 'text')?.text);
  return result.structuredContent || JSON.parse(result.content.find(c => c.type === 'text')?.text);
}
const http = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/harness/' + nonce) {
      response.end('<!doctype html><html lang="zh-CN"><title>Zen connection UI verification</title><style>html,body{margin:0;background:#f1f3f1}iframe{display:block;border:1px solid #e0e5e1;border-radius:14px;width:min(640px,100%);height:690px;margin:20px auto;background:white}</style><iframe id="app" src="/component/' + nonce + '"></iframe><script>let frame=document.querySelector("iframe");window.addEventListener("message",async e=>{if(e.source!==frame.contentWindow||e.data?.jsonrpc!=="2.0")return;let m=e.data;if(m.id===undefined)return;let result,error;try{if(m.method==="ui/initialize")result={protocolVersion:"2026-01-26",hostInfo:{name:"actual-codex-backend-test-host",version:"0.4.0"},hostCapabilities:{serverTools:{},serverResources:{}},hostContext:{theme:"light"}};else{const r=await fetch("/rpc/' + nonce + '",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(m)});const data=await r.json();if(data.error)throw Error(data.error);result=data.result}}catch(e){error={code:-32603,message:e.message}}frame.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,result,error},"*")});</script></html>');
    } else if (url.pathname === '/component/' + nonce) response.end(uiHtml);
    else if (url.pathname === '/rpc/' + nonce && request.method === 'POST') {
      let body = ''; for await (const part of request) { body += part; if (body.length > 100000) throw Error('Oversized UI request'); }
      const message = JSON.parse(body); let result;
      if (message.method !== 'tools/call') throw Error('Unsupported test bridge request');
      result = await app.tool(message.params.name, message.params.arguments || {});
      trace.push({ tool: message.params.name, status: result.structuredContent?.status, operation: result.structuredContent?.operation, error: result.isError || false, at: new Date().toISOString() });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ result }));
    } else if (url.pathname === '/session-start') {
      sessionStarted = true;
      response.setHeader('set-cookie', 'zen_connection_session=retained; Max-Age=86400; HttpOnly; SameSite=Lax; Path=/');
      response.end('<!doctype html><html><title>Existing session fixture</title><h1>测试登录已建立</h1><a href="/session">查看会话</a></html>');
    } else if (url.pathname === '/session') {
      response.end('<!doctype html><html><title>Retained session</title><h1>' + ((request.headers.cookie || '').includes('zen_connection_session=retained') ? '已有登录会话仍在' : '会话不存在') + '</h1></html>');
    } else {
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接后的真实网页</title><style>body{font:16px system-ui;padding:35px}input,button{font:inherit;padding:9px;margin:9px}</style><h1>连接后的真实网页</h1><label>姓名<input id="name"></label><button id="trusted" onclick="if(event.isTrusted)document.querySelector(\'p\').textContent=\'可信点击成功：\'+document.querySelector(\'input\').value">提交测试</button><p>等待操作</p></html>');
    }
  } catch (error) { response.statusCode = 500; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + http.address().port;
const value = result => result && Object.hasOwn(result, 'value') ? result.value : result;
const ref = result => value(result)['element-6066-11e4-a52e-4f735466cecf'];
const evaluate = async script => value(await marionette.command('WebDriver:ExecuteScript', { script, args: [], newSandbox: false, sandbox: 'default' }));
const find = async selector => ref(await marionette.command('WebDriver:FindElement', { using: 'css selector', value: selector }));
async function uiClick(id) {
  await marionette.command('WebDriver:ElementClick', { id: await find('#' + id) });
}
async function key(value) {
  await marionette.command('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'connection-keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
}
async function closeTarget() {
  const info = (await runPlatform({ action: 'inspect', profiles: [profile] })).processes.find(item => item.profile === profile);
  if (info) {
    try { await runPlatform({ action: 'close-profile', profile, binary: zen, pid: info.pid, started: info.started }, { timeoutMs: 45000 }); }
    catch (error) { if (error.code !== 'CLOSE_DECLINED') throw error; report.delayedNormalExit = true; }
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && (await runPlatform({ action: 'profile-state', profile })).locked) await delay(200);
  assert.equal((await runPlatform({ action: 'profile-state', profile })).locked, false);
}
async function connectThroughUi(stage, confirm) {
  await uiClick('connect');
  if (confirm) {
    await waitUi('document.querySelector("#confirm").hidden===false');
    report.confirmations.push({ stage, text: await evaluate('return document.querySelector("#confirm").innerText;') });
    await uiClick('approve');
  }
  await waitUi('document.querySelector("#status").dataset.state==="connected"', 240000);
  const managed = await readManaged(); targetPid = managed.launch.browserPid; connectionId = managed.record.connectionId;
  return managed;
}
let operatorStartup = 0, pendingOperator;
async function waitUi(predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate('return ' + predicate + ';')) return;
    if (await evaluate('return !document.querySelector("#resume")?.hidden && document.querySelector("#resume").textContent.includes("窗口已打开");')) {
      if (!pendingOperator) {
        pendingOperator = path.join(run, 'operator-startup-' + (++operatorStartup) + '.json');
        const current = (await runPlatform({ action: 'inspect', profiles: [profile] })).processes.find(item => item.profile === profile);
        console.log('OPERATOR_STARTUP ' + JSON.stringify({ file: pendingOperator, pid: current?.pid, window: current?.window, profile }));
      }
      if (await stat(pendingOperator).then(() => true, () => false)) {
        report.confirmations.push(JSON.parse(await readFile(pendingOperator, 'utf8'))); pendingOperator = null; await uiClick('resume');
      }
    }
    if (await evaluate('return document.querySelector("#status")?.dataset.state==="failed" && document.querySelector("#confirm").hidden && !document.querySelector("#refresh").disabled;')) throw Error(await evaluate('return document.querySelector("#reason").textContent+" "+document.querySelector("#error-code").textContent;'));
    await delay(150);
  }
  throw Error('UI condition timed out: ' + predicate + ' ' + await evaluate('return document.body.innerText;'));
}
async function capture(name) {
  await marionette.command('WebDriver:SwitchToFrame', { id: null });
  const frame = await find('#app');
  const result = await marionette.command('WebDriver:TakeScreenshot', { id: frame, highlights: [], full: false });
  await writeFile(path.join(run, name), Buffer.from(value(result), 'base64'));
  await marionette.command('WebDriver:SwitchToFrame', { element: frame });
}
async function reloadUi() {
  await marionette.command('WebDriver:SwitchToFrame', { id: null });
  const url = localUi ? (await app.tool('zen_connection')).structuredContent.connectionPage : base + '/harness/' + nonce;
  await marionette.command('WebDriver:Navigate', { url });
  await marionette.command('WebDriver:SwitchToFrame', { element: await find('#app') });
  await waitUi('document.querySelector("#refresh").disabled===false');
}
async function readManaged() {
  const settings = JSON.parse(await readFile(path.join(bridgeHome, 'connection-settings.json'), 'utf8'));
  const record = settings.pending || settings.profiles[settings.selectedProfileId] || Object.values(settings.profiles)[0];
  const launch = record?.launchRecord ? JSON.parse(await readFile(record.launchRecord, 'utf8')) : null;
  return { settings, record, launch };
}
try {
  if (mode === 'existing') {
    // Represents an existing user's completed browser setup, not a fresh-user
    // acceptance result. No bridge, remote endpoint or extension is preinstalled.
    const preferences = { 'zen.welcome-screen.seen': true, 'browser.tabs.warnOnClose': false,
      'browser.shell.checkDefaultBrowser': false, 'browser.startup.page': 3, 'zen.test.existing-user-setting': 'preserve this value' };
    if (process.env.ZEN_DEBUG_FAILURE_HOLD === '1') Object.assign(preferences, { 'devtools.console.stdout.chrome': true, 'browser.dom.window.dump.enabled': true, 'remote.log.level': 'Trace' });
    originalUserSource = Object.entries(preferences).map(([key, value]) => 'user_pref(' + JSON.stringify(key) + ', ' + JSON.stringify(value) + ');').join('\n') + '\n';
    report.fixture.existingProfilePreferences = preferences;
    report.fixture.existingUserTabPreparedWithMarionetteThenBrowserFullyExited = true;
    const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    await writeFile(path.join(profile, 'user.js'), originalUserSource + 'user_pref("marionette.port", ' + port + ');\nuser_pref("remote.prefs.recommended", false);\nuser_pref("browser.startup.page", 0);\nuser_pref("browser.startup.homepage", "about:blank");\nuser_pref("browser.aboutwelcome.enabled", false);\nuser_pref("zen.welcome-screen.enabled", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("toolkit.telemetry.enabled", false);\n');
    spawn(zen, ['--new-instance', '--profile', profile, '--marionette'], { windowsHide: true, stdio: 'ignore' });
    const preparer = await connectMarionette(port, 30000);
    try {
      await preparer.command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false, pageLoadStrategy: 'eager' } } });
      const tab = value(await preparer.command('WebDriver:NewWindow', { type: 'tab' }));
      await preparer.command('WebDriver:SwitchToWindow', { handle: tab.handle });
      await preparer.command('WebDriver:Navigate', { url: base + '/session-start' });
    } finally { await preparer.command('Marionette:Quit', { flags: ['eAttemptQuit'] }); preparer.close(); }
    for (let i = 0; i < 100 && (await runPlatform({ action: 'profile-state', profile })).locked; i++) await delay(100);
    assert.equal((await runPlatform({ action: 'profile-state', profile })).locked, false);
    await writeFile(path.join(profile, 'user.js'), originalUserSource);
    const prefsFile = path.join(profile, 'prefs.js');
    await writeFile(prefsFile, (await readFile(prefsFile, 'utf8')).replace(/^user_pref\("(?:remote\.prefs\.recommended|marionette\.port)",.*\r?\n/gm, ''));
    check('the existing-user fixture is closed and contains no bridge setup preference', !/remote\.prefs\.recommended/.test(await readFile(prefsFile, 'utf8')));
    ordinaryProcess = spawn(zen, ['--new-instance', '--profile', profile], { windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 100 && !(await runPlatform({ action: 'profile-state', profile })).locked; i++) await delay(100);
    for (let i = 0; i < 150 && !sessionStarted; i++) await delay(100);
    check('the existing profile starts without remote debugging or a bridge and establishes a real HttpOnly session', sessionStarted);
    const ordinary = (await runPlatform({ action: 'inspect', profiles: [profile] })).processes.find(item => item.profile === profile);
    assert.ok(ordinary); targetPid = ordinary.pid; report.ordinaryBrowser = ordinary;
  }
  install(); await startApp();
  check('actual Codex discovers the bundled MCP with global Node and PowerShell absent from PATH', Object.keys(app.server.tools).length === 25);
  if (!localUi) { const resources = await app.resource(CONNECTION_RESOURCE); uiHtml = resources.contents[0].text; }
  const before = await app.tool('zen_connection');
  if (localUi) check('Codex without MCP Apps receives a real loopback connection page', before._meta.uiState.diagnostics.uiClient.supported === false && /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/$/.test(before.structuredContent.connectionPage));
  report.runtime = before._meta.uiState.diagnostics;
  if (mode === 'inspect') { console.log(JSON.stringify(report.runtime)); throw { inspectionOnly: true }; }
  check('Codex explicitly passes the isolated test scope before any mutation', before._meta.uiState.diagnostics.dataHome === bridgeHome && before._meta.uiState.diagnostics.hostName === 'io.github.reasonw6.zen_browser_test' && path.normalize(before._meta.uiState.diagnostics.executable).includes('plugins\\cache\\zen-user-flow\\zen-browser\\0.4.0\\runtime\\node.exe'));
  const userSource = async () => readFile(path.join(profile, 'user.js'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  check('opening connection UI performs no installation or profile preference writes', !(await stat(bridgeHome).then(() => true, () => false)) && await userSource() === originalUserSource);
  check('a single existing profile is selected without a path prompt', before._meta.uiState.selection.profileId && before._meta.uiState.canConnect);
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  await writeFile(path.join(harnessProfile, 'user.js'), 'user_pref("marionette.port",' + port + ');\nuser_pref("browser.startup.page",0);\nuser_pref("browser.shell.checkDefaultBrowser",false);\nuser_pref("browser.aboutwelcome.enabled",false);\nuser_pref("zen.welcome-screen.enabled",false);\nuser_pref("zen.welcome-screen.seen",true);\nuser_pref("browser.tabs.warnOnClose",false);\n');
  uiProcess = spawn(zen, ['--new-instance', '--profile', harnessProfile, '--marionette', '--remote-allow-system-access'], { windowsHide: true, stdio: 'ignore' });
  marionette = await connectMarionette(port, 30000); await marionette.command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  const uiTab = value(await marionette.command('WebDriver:NewWindow', { type: 'tab' }));
  await marionette.command('WebDriver:SwitchToWindow', { handle: uiTab.handle });
  await marionette.command('WebDriver:Navigate', { url: localUi ? before.structuredContent.connectionPage : base + '/harness/' + nonce });
  await marionette.command('WebDriver:SwitchToFrame', { element: await find('#app') });
  await waitUi('document.querySelector("#connect").disabled===false'); await capture('connection-discovered.png');
  await uiClick('connect'); await waitUi('document.querySelector("#confirm").hidden===false');
  check('first Connect click shows real setup confirmation before any write', !(await stat(bridgeHome).then(() => true, () => false)) && await userSource() === originalUserSource);
  if (mode === 'existing') check('the already running profile is discovered and its necessary restart is explicitly shown', before._meta.uiState.needsRestart && (await evaluate('return document.querySelector("#confirm").innerText;')).includes('恢复会话'));
  report.confirmations.push({ stage: 'first-connect', text: await evaluate('return document.querySelector("#confirm").innerText;'), automatedClicks: ['连接 Zen', '允许并连接'] });
  await capture('connection-confirmation.png');
  check('confirmation isolates background controls and starts with keyboard focus on approval', await evaluate('return document.querySelector("main").inert && document.activeElement.id === "approve";'));
  await key('\uE004'); check('Tab stays inside the confirmation dialog', await evaluate('return document.activeElement.id === "back";'));
  await key('\uE004'); await key('\uE00C');
  check('Escape cancels the preview and returns keyboard focus without applying settings', await evaluate('return document.querySelector("#confirm").hidden && !document.querySelector("main").inert && document.activeElement.id === "connect";') && !(await stat(bridgeHome).then(() => true, () => false)));
  await marionette.command('WebDriver:SwitchToFrame', { id: null });
  await evaluate('document.querySelector("#app").style.width="320px";document.querySelector("#app").contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/host-context-changed",params:{theme:"dark"}},"*");return true;');
  await marionette.command('WebDriver:SwitchToFrame', { element: await find('#app') });
  await uiClick('connect'); await waitUi('document.querySelector("#confirm").hidden===false');
  check('the dark 320px connection dialog fits without horizontal overflow', await evaluate('return document.documentElement.dataset.theme === "dark" && document.documentElement.scrollWidth <= innerWidth && document.querySelector("#confirm").scrollWidth <= innerWidth;'));
  await capture('connection-dark-narrow.png'); await uiClick('back');
  await marionette.command('WebDriver:SwitchToFrame', { id: null });
  await evaluate('document.querySelector("#app").style.width="640px";document.querySelector("#app").contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/host-context-changed",params:{theme:"light"}},"*");return true;');
  await marionette.command('WebDriver:SwitchToFrame', { element: await find('#app') });
  await uiClick('connect'); await waitUi('document.querySelector("#confirm").hidden===false'); await uiClick('approve');
  if (mode === 'fresh') {
    await waitUi('document.querySelector("#reason").textContent.includes("首次引导")', 90000);
    check('a fresh Zen welcome wizard is not falsely reported as a usable connection', await evaluate('return document.querySelector("#status").dataset.state === "connecting";'));
    await capture('connection-waiting-for-zen.png');
    console.log('Complete the real Zen welcome wizard in the isolated window; evidence directory: ' + run);
    const onboardingRecord = path.join(run, 'operator-onboarding.json');
    for (let i = 0; i < 3000 && !await stat(onboardingRecord).then(() => true, () => false); i++) await delay(100);
    const record = JSON.parse(await readFile(onboardingRecord, 'utf8'));
    if (record.cancelled) throw Error('First-run UI verification cancelled by the operator.');
    report.confirmations.push(record); await uiClick('resume');
  }
  await waitUi('document.querySelector("#status").dataset.state==="connected"', 90000);
  await capture('connection-ready.png');
  check('first installation and connection finish through the actual UI without internal script execution', true);
  const managed = await readManaged(); targetPid = managed.launch.browserPid; connectionId = managed.record.connectionId;
  const installReceipt = JSON.parse(await readFile(managed.record.installReceipt, 'utf8'));
  check('native host uses its own stable bundled runtime', installReceipt.nodePath.startsWith(bridgeHome) && await hashFile(installReceipt.nodePath) === JSON.parse(await readFile(path.join(root, 'runtime/manifest.json'), 'utf8')).sha256);
  check('only the explicit connection preference is added to user.js', /remote\.prefs\.recommended/.test(await readFile(path.join(profile, 'user.js'), 'utf8')) && !/xpinstall|signature|theme/.test(await readFile(path.join(profile, 'user.js'), 'utf8')));
  if (mode === 'existing') {
    check('connection reopens exactly the existing profile and preserves its prior preferences', managed.launch.profile === profile && (await userSource()).startsWith(originalUserSource));
    let tabs, restored;
    for (let i = 0; i < 60; i++) { tabs = await call('tabs'); restored = tabs.tabs.find(tab => tab.url === base + '/session-start'); if (restored) break; await delay(150); }
    report.tabsAfterRestart = tabs;
    report.restoredTab = restored;
    check('the existing user tab is restored after the confirmed normal restart', !!restored && !restored.control);
  }
  const tab = await call('open', { url: base + '/work', taskTitle: '连接后真实操作' });
  if (mode === 'existing') {
    const current = (await call('tabs')).tabs, ai = current.find(item => item.tabId === tab.tabId), original = current.find(item => item.tabId === report.restoredTab.tabId);
    check('AI receives a new owned background tab in the existing browser window', ai.windowId === original.windowId && !ai.active && ai.createdByThisSession && !original.control);
  }
  try { await call('wait', { tabId: tab.tabId, selector: '#name' }); }
  catch (error) {
    report.failureTabs = await call('tabs');
    try { report.failureSnapshot = await call('snapshot', { tabId: tab.tabId }); } catch (snapshotError) { report.snapshotError = snapshotError.message; }
    const inspect = await new BidiConnection(managed.launch.endpoint).connect();
    try {
      await inspect.request('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
      report.contexts = (await inspect.request('browsingContext.getTree', {})).contexts;
      report.contextDocuments = [];
      for (const item of report.contexts) {
        try { report.contextDocuments.push({ context: item.context, document: await inspect.request('script.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title,width:innerWidth,height:innerHeight,ready:document.readyState,hidden:document.hidden,text:document.body?.innerText?.slice(0,400),html:document.body?.innerHTML?.slice(0,700)})', target: { context: item.context }, awaitPromise: false }) }); }
        catch (error) { report.contextDocuments.push({ context: item.context, error: error.message }); }
      }
      const context = report.contexts.find(context => context.url === base + '/work')?.context;
      if (context) {
        report.workDocument = await inspect.request('script.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title,width:innerWidth,height:innerHeight,ready:document.readyState,hidden:document.hidden,text:document.body?.innerText?.slice(0,500),html:document.body?.innerHTML?.slice(0,1200)})', target: { context }, awaitPromise: false });
        const screenshot = await inspect.request('browsingContext.captureScreenshot', { context, origin: 'viewport' });
        await writeFile(path.join(run, 'work-failure.png'), Buffer.from(screenshot.data, 'base64'));
      }
    } finally { await inspect.request('session.end', {}).catch(() => {}); inspect.close(); }
    throw error;
  }
  await call('snapshot', { tabId: tab.tabId });
  const filled = await call('fill', { tabId: tab.tabId, selector: '#name', text: '连接已整合' });
  await call('click', { tabId: tab.tabId, selector: '#trusted' });
  check('the connection enables real trusted background input', filled.native && (await call('snapshot', { tabId: tab.tabId })).text.includes('可信点击成功：连接已整合'));
  await call('task', { tabId: tab.tabId, outcome: 'completed', message: '连接后的操作结果已核对' });
  if (mode === 'existing') {
    const session = await call('open', { url: base + '/session', taskTitle: '核对原有登录会话' });
    await call('wait', { tabId: session.tabId, text: '已有登录会话仍在' });
    check('the AI tab uses the same persisted HttpOnly login session', (await call('snapshot', { tabId: session.tabId })).text.includes('已有登录会话仍在'));
  }
  await app.close();
  const afterCodexExit = await runPlatform({ action: 'profile-state', profile });
  check('closing the actual Codex app-server leaves the connected Zen running', afterCodexExit.locked);
  await startApp();
  const reconnected = await app.tool('zen_connection', { refresh: true });
  check('restarting Codex rediscovers the same live browser without setup or a Zen restart', reconnected.structuredContent.status === 'connected' && reconnected.structuredContent.connectionId === connectionId);
  if (localUi) await reloadUi();
  if (mode === 'existing') {
  await closeTarget(); await uiClick('refresh'); await waitUi('document.querySelector("#status").dataset.state==="disconnected"');
  check('a fully exited Zen is reported as disconnected', (await app.tool('zen_connection', { refresh: true })).structuredContent.status === 'disconnected');
  const previousPid = targetPid, stopped = await connectThroughUi('restart-after-full-exit', false);
  check('an unchanged prepared profile reconnects after full exit with one Connect click', stopped.launch.browserPid !== previousPid && (await runPlatform({ action: 'profile-state', profile })).locked);
  const retained = await call('open', { url: base + '/session', taskTitle: '浏览器重启后核对登录' });
  await call('wait', { tabId: retained.tabId, text: '已有登录会话仍在' });
  check('full browser exit and reconnect preserve the existing login session', true);
  await closeTarget();
  spawn(zen, ['--new-instance', '--profile', profile], { windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await runPlatform({ action: 'profile-state', profile })).locked; i++) await delay(100);
  await uiClick('refresh'); await waitUi('document.querySelector("#connect").disabled===false');
  check('opening Zen normally again reports the necessary reviewed restart', (await app.tool('zen_connection', { refresh: true }))._meta.uiState.needsRestart);
  await connectThroughUi('ordinary-start-after-full-exit', true);
  check('normal Zen startup reconnects through the UI without a special user command', true);
  const healthy = await readManaged(), healthyReceipt = JSON.parse(await readFile(healthy.record.installReceipt, 'utf8'));
  const damaged = path.join(healthyReceipt.extensionPath, 'manifest.json');
  await writeFile(damaged, (await readFile(damaged, 'utf8')) + '\n');
  await uiClick('refresh'); await waitUi('document.querySelector("#status").dataset.state==="failed"');
  check('a damaged installed component shows a concrete failure and a working retry', await evaluate('return document.querySelector("#error-code").textContent === "RUNTIME_INTEGRITY" && !document.querySelector("#connect").disabled;'));
  await capture('connection-repair.png');
  await connectThroughUi('repair-damaged-component', true);
  check('retry repairs the component and reconnects without manual setup', true);
  await app.close();
  for (const filename of ['package.json', '.codex-plugin/plugin.json', 'extension/manifest.json']) {
    const file = path.join(source, filename), manifest = JSON.parse(await readFile(file, 'utf8')); manifest.version = '0.4.1'; await writeFile(file, JSON.stringify(manifest, null, 2));
  }
  report.fixture.upgradeVersion = '0.4.1 test-only package';
  const upgrade = spawnSync(cli, ['plugin', 'add', 'zen-browser@zen-user-flow'], { cwd: market, env: installEnv, windowsHide: true, encoding: 'utf8' });
  if (upgrade.status !== 0) throw Error(upgrade.stderr || upgrade.stdout);
  await startApp(); if (localUi) await reloadUi(); await uiClick('refresh'); await waitUi('document.querySelector("#version").textContent==="v0.4.1"');
  const upgradeState = (await app.tool('zen_connection', { refresh: true }))._meta.uiState;
  check('an actual Codex plugin version update detects the old live extension', upgradeState.updateAvailable && upgradeState.needsRestart);
  const upgraded = await connectThroughUi('plugin-version-upgrade', true);
  check('the confirmed upgrade loads the new extension using a new stable runtime', upgraded.record.version === '0.4.1' && upgraded.record.installReceipt !== healthy.record.installReceipt);
  await uiClick('rollback'); await waitUi('document.querySelector("#confirm").hidden===false');
  report.confirmations.push({ stage: 'rollback', text: await evaluate('return document.querySelector("#confirm").innerText;') });
  await uiClick('approve'); await waitUi('document.querySelector("#status").dataset.state==="disconnected" && document.querySelector("#recovery").hidden');
  check('UI rollback restores the original user preferences and pre-install registration across upgrades', await userSource() === originalUserSource && (await runPlatform({ action: 'inspect', profiles: [], hostName: 'io.github.reasonw6.zen_browser_test' })).currentManifest === registryBefore);
  await capture('connection-restored.png');
  const otherProfile = path.join(roaming, 'zen', 'Profiles', 'secondary 测试'); await mkdir(otherProfile);
  await writeFile(path.join(roaming, 'zen', 'profiles.ini'), '[Profile0]\nName=连接验收\nIsRelative=1\nPath=Profiles/primary 测试\n\n[Profile1]\nName=第二个配置\nIsRelative=1\nPath=Profiles/secondary 测试\n');
  await reloadUi();
  await waitUi('document.querySelector("#profile").options.length===3');
  check('two ambiguous profiles require a user choice instead of silently choosing one', await evaluate('return !document.querySelector("#profile").hidden && !document.querySelector("#profile").value && document.querySelector("#connect").disabled;'));
  await capture('connection-multiple-profiles.png');
  const selectedId = (await app.tool('zen_connection', { refresh: true }))._meta.uiState.profiles.find(item => item.path === profile).id;
  await marionette.command('WebDriver:ElementClick', { id: await find('#profile option[value="' + selectedId + '"]') });
  await waitUi('document.querySelector("#connect").disabled===false');
  check('choosing a discovered profile enables connection without a path prompt', await evaluate('return document.querySelector("#profile").value;') === selectedId);
  }
  report.passed = true;
} catch (error) {
  if (error.inspectionOnly) report.passed = true;
  else {
    report.passed = false; report.error = error.stack; console.error(error.stack); process.exitCode = 1;
    try {
      report.bridgeEntriesAtFailure = [];
      for (const name of await readdir(path.join(bridgeHome, 'connections'))) {
        if (!name.endsWith('.json')) continue;
        const entry = JSON.parse(await readFile(path.join(bridgeHome, 'connections', name), 'utf8'));
        report.bridgeEntriesAtFailure.push({ pid: entry.pid, nativeInput: entry.nativeInput, extensionVersion: entry.extensionVersion, launchRecord: entry.launchRecord });
      }
    } catch (diagnosticError) { report.bridgeInspectionError = diagnosticError.message; }
    console.log('Connection diagnostics: ' + JSON.stringify(report.bridgeEntriesAtFailure));
    if (process.env.ZEN_DEBUG_FAILURE_HOLD === '1') {
      console.log('Inspect this test browser, then write debug-done in ' + run);
      for (let i = 0; i < 1200 && !await stat(path.join(run, 'debug-done')).then(() => true, () => false); i++) await delay(100);
    }
  }
}
finally {
  try { targetPid = (await readManaged()).launch?.browserPid || targetPid; } catch {}
  try { targetPid = (await runPlatform({ action: 'inspect', profiles: [profile] })).processes.find(item => item.profile === profile)?.pid || targetPid; } catch {}
  if (targetPid) {
    try { await closeTarget(); } catch (error) { report.targetCloseError = error.message; }
  }
  if (marionette) { await marionette.command('Marionette:Quit', { flags: ['eAttemptQuit'] }).catch(() => {}); marionette.close(); }
  await app?.close(); http.close();
  if (await stat(path.join(bridgeHome, 'connection-settings.json')).then(() => true, () => false)) {
    try {
      const managed = await readManaged();
      if (managed.record) {
        await runPlatform({ action: 'restore-profile', profile, receipt: managed.record.setupReceipt });
        await runPlatform({ action: 'restore-host', receipt: managed.record.installReceipt, hostName: 'io.github.reasonw6.zen_browser_test', allManagedVersions: true });
      }
    } catch (error) { report.rollbackError = error.message; process.exitCode = 1; }
  }
  const after = await runPlatform({ action: 'inspect', profiles: [], hostName: 'io.github.reasonw6.zen_browser_test' });
  const productionAfter = await runPlatform({ action: 'inspect', profiles: [] });
  report.testRegistrationRestored = after.currentManifest === registryBefore;
  report.productionRegistrationUnchanged = productionAfter.currentManifest === productionRegistryBefore;
  report.otherBrowsersPreserved = initialProcesses.every(before => after.processes.some(p => p.pid === before.pid && p.started === before.started));
  if (!report.testRegistrationRestored || !report.productionRegistrationUnchanged || !report.otherBrowsersPreserved) process.exitCode = 1;
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(run, 'ui-tool-trace.json'), JSON.stringify(trace, null, 2));
  await writeFile(path.join(run, 'codex.log'), app?.logs || ''); console.log('Evidence: ' + run);
}
