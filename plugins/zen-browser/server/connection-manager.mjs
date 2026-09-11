import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, rename, stat } from 'node:fs/promises';
import { dataHome, discover, HOST_NAME } from './paths.mjs';
import { launchZen } from './launch-zen.mjs';
import { runPlatform, acquireConnectionLock, pluginRoot, platformError } from './windows.mjs';
import { readProfiles, chooseProfile, samePath, pathId } from './profiles.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alivePid = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const asError = error => ({ code: error.code || 'CONNECTION_FAILED', message: error.message });
const STATUS = { disconnected: '未连接', connecting: '连接中', connected: '已连接', failed: '连接失败' };
const PHASES = {
  inspecting: '正在核对浏览器和配置', installing: '正在准备本机通信组件', closing: '正在请求 Zen 保存会话并正常退出',
  waiting_exit: '请正常退出所选配置的 Zen 窗口，退出后将自动继续', configuring: '正在应用已确认的连接设置',
  waiting_browser: '请在 Zen 中完成浏览器自身的首次引导，并保持窗口展开，然后点击“引导已完成”。',
  starting: '正在启动 Zen 并加载扩展', verifying: '正在确认浏览器连接', restoring: '正在恢复连接前的设置'
};

export class ConnectionManager {
  constructor({ home = dataHome(), roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    source = pluginRoot, hostName = process.env.ZEN_BRIDGE_HOST_NAME || HOST_NAME, platform = runPlatform,
    lock = acquireConnectionLock, launch = launchZen, connections = discover, client, hidden = false } = {}) {
    this.home = path.resolve(home); this.roaming = roaming; this.source = path.resolve(source); this.hostName = hostName;
    this.platform = platform; this.lock = lock; this.launch = launch; this.connections = connections; this.client = client; this.hidden = hidden;
    this.settingsFile = path.join(this.home, 'connection-settings.json'); this.settings = { schemaVersion: 1, profiles: {} };
    this.tickets = new Map(); this.job = null; this.inventoryCache = null; this.lastError = null; this.closed = false;
  }
  async version() { return JSON.parse(await readFile(path.join(this.source, 'package.json'), 'utf8')).version; }
  async loadSettings() {
    let settings;
    try { settings = JSON.parse(await readFile(this.settingsFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, profiles: {} }; throw platformError('SETTINGS_UNREADABLE', '连接记录无法读取，原文件已保留。请检查插件的文件访问权限后重试。'); }
    if (settings.schemaVersion !== 1 || !settings.profiles || typeof settings.profiles !== 'object') throw platformError('SETTINGS_VERSION', '连接记录版本无法识别，原文件已保留。');
    return settings;
  }
  async saveSettings() {
    // The Windows installer has already created and protected this directory.
    const temporary = path.join(this.home, 'connection-settings-' + randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify(this.settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.settingsFile);
  }
  async buildId() {
    if (this.buildIdentity) return this.buildIdentity;
    const hash = createHash('sha256');
    async function add(root, relative) {
      const filename = path.join(root, relative);
      if ((await stat(filename)).isDirectory()) { for (const name of (await readdir(filename)).sort()) await add(root, relative + '/' + name); }
      else { hash.update(relative); hash.update(await readFile(filename)); }
    }
    for (const relative of ['extension', 'runtime/manifest.json', 'bin/manifest.json', 'server/native-host.mjs', 'server/wire.mjs', 'server/paths.mjs', 'server/bidi.mjs', 'server/native-driver.mjs']) await add(this.source, relative);
    this.buildIdentity = hash.digest('hex'); return this.buildIdentity;
  }
  async inventory(force = false) {
    if (!force && this.inventoryCache && Date.now() - this.inventoryCache.at < 5000) return this.inventoryCache.value;
    const [catalog, settings] = await Promise.all([this.platform({ action: 'profile-catalog', roaming: this.roaming }), this.loadSettings()]);
    const profiles = await readProfiles(this.roaming, catalog.source);
    const knownBinaries = [...Object.values(settings.profiles), settings.pending].map(record => record?.binary).filter(Boolean);
    const windows = await this.platform({ action: 'inspect', hostName: this.hostName, profiles: profiles.profiles.map(p => p.path), binaries: knownBinaries });
    const browsers = windows.binaries.map(binary => ({ ...binary, id: pathId('browser', binary.path) }));
    const items = profiles.profiles.map(profile => {
      const state = windows.profiles.find(p => samePath(p.path, profile.path)) || {};
      const processes = [...(state.processes || []), ...windows.processes.filter(p => samePath(p.profile, profile.path))];
      return { ...profile, ...state, id: profile.id, name: profile.name, processes: [...new Map(processes.map(p => [p.pid, p])).values()] };
    });
    const profileId = chooseProfile(items, settings.pending?.profileId || settings.selectedProfileId), selected = items.find(p => p.id === profileId);
    const runningBinary = selected?.processes.length === 1 ? selected.processes[0].binary : null;
    const preferredBinary = settings.pending?.profileId === profileId ? settings.pending.binary : settings.profiles[profileId]?.binary;
    const browserId = browsers.find(b => samePath(b.path, runningBinary))?.id || browsers.find(b => samePath(b.path, preferredBinary))?.id || (browsers.length === 1 ? browsers[0].id : null);
    const value = { browsers, profiles: items, selection: { browserId, profileId }, currentManifest: windows.currentManifest, sourceHash: profiles.sourceHash, settings, hostJob: windows.job };
    this.inventoryCache = { value, at: Date.now() }; return value;
  }
  async liveConnections() {
    const entries = await this.connections(this.home), result = [];
    for (const entry of entries) {
      if (!entry.launchRecord || !samePath(path.dirname(entry.launchRecord), path.join(this.home, 'launches'))) continue;
      let record;
      try { record = JSON.parse(await readFile(entry.launchRecord, 'utf8')); } catch { continue; }
      if (!record.ready || !alivePid(record.browserPid)) continue;
      result.push({ ...entry, profileId: pathId('profile', record.profile), profile: record.profile, browserPid: record.browserPid, launchRecord: entry.launchRecord });
    }
    return result;
  }
  async installed(inventory) {
    if (!inventory.currentManifest) return null;
    let names;
    try { names = (await readdir(this.home)).filter(name => /^install-[\d-]+\.json$/.test(name)).sort().reverse(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    for (const name of names) {
      const receipt = JSON.parse(await readFile(path.join(this.home, name), 'utf8'));
      if (samePath(receipt.manifestPath, inventory.currentManifest) && samePath(receipt.installRoot, this.home)) {
        const file = path.join(this.home, name);
        const verification = await this.platform({ action: 'verify-install', receipt: file });
        return { ...receipt, receipt: file, platformPath: path.join(receipt.runtimePath, 'zen-platform.exe'), healthy: verification.healthy };
      }
    }
    return null;
  }
  async state({ refresh = false, profileId, browserId } = {}) {
    let inventory, connections = [];
    try {
      inventory = this.job?.running && this.inventoryCache ? this.inventoryCache.value : await this.inventory(refresh);
      connections = await this.liveConnections();
    } catch (error) {
      this.lastError = asError(error);
      return { status: 'failed', label: STATUS.failed, reason: error.message, error: this.lastError, browsers: [], profiles: [], selection: {}, canConnect: false, canRetry: true, version: await this.version() };
    }
    const selection = { browserId: browserId || inventory.selection.browserId, profileId: profileId || inventory.selection.profileId };
    const profile = inventory.profiles.find(p => p.id === selection.profileId), browser = inventory.browsers.find(b => b.id === selection.browserId);
    const connection = connections.find(c => c.profileId === selection.profileId), version = await this.version();
    let compatible = connection?.extensionVersion === version && connection.nativeInput && inventory.currentManifest !== this.unhealthyManifest;
    if (compatible && refresh) {
      const installation = await this.installed(inventory);
      if (!installation?.healthy) { compatible = false; this.unhealthyManifest = inventory.currentManifest; this.lastError = { code: 'RUNTIME_INTEGRITY', message: '通信组件缺失或已更改，点击连接可自动修复。' }; }
    }
    const otherJob = inventory.settings.pending?.pid && alivePid(inventory.settings.pending.pid) && inventory.settings.pending.pid !== process.pid ? inventory.settings.pending : null;
    const activeJob = this.job?.running ? this.job : otherJob;
    let status = activeJob ? 'connecting' : this.lastError?.code === 'CONNECTION_CANCELLED' ? 'disconnected' : this.lastError ? 'failed' : compatible ? 'connected' : 'disconnected';
    if (compatible && !activeJob) status = 'connected';
    let reason = activeJob ? (activeJob.phase === 'waiting_browser' && activeJob.browserInstruction || PHASES[activeJob.phase]) || '另一个 Codex 连接正在准备浏览器' : compatible ? '可以直接用自然语言操作网页，也可以随时打开 AI 标签观看。' :
      inventory.browsers.length === 0 ? '未找到已安装的 Zen。安装 Zen 后点击重新检测。' : inventory.profiles.length === 0 ? '还没有可用的 Zen 配置。先正常打开一次 Zen，完成浏览器自身的首次启动，再回到这里。' :
      !profile || !browser ? '存在多个候选，请选择要连接的浏览器和配置。' : profile.locked ? 'Zen 已打开，连接原生输入需要确认一次重启。' : '已找到 Zen，点击连接即可准备并打开浏览器。';
    if (this.lastError && (status === 'failed' || this.lastError.code === 'CONNECTION_CANCELLED' && !activeJob)) reason = this.lastError.message;
    else if (!activeJob && status === 'disconnected' && this.notice) reason = this.notice;
    return { status, label: STATUS[status], reason, version, selection,
      diagnostics: { dataHome: this.home, hostName: this.hostName, nodeVersion: process.version, executable: process.execPath, hostJob: inventory.hostJob, uiClient: this.uiClient },
      browsers: inventory.browsers.map(b => ({ id: b.id, name: 'Zen ' + (b.version || ''), path: b.path })),
      profiles: inventory.profiles.map(p => ({ id: p.id, name: p.name, path: p.path, running: !!p.locked, isDefault: p.isDefault, available: p.exists && p.accessible !== false })),
      canConnect: !activeJob && !compatible && !!profile?.exists && profile.accessible !== false && !!browser,
      canRetry: !activeJob, canRollback: !activeJob && !!(inventory.settings.profiles[selection.profileId] || inventory.settings.pending?.profileId === selection.profileId),
      canCancel: this.job?.running === true && ['waiting_exit', 'waiting_browser'].includes(this.job.phase),
      browserReadyTicket: this.job?.running && this.job.phase === 'waiting_browser' ? this.job.browserReadyTicket : null,
      browserReadyLabel: this.job?.browserReason === 'activate' ? '窗口已打开，继续连接' : '引导已完成，继续连接',
      needsRestart: !!profile?.locked && !compatible, phase: activeJob?.phase || null, error: status === 'failed' ? this.lastError : null,
      connectionId: compatible ? connection.id : null, nativeInput: !!compatible, updateAvailable: !!connection && !compatible };
  }
  async plan({ profileId, browserId, operation = 'connect' }) {
    if (this.job?.running) throw platformError('CONNECTION_BUSY', '连接操作正在执行，请等待完成。');
    const inventory = await this.inventory(true);
    profileId ||= inventory.selection.profileId; browserId ||= inventory.selection.browserId;
    const profile = inventory.profiles.find(p => p.id === profileId), browser = inventory.browsers.find(b => b.id === browserId);
    if (!profile?.exists || profile.accessible === false || !browser) throw platformError('SELECTION_REQUIRED', '请选择已发现的 Zen 和可用配置。');
    const installed = await this.installed(inventory), buildId = await this.buildId();
    const current = installed?.buildId === buildId && installed.healthy;
    const previous = inventory.settings.profiles[profileId] || (inventory.settings.pending?.profileId === profileId ? inventory.settings.pending : null);
    if (operation === 'rollback' && !previous) throw platformError('NOTHING_TO_RESTORE', '这个配置没有本插件记录的设置需要恢复。');
    const live = (await this.liveConnections()).find(c => c.profileId === profileId);
    const connected = operation === 'connect' && current && live?.extensionVersion === await this.version() && live?.nativeInput;
    const changedPreference = operation === 'connect' && !profile.recommendedPreferencesDisabled;
    const process = profile.processes.length === 1 && samePath(profile.processes[0].binary, browser.path) ? profile.processes[0] : null;
    const restart = profile.locked && !connected;
    const manualExit = restart && !process;
    const changes = [];
    if (operation === 'rollback') {
      changes.push('恢复这个配置由本插件添加的连接偏好，保留其他设置与网页数据。');
      changes.push('如果没有其他配置使用通信组件，恢复安装前的通信注册。文件和回滚记录会保留。');
    } else if (!connected) {
      if (!current) changes.push('为当前 Windows 账户准备随包通信组件；不需要管理员权限或另装运行时。');
      if (changedPreference) changes.push('关闭 Firefox 的自动化偏好批量调整，避免它替你改变其他浏览器设置；此项可回滚。');
      changes.push('为所选 Zen 启用仅本机可访问的浏览器控制通道，并自动加载未签名扩展；不更改扩展签名校验。');
    }
    if (restart) changes.push(operation === 'rollback' ?
      (manualExit ? '恢复设置前，请先保存未提交内容并正常退出这个配置的 Zen 窗口。恢复后可以按平常方式重新打开。' : '请先保存未提交内容。确认后请求这个 Zen 实例正常退出，再恢复设置；之后可以按平常方式重新打开。') :
      (manualExit ? '请先保存未提交内容。确认后正常退出这个配置的 Zen 窗口，插件会自动接着打开并恢复会话。' : '请先保存未提交内容。确认后请求这个 Zen 实例正常退出，再打开并恢复会话；不会强制结束进程。'));
    for (const [token, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(token);
    if (this.tickets.size >= 12) this.tickets.delete(this.tickets.keys().next().value);
    const token = randomUUID(), ticket = { token, expires: Date.now() + 5 * 60 * 1000, operation, profile, browser, process,
      sourceHash: inventory.sourceHash, currentManifest: inventory.currentManifest, installed, buildId, previous, restart, manualExit, connected, changes };
    this.tickets.set(token, ticket);
    return { public: { operation, profile: profile.name, browser: 'Zen ' + browser.version, changes, needsRestart: restart, manualExit,
      needsConfirmation: operation === 'rollback' || !connected && (!current || changedPreference || restart), alreadyConnected: !!connected }, token };
  }
  async apply(token) {
    const ticket = this.tickets.get(token); this.tickets.delete(token);
    if (!ticket || ticket.expires < Date.now()) throw platformError('CONFIRMATION_EXPIRED', '连接确认已失效，请重新点击连接。');
    if (this.job?.running) throw platformError('CONNECTION_BUSY', '连接操作正在执行，请等待完成。');
    this.lastError = null;
    this.notice = null;
    if (ticket.connected) return this.state({ refresh: true, profileId: ticket.profile.id, browserId: ticket.browser.id });
    this.job = { id: randomUUID(), running: true, phase: 'inspecting', profileId: ticket.profile.id, pid: process.pid };
    if (this.inventoryCache) this.inventoryCache.value.selection = { profileId: ticket.profile.id, browserId: ticket.browser.id };
    this.job.promise = this.execute(ticket).catch(error => { this.lastError = asError(error); }).finally(() => { this.job.running = false; this.inventoryCache = null; });
    return this.state({ profileId: ticket.profile.id, browserId: ticket.browser.id });
  }
  checkAlive() { if (this.closed || this.job?.cancelled) throw platformError('CONNECTION_CANCELLED', '后续连接步骤已取消。已准备的组件可以下次继续使用，也可以恢复连接前的设置。'); }
  async phase(phase) {
    this.checkAlive(); this.job.phase = phase;
    if (this.settings.pending) { this.settings.pending.phase = phase; this.settings.pending.pid = process.pid; await this.saveSettings(); }
  }
  async awaitClosed(ticket) {
    if (!ticket.restart) return;
    let manualExit = ticket.manualExit;
    if (!ticket.manualExit) {
      await this.phase('closing');
      try { await this.platform({ action: 'close-profile', profile: ticket.profile.path, binary: ticket.browser.path, pid: ticket.process.pid, started: ticket.process.started }, { timeoutMs: 45000 }); }
      catch (error) {
        if (error.code !== 'CLOSE_DECLINED') throw error;
        manualExit = true; await this.phase('waiting_exit');
      }
    } else await this.phase('waiting_exit');
    const deadline = Date.now() + (manualExit ? 5 * 60 * 1000 : 30000);
    while (Date.now() < deadline) {
      this.checkAlive();
      const state = await this.platform({ action: 'profile-state', profile: ticket.profile.path });
      if (!state.locked) return;
      await pause(500);
    }
    throw platformError('PROFILE_STILL_RUNNING', '所选 Zen 配置还没有退出。保存未提交内容并正常退出后，点击重试。');
  }
  async execute(ticket) {
    const release = await this.lock(this.home);
    try {
      this.checkAlive();
      const current = await this.inventory(true), profile = current.profiles.find(p => p.id === ticket.profile.id);
      if (!profile || profile.locked !== ticket.profile.locked || profile.recommendedPreferencesDisabled !== ticket.profile.recommendedPreferencesDisabled || current.sourceHash !== ticket.sourceHash || current.currentManifest !== ticket.currentManifest ||
          !current.browsers.some(browser => browser.id === ticket.browser.id) ||
          ticket.process && !profile.processes.some(p => p.pid === ticket.process.pid && p.started === ticket.process.started))
        throw platformError('BROWSER_CHANGED', '浏览器状态在确认后发生变化，请重新连接确认。');
      this.settings = current.settings;
      if (ticket.operation === 'rollback') { await this.rollback(ticket); return; }
      let installed = await this.installed(current);
      if (!installed || installed.buildId !== ticket.buildId || !installed.healthy) {
        await this.phase('installing');
        installed = await this.platform({ action: 'install', source: this.source, home: this.home, hostName: this.hostName, buildId: ticket.buildId }, { timeoutMs: 30000 });
      }
      this.unhealthyManifest = undefined;
      this.settings.pending = { profileId: ticket.profile.id, profile: ticket.profile.path, binary: ticket.browser.path,
        setupReceipt: ticket.previous?.setupReceipt || null, installReceipt: installed.receipt, pid: process.pid, phase: this.job.phase };
      await this.saveSettings();
      await this.awaitClosed(ticket);
      await this.phase('configuring');
      const hasSession = ticket.restart || (await this.platform({ action: 'profile-state', profile: ticket.profile.path })).hasSession;
      const prepared = await this.platform({ action: 'prepare-profile', profile: ticket.profile.path, home: this.home, restoreSession: hasSession });
      if (!this.settings.pending.setupReceipt || prepared.preferenceChanged) this.settings.pending.setupReceipt = prepared.receipt;
      this.settings.pending.sessionReceipt = prepared.receipt; await this.saveSettings();
      await this.phase('starting');
      const launched = await this.launch({ binary: ticket.browser.path, profile: ticket.profile.path, home: this.home, extension: installed.extensionPath, worker: installed.platformPath, hidden: this.hidden,
        checkCancelled: () => this.checkAlive(), onWaitingForBrowser: async ({ launchRecord, reason = 'onboarding' }) => {
          this.job.browserReason = reason;
          this.job.browserInstruction = reason === 'activate' ? 'Zen 正在等待窗口启动。请点击刚打开的 Zen 窗口，再回到这里点击“窗口已打开，继续连接”。' : PHASES.waiting_browser;
          this.settings.pending.launchRecord = launchRecord; await this.phase('waiting_browser');
          this.job.browserReadyTicket = randomUUID();
          const deadline = Date.now() + 5 * 60 * 1000;
          while (this.job.browserReadyTicket && Date.now() < deadline) { this.checkAlive(); await pause(150); }
          if (this.job.browserReadyTicket) throw platformError('BROWSER_NOT_READY', '尚未确认完成 Zen 的首次引导。完成后点击重试连接。');
          await this.phase('verifying');
        } });
      this.settings.pending.launchRecord = launched.launchRecord; await this.phase('verifying');
      const deadline = Date.now() + 15000; let connection;
      while (Date.now() < deadline) {
        this.checkAlive(); connection = (await this.liveConnections()).find(c => c.profileId === ticket.profile.id && c.extensionVersion === launched.extensionVersion && c.nativeInput);
        if (connection) break;
        await pause(150);
      }
      if (!connection) throw platformError('EXTENSION_NOT_CONNECTED', 'Zen 已打开，但扩展还没有连接。请保留浏览器，点击重新检测或重试。');
      if (this.client) await this.client.request('tabs', { connectionId: connection.id }, 10000);
      this.settings.profiles[ticket.profile.id] = { ...this.settings.pending, pid: undefined, phase: undefined,
        connectionId: connection.id, version: launched.extensionVersion, connectedAt: new Date().toISOString() };
      this.settings.selectedProfileId = ticket.profile.id; delete this.settings.pending; await this.saveSettings();
    } finally {
      if (this.settings.pending?.pid === process.pid) { delete this.settings.pending.pid; try { await this.saveSettings(); } catch { /* Keep the original connection error; the install receipts remain available. */ } }
      release();
    }
  }
  async rollback(ticket) {
    await this.awaitClosed(ticket); await this.phase('restoring');
    const record = this.settings.profiles[ticket.profile.id] || this.settings.pending;
    if (!record || record.profileId !== ticket.profile.id) throw platformError('NOTHING_TO_RESTORE', '这个配置没有可恢复的连接记录。');
    if (record.setupReceipt) await this.platform({ action: 'restore-profile', profile: ticket.profile.path, receipt: record.setupReceipt });
    if (record.sessionReceipt && record.sessionReceipt !== record.setupReceipt) await this.platform({ action: 'restore-profile', profile: ticket.profile.path, receipt: record.sessionReceipt });
    const others = Object.keys(this.settings.profiles).filter(id => id !== ticket.profile.id);
    if (!others.length && !(this.settings.pending && this.settings.pending.profileId !== ticket.profile.id) && record.installReceipt && !(await this.liveConnections()).some(c => c.profileId !== ticket.profile.id)) {
      const current = await this.inventory(true), currentInstallation = await this.installed(current);
      if (currentInstallation) await this.platform({ action: 'restore-host', receipt: currentInstallation.receipt, hostName: this.hostName, allManagedVersions: true });
      else if (current.currentManifest) this.notice = '已恢复这个配置的连接偏好。通信注册已由其他安装更改，本次保留了那项更改。';
    }
    delete this.settings.profiles[ticket.profile.id];
    if (this.settings.pending?.profileId === ticket.profile.id) delete this.settings.pending;
    if (this.settings.selectedProfileId === ticket.profile.id) delete this.settings.selectedProfileId;
    await this.saveSettings(); this.lastError = null;
    this.notice ||= '已恢复连接前的设置。可以按平常方式打开 Zen；组件文件与回滚记录仍保留。';
  }
  close() { this.closed = true; this.tickets.clear(); }
  resume(ticket) {
    if (!this.job?.running || this.job.phase !== 'waiting_browser' || !ticket || ticket !== this.job.browserReadyTicket)
      throw platformError('CONFIRMATION_EXPIRED', '浏览器引导确认已失效，请重新打开连接页。');
    this.job.browserReadyTicket = null; return this.state();
  }
  cancel() {
    if (this.job?.running && ['waiting_exit', 'waiting_browser'].includes(this.job.phase)) this.job.cancelled = true;
    return this.state();
  }
}
