/* global browser */
const toggle = document.querySelector('#toggle');
const cards = new Map();
let enabled = true;
function render(state) {
  enabled = state.enabled;
  document.querySelector('#status').textContent = !state.enabled ? '已暂停' : state.connected ? '已连接本机桥接服务' : '等待本机桥接服务';
  document.querySelector('#details').textContent = state.connected ? '正在控制 ' + state.controlledTabs + ' 个标签页' : '检查本机宿主和连接状态后再继续。';
  toggle.textContent = state.enabled ? '暂停全部 AI 控制' : '启用连接';
  toggle.disabled = false;
  const error = document.querySelector('#error');
  error.hidden = !state.lastError || !state.enabled;
  error.textContent = state.lastError || '';
  const tasks = document.querySelector('#tasks'), present = new Set();
  for (const tab of state.tabs || []) {
    present.add(tab.tabId);
    let card = cards.get(tab.tabId);
    if (!card) {
      card = document.createElement('section'); card.className = 'task';
      card.innerHTML = '<strong></strong><span class="task-state"></span><div class="task-page"></div><p></p><div class="task-actions"></div>';
      const actions = card.querySelector('.task-actions');
      for (const [action, label] of [['pause','暂停'],['resume','继续'],['takeover','接管']]) {
        const button = document.createElement('button'); button.textContent = label; button.dataset.action = action;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await browser.runtime.sendMessage({ type: 'popup-control', tabId: tab.tabId, action }); await refresh(); }
          catch (error) { card.querySelector('p').textContent = error.message; button.disabled = false; }
        });
        actions.append(button);
      }
      cards.set(tab.tabId, card); tasks.append(card);
    }
    card.dataset.state = tab.state;
    card.querySelector('strong').textContent = tab.taskTitle;
    card.querySelector('.task-state').textContent = tab.stopping ? '正在停止' : tab.label;
    card.querySelector('.task-page').textContent = [tab.site, tab.pageTitle].filter(Boolean).join(' · ');
    card.querySelector('p').textContent = tab.state === 'running' && tab.step ? tab.step.label : tab.reason;
    const active = ['running','idle','observing'].includes(tab.state);
    card.querySelector('.task-actions').hidden = tab.state === 'completed';
    card.querySelector('[data-action=pause]').hidden = !active;
    card.querySelector('[data-action=pause]').disabled = !active;
    card.querySelector('[data-action=resume]').hidden = active;
    card.querySelector('[data-action=resume]').disabled = !tab.canResume;
    card.querySelector('[data-action=takeover]').disabled = tab.state === 'user_control';
  }
  for (const [tabId, card] of cards) if (!present.has(tabId)) { card.remove(); cards.delete(tabId); }
}
async function refresh() {
  try { render(await browser.runtime.sendMessage({ type: 'popup-status' })); }
  catch (error) { document.querySelector('#status').textContent = error.message; }
}
toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try { render(await browser.runtime.sendMessage({ type: 'popup-toggle', enabled: !enabled })); }
  catch (error) { document.querySelector('#status').textContent = error.message; toggle.disabled = false; }
});
refresh();
setInterval(refresh, 1500);
