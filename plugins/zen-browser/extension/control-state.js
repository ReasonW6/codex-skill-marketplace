(() => {
  'use strict';
  const LABELS = { observing: '等待观察', idle: '等待下一步', running: '运行中', paused: '已暂停', user_control: '你已接管', waiting_user: '等待用户', completed: '已完成', failed: '执行失败' };
  const ACTIVE = new Set(['observing', 'idle', 'running']);
  class ZenControlStore {
    records = new Map();
    revision = 0;
    error(code, message) { return Object.assign(new Error(message), { code }); }
    create(tabId, owner, options = {}) {
      const previous = this.records.get(tabId);
      if (previous?.owner && previous.owner !== owner && previous.state !== 'completed') throw this.error('TAB_BUSY', 'This tab belongs to another MCP connection.');
      if (previous && previous.state !== 'completed') {
        previous.owner = owner;
        previous.connected = true;
        previous.stopping = false;
        previous.epoch = ++this.revision;
        previous.stopEpoch = previous.epoch;
        previous.frames.clear();
        // Reconnecting or re-attaching cannot override a human stop.
        if (ACTIVE.has(previous.state)) previous.state = 'observing';
        previous.reason = ACTIVE.has(previous.state) ? '已连接，先重新观察页面' : '已重新连接；点击继续后重新观察';
        return previous;
      }
      const record = { tabId, owner, lastOwner: owner, connected: true, epoch: ++this.revision,
        state: 'observing', reason: '已连接，等待 AI 观察页面', taskTitle: options.taskTitle || 'AI 浏览任务',
        createdBy: options.created ? owner : null, frames: new Map(), step: null, history: [], sequence: 0,
        marking: previous?.marking || 'title', groupId: previous?.groupId ?? null, collapsed: false, selected: false };
      record.stopEpoch = record.epoch;
      this.records.set(tabId, record);
      return record;
    }
    get(tabId) { return this.records.get(tabId); }
    capture(tabId) { const record = this.get(tabId); return record ? record.epoch : null; }
    require(tabId, owner, epoch, { readOnly = false, frameId, observed = false } = {}) {
      const record = this.get(tabId);
      if (!record) throw this.error('NOT_ATTACHED', 'Attach the requested Zen tab before operating it.');
      if (record.owner !== owner && !(readOnly && record.state === 'completed' && record.lastOwner === owner)) throw this.error(record.owner ? 'TAB_BUSY' : 'NOT_ATTACHED', 'This MCP connection does not own the tab.');
      if (epoch !== undefined && epoch !== record.epoch) throw this.error('CONTROL_CHANGED', 'Control changed after this instruction was queued. This instruction was not replayed. Observe before planning another action.');
      if (!readOnly && !ACTIVE.has(record.state)) throw this.error('CONTROL_STOPPED', `${LABELS[record.state]}. The user must choose Continue; queued writes will not resume automatically.`);
      if (observed && !record.frames.get(frameId ?? 0)?.observed) throw this.error('OBSERVATION_REQUIRED', 'Read a fresh zen_snapshot of this frame before writing.');
      return record;
    }
    interrupt(record, state, reason, { navigation = false } = {}) {
      record.epoch = ++this.revision;
      record.stopping = false;
      if (!navigation) record.stopEpoch = record.epoch;
      record.frames.clear();
      if ((!navigation || record.step?.command !== 'wait') && (record.step?.phase === 'running' || record.step?.phase === 'preparing')) {
        record.step = { ...record.step, phase: 'interrupted', endedAt: Date.now(), detail: '停止后续操作；已发生的网页动作不会撤销' };
      }
      record.state = state;
      record.reason = reason;
      return record;
    }
    resume(record) {
      if (!record.owner || !record.connected) throw this.error('NOT_CONNECTED', 'Reconnect the MCP session and attach this tab before choosing Continue.');
      if (record.state === 'completed') throw this.error('TASK_COMPLETED', 'This task is complete. Start a new task explicitly.');
      return this.interrupt(record, 'observing', '已继续；等待 AI 重新读取页面，旧指令不会重放');
    }
    frame(record, frameId, documentId) {
      let frame = record.frames.get(frameId);
      if (!frame || frame.documentId !== documentId) {
        frame = { documentId, observed: false, snapshotId: null };
        record.frames.set(frameId, frame);
      }
      return frame;
    }
    observe(record, frameId, documentId, snapshotId) {
      Object.assign(this.frame(record, frameId, documentId), { observed: true, snapshotId });
      if (ACTIVE.has(record.state)) { record.state = 'idle'; record.reason = '页面已观察，等待下一条真实指令'; }
    }
    begin(record, command) {
      const label = ({ click: '准备点击目标', fill: '准备填写内容', select: '准备选择选项', check: '准备勾选', press: '准备按键', scroll: '准备滚动', navigate: '正在导航', close: '关闭后台标签', wait: '等待网页内容' })[command] || '处理网页指令';
      record.step = { number: ++record.sequence, command, phase: 'running', label, startedAt: Date.now() };
      if (ACTIVE.has(record.state)) { record.state = 'running'; record.reason = '正在执行指令'; }
      return record.step.number;
    }
    end(record, epoch, number, result) {
      if (record.epoch !== epoch || record.step?.number !== number) return;
      record.step = { ...record.step, phase: 'succeeded', endedAt: Date.now(), detail: result?.summary || '指令已执行，请以网页实际结果为准' };
      record.history = [...record.history, record.step].slice(-8);
      if (ACTIVE.has(record.state)) { record.state = 'idle'; record.reason = '本步已结束，等待下一条指令'; }
    }
    fail(record, epoch, number, error) {
      if (record.epoch !== epoch || record.step?.number !== number) return;
      record.step = { ...record.step, phase: 'failed', endedAt: Date.now(), detail: error.message };
      record.history = [...record.history, record.step].slice(-8);
      this.interrupt(record, 'failed', error.message);
    }
    finish(record, outcome, reason) {
      this.interrupt(record, outcome, reason);
      if (outcome === 'completed') { record.lastOwner = record.owner; record.owner = null; }
    }
    disconnect(owner, reason = '连接已断开；重新连接后由你决定何时继续') {
      const changed = [];
      for (const record of this.records.values()) if (record.owner && (!owner || record.owner === owner)) {
        const state = ['user_control', 'failed'].includes(record.state) ? record.state : 'waiting_user';
        this.interrupt(record, state, state === 'failed' ? record.reason + '；连接已断开' : reason);
        record.lastOwner = record.owner; record.owner = null; record.connected = false; changed.push(record);
      }
      return changed;
    }
    public(record) {
      return { tabId: record.tabId, epoch: record.epoch, state: record.state, label: LABELS[record.state], reason: record.reason,
        taskTitle: record.taskTitle, pageTitle: record.pageTitle, site: record.site, connected: record.connected, controlled: !!record.owner && ACTIVE.has(record.state),
        canResume: !!record.owner && record.connected && !record.stopping && !ACTIVE.has(record.state) && record.state !== 'completed', stopping: !!record.stopping,
        needsObservation: !record.frames.get(0)?.observed, step: record.step, history: record.history,
        marking: record.marking, markingNote: record.markingNote, groupId: record.groupId, collapsed: record.collapsed, selected: record.selected };
    }
  }
  globalThis.ZenControlStore = ZenControlStore;
  globalThis.ZenControlActive = ACTIVE;
})();
