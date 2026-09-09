/* global browser */
const toggle = document.querySelector('#toggle');
let enabled = true;
function render(state) {
  enabled = state.enabled;
  document.querySelector('#status').textContent = !state.enabled ? '已暂停' : state.connected ? '已连接本机桥接服务' : '等待本机桥接服务';
  document.querySelector('#details').textContent = state.connected ? `正在控制 ${state.controlledTabs} 个后台标签页` : '先运行 install-host.ps1，然后重新启用连接。';
  toggle.textContent = state.enabled ? '暂停控制' : '启用连接';
  toggle.disabled = false;
  const error = document.querySelector('#error');
  error.hidden = !state.lastError || !state.enabled;
  error.textContent = state.lastError || '';
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
