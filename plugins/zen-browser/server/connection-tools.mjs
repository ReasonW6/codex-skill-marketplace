export const CONNECTION_RESOURCE = 'ui://zen-browser/connection-v4.html';
export const CONNECTION_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#356b58"/><path d="M9 9h14L9 23h14" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>');
const id = { type: 'string', minLength: 1, maxLength: 40 };
const selection = { profileId: id, browserId: id };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const annotations = readOnlyHint => ({ readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false });
const privateUi = { ui: { resourceUri: CONNECTION_RESOURCE, visibility: ['app'] } };

export const CONNECTION_TOOLS = [
  {
    name: 'zen_connection', command: 'connection', title: '连接 Zen',
    description: 'Show Connect Zen inside MCP Apps clients, or return a real local connection-page link for other clients. Read-only discovery; opening this page does not install components, change preferences, close or launch a browser. The user connects and confirms necessary setup in the page. Use when asked to connect Zen or when a browser task needs an initial connection. Never direct users to internal installation scripts.',
    inputSchema: schema({ ...selection, refresh: { type: 'boolean' }, localPage: { type: 'boolean', description: 'Return the local-page link if the embedded connection UI cannot be displayed.' } }), annotations: annotations(true),
    _meta: {
      ui: { resourceUri: CONNECTION_RESOURCE },
      'openai/ui': { preferredModelDisplayMode: 'inline', entrypoints: [
        { type: 'global', quickAction: { title: '连接 Zen', icons: [{ src: CONNECTION_ICON, mimeType: 'image/svg+xml' }], target: { type: 'tool', name: 'zen_connection', input: {} } } },
        { type: 'settings', searchTerms: ['Zen', '浏览器', '连接'] }, { type: 'thread' }
      ] },
      'openai/toolInvocation/invoking': '正在检测 Zen', 'openai/toolInvocation/invoked': '连接 Zen'
    }
  },
  {
    name: 'zen_connection_plan', command: 'connection_plan', title: '预览连接设置',
    description: 'Connection UI only: preview the exact discovered selection and any setup or restart needed. Does not change the browser or installation.',
    inputSchema: schema({ ...selection, operation: { type: 'string', enum: ['connect', 'rollback'] } }), annotations: annotations(true), _meta: privateUi
  },
  {
    name: 'zen_connection_apply', command: 'connection_apply', title: '确认连接设置',
    description: 'Connection UI only: consume the one-use confirmation ticket after the user reviews and accepts it. Prepares the bundled components and connects, or restores the confirmed settings. Does not force-kill browsers.',
    inputSchema: schema({ ticket: id }, ['ticket']), annotations: annotations(false), _meta: privateUi
  },
  {
    name: 'zen_connection_resume', command: 'connection_resume', title: '继续已确认的浏览器连接',
    description: 'Connection UI only: the user confirms they opened the Zen window or completed its first-run wizard. Resumes this already approved setup; never changes browser welcome, theme or default-browser choices.',
    inputSchema: schema({ ticket: id }, ['ticket']), annotations: annotations(false), _meta: privateUi
  },
  {
    name: 'zen_connection_cancel', command: 'connection_cancel', title: '取消等待连接',
    description: 'Connection UI only: cancel this connection request while it waits for browser exit, window activation or first-run setup. Does not stop another MCP connection or undo completed actions.',
    inputSchema: schema({}), annotations: annotations(false), _meta: privateUi
  }
];

export function connectionResult(state) {
  const summary = { status: state.status, reason: state.reason, connected: state.status === 'connected', connectionId: state.connectionId || null,
    instruction: state.status === 'connected' ? 'The user can now request webpage tasks. Observe the exact target tab before acting.' : 'The user can use the Connect Zen page. Setup and restart confirmation happen there; do not run installation scripts or alter a profile yourself.' };
  return { content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: summary, _meta: { uiState: state } };
}

export async function invokeConnectionTool(name, args, manager) {
  const tool = CONNECTION_TOOLS.find(tool => tool.name === name);
  if (!tool) throw Object.assign(new Error('Unknown connection operation.'), { code: 'INVALID_COMMAND' });
  validate(tool.inputSchema, args);
  if (tool.command === 'connection') return connectionResult(await manager.state(args));
  if (tool.command === 'connection_plan') {
    const plan = await manager.plan(args);
    return { content: [{ type: 'text', text: JSON.stringify(plan.public) }], structuredContent: plan.public, _meta: { confirmationTicket: plan.token } };
  }
  if (tool.command === 'connection_apply') return connectionResult(await manager.apply(args.ticket));
  if (tool.command === 'connection_resume') return connectionResult(await manager.resume(args.ticket));
  return connectionResult(await manager.cancel());
}
import { validate } from './tools.mjs';
