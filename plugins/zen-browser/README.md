# Zen Browser Bridge for Codex

让 AI 在真实 Zen 标签页中工作，随时点进标签观看，或用暂停、继续、接管按钮交还控制。通过 **Firefox 扩展 + Windows 原生通信宿主 + 本地 MCP** 接入 Codex；后台操作保留现有登录会话，不发送系统鼠标键盘输入，不激活标签页或聚焦窗口。

当前版本为 `0.3.0`。新增 WebDriver BiDi 真实网页点击、键盘输入和拖动，配套启动器每次启动时自动加载扩展；观看、暂停、接管和重新观察规则同样适用于真实输入。标签组、状态图标、标题、页面边框和面板共同标识受控页面。**本项目不包含 Mozilla 签名流程**，也不更改签名校验。原生标签外观遵循 Zen 的样式；官方私有 `@Browser` 入口仍不可用。

![Zen 原生标签组与结果页](assets/zen-tab-state.png)

## 观看、暂停与接管

- **找到 AI 标签**：支持时创建单标签的 Zen 原生分组，名称和颜色跟随真实状态；同时显示 AI 状态图标和 `[AI·运行]` 等标题标记。页面边缘和面板跟随状态改变颜色。已有分组、固定标签和分屏标签保留原布局，使用图标、标题和页内提示标识。没有分组 API 时也使用这一替代方案，不修改全局主题。
- **观看**：点击 AI 标签、切换标签、页面变为可见或鼠标悬停不会交出控制。面板显示当前步骤，填写、点击、滚动和导航直接发生在真实网页上。目标框和页内虚拟指针跟随真实指令，完成后短暂保留反馈；系统鼠标不会移动。
- **暂停**：页内或扩展面板的暂停按钮立即使旧指令失效。停止确认期间显示“正在停止”，待执行工作停止后才允许继续。已经发生的网页动作保留原结果。
- **接管**：点接管，或开始实际点击、输入、拖动、粘贴、滚动网页内容，后续 AI 写入停止，用户输入照常到达网页。仅悬停、浏览器产生的焦点事件和插件自身编辑事件不触发接管。
- **继续**：点击继续后，AI 必须重新读取页面和用户修改，取得新的元素引用，再决定下一步。旧队列不重放；完成、发送、提交等操作不自动重试。插件提供等待继续的工具，但不会在 Codex 任务已经结束后自行唤醒模型。
- **完成**：AI 核对结果后明确报告完成，标签和结果页保留，显示绿色完成状态。面板可收起，收起后仍保留暂停和接管入口；操作目标与面板重叠时会调整面板位置。

| 显示 | 真实含义 |
| --- | --- |
| 等待观察 | 已连接或继续后，尚需重新观察页面 |
| 运行中 | 真实网页指令正在执行或等待指定内容 |
| 等待下一步 | 上一步已结束，等待 AI 的下一条指令 |
| 已暂停 / 你已接管 | 网页写入停止，需要用户选择继续 |
| 等待用户 | 需要用户处理，或连接中断、外部导航后等待确认 |
| 已完成 / 执行失败 | 已核对的任务完成，或实际指令/任务失败 |

## 能做什么

| 能力 | 行为 |
| --- | --- |
| 标签页 | 列出、创建后台标签、控制明确指定的标签、释放控制；支持可见观看 |
| 页面观察 | 可见文本、交互元素名称、元素引用、iframe 列表、open shadow DOM |
| 表单 | 普通输入、React 受控表单、textarea、contenteditable、select、复选框 |
| 交互 | 原生模式的可信点击、键盘输入、拖动；普通模式的 DOM 操作；页面和嵌套容器滚动 |
| 导航 | HTTP(S) 导航、后退、前进、刷新、等待指定内容 |
| 截图 | Firefox `tabs.captureTab` 截取非选中标签页，无需切换到该标签 |
| 登录状态 | 使用扩展所在的真实 Zen 配置与现有网页会话 |
| 并行使用 | 每条 MCP 连接单独拥有标签；按标签串行执行；一个标签等待用户不阻塞其他标签 |

现有容器标签页可以通过 `zen_attach` 使用。`zen_open` 不提供指定容器参数，也不索取读取全部 cookies 的权限。新建标签页默认静音；控制已有标签页不会改变其静音设置。

## 安装

需要 Windows 10/11、PowerShell 7、Node.js 22 或更新版本、Windows 自带的 .NET Framework 4.x，以及 Zen。扩展清单最低 Gecko 版本是 142；原生模式还需要浏览器支持 BiDi `webExtension.install` 和输入接口。本版实测 Zen 1.22b / Gecko 155，其他版本的原生模式尚未验证，详见 [验证记录](docs/VALIDATION.md)。

### 1. 在 Codex 安装插件

在 Codex 插件市场添加 `ReasonW6/codex-skill-marketplace`，选择 **Zen Browser**。已经添加市场时，刷新市场后再安装。命令行刷新方式：

```powershell
codex plugin marketplace upgrade reasonw6-plugins
```

插件通过 `.mcp.json` 的相对 `cwd` 启动 `node server/mcp.mjs`。日常使用不需要 `npm install`。

### 2. 注册本机宿主

从本仓库 `plugins/zen-browser` 或解压后的 `zen-browser` 目录运行：

```powershell
pwsh -NoProfile -File .\scripts\install-host.ps1
```

使用普通 Windows 用户运行，不需要管理员账户。脚本会把宿主复制到当前用户的 `%LOCALAPPDATA%\ReasonW6\ZenBrowser`，编译无窗口的原生启动器，并注册一个 HKCU Native Messaging 项。中文、空格和 `%` 安装路径经过实测。

每次安装生成独立版本目录和回滚收据，保留上次的文件与注册位置。安装目录限制为当前用户、SYSTEM 和管理员可访问。脚本拒绝覆盖不属于本插件的非空目录。

宿主复制在稳定位置，刷新 Codex 的插件缓存不会破坏它。启动器和扩展仍从解压目录读取，请把完整 ZIP 解压到固定位置并保留该目录。升级后重新运行安装脚本，再使用新目录中的启动器启动 Zen。

### 3. 选择配置并启用原生模式

在 Zen 的 `about:profiles` 确认需要使用的配置的**根目录**，然后正常退出该配置的所有窗口。脚本只接受已经存在、当前未运行的明确配置，不会结束浏览器进程或替你选择日常配置。

Firefox Remote Agent 默认会应用一组自动化偏好。为保留普通浏览器行为，原生模式要求事先关闭这组自动调整。先预览唯一的配置改动：

```powershell
pwsh -NoProfile -File .\scripts\configure-native-profile.ps1 -ProfilePath "C:\完整路径\Zen配置"
```

确认选择的配置后，显式应用：

```powershell
pwsh -NoProfile -File .\scripts\configure-native-profile.ps1 -ProfilePath "C:\完整路径\Zen配置" -Apply
```

脚本仅在所选配置的 `user.js` 追加 `remote.prefs.recommended=false`，保存原内容和回滚收据；不更改扩展签名策略、主题或网页数据。默认预览不写文件，启动器也不会代为修改配置。

### 4. 每次通过配套启动器打开 Zen

```powershell
pwsh -NoProfile -File .\scripts\start-zen.ps1 -ZenBinary "D:\Software\Zen Browser\zen.exe" -ProfilePath "C:\完整路径\Zen配置"
```

启动器使用这个原配置启动 Zen，打开仅本机回环地址的 BiDi 端口，核对浏览器进程与配置身份，再自动临时加载随包扩展。每次完全退出后仍通过此命令启动，便无需手动重新加载；同一配置中的登录状态保留。扩展面板和 `zen_status` 会显示原生模式是否可用。

**直接点击普通 Zen 图标不会执行自动加载。** GitHub Release 的 XPI 仍是未签名开发包，启动器利用浏览器公开的临时安装接口加载，没有把它变成永久安装扩展。浏览器可能显示远程控制提示，这是启用 BiDi 后的浏览器行为。

若只需要普通 DOM 模式，可以手动在 `about:debugging#/runtime/this-firefox` 中“临时载入附加组件”，选择 `extension/manifest.json`；不需要上面的配置步骤，但完全退出后需手动加载，真实输入和拖动不可用。

完成后在 Codex 开一个新任务，使用 Zen Browser 插件。若只想注册独立 MCP，不使用插件市场，可以把真实绝对路径填入：

```powershell
codex mcp add zen_browser -- node "D:\path\to\zen-browser\server\mcp.mjs"
```

## 操作流程

```text
zen_status → zen_tabs → zen_attach / zen_open
           → zen_snapshot → zen_fill / zen_click / ... → zen_snapshot
```

`zen_status` 返回连接 ID；同时有多个 Zen 配置连接时，后续调用必须指定 `connectionId`。标签页 ID 来自 `zen_tabs`，元素 `ref` 来自该 frame 最近一次 `zen_snapshot`。重新观察或页面导航后应使用新引用。

允许控制用户明确选定的可见 HTTP(S) 标签，观看不取消控制。私密窗口和浏览器内部页面仍被拒绝。不要为了控制网页而把用户切到其他标签或调用系统鼠标键盘。

暂停或接管后使用 `zen_wait_for_control` 等待用户选择继续；成功时返回包含用户修改的新 snapshot。导航后也要重新观察。`zen_task` 显式报告 `completed`、`failed` 或 `waiting_user`，页面不会把“暂时没有指令”误标为完成。

扩展面板的“暂停全部 AI 控制”会断开本机宿主。重新启用后连接 ID 会变化，重新连接并 `zen_attach` 原标签仍保留停止状态，用户点击继续后才能写入。刷新和同次浏览器会话内的扩展后台重建会恢复相符的状态；完整退出浏览器后不会恢复旧会话的控制权。`zen_close` 只允许关闭当前连接新建且仍在后台的一个标签，观看中的结果页保留。

## 工具

| 工具 | 用途 |
| --- | --- |
| `zen_status` | 连接状态、环境和能力边界 |
| `zen_tabs` | 当前标签清单 |
| `zen_open` / `zen_attach` / `zen_detach` | 新建、接管、释放 |
| `zen_snapshot` | 页面文本、元素引用与 frame IDs |
| `zen_click` / `zen_fill` / `zen_select` / `zen_check` | 网页元素操作 |
| `zen_press` / `zen_scroll` | 网页键盘语义与滚动 |
| `zen_drag` | 将已观察的元素拖到同 frame 的视口坐标，需要原生模式 |
| `zen_wait` / `zen_navigate` | 有条件等待与导航 |
| `zen_screenshot` | 后台标签截图，直接返回 MCP 图像 |
| `zen_close` | 关闭当前连接新建的后台标签 |
| `zen_control` | 暂停当前会话的网页操作；不提供绕过用户暂停的恢复接口 |
| `zen_wait_for_control` | 等待用户继续，并返回新页面观察结果 |
| `zen_task` | 明确显示完成、失败或等待用户，保留网页 |

完整参数由 MCP `tools/list` 提供。工具不会执行任意页面 JavaScript，也不提供系统命令、cookie 导出或本地文件读取接口。

`zen_click`、`zen_fill` 和 `zen_press` 的 `engine` 默认为 `auto`，原生模式可用时采用 BiDi；可明确选择 `native` 或 `dom`。超过 2000 字符、包含换行或控制字符的填写在执行前选择 DOM 字面替换，避免把换行当成 Enter 提交。明确指定 `native` 的这类输入会报错。原生动作已经开始后，失败不会自动降级、重试或重放。

## 明确的边界

- 原生模式已验证可触发只接受可信点击的测试控件，也能在后台输入中文和 Enter；这不保证所有用户激活 API、复杂编辑器或 Canvas 应用都兼容。普通 DOM 模式仍不能满足只接受可信输入的控件。
- 原生输入沿用同样的文档、控制代数和一次性许可，输入前逐步检查停止状态。拖动手势最长 300 ms；已经发给浏览器的一次手势可能在停止期间完成。暂停不是撤销已经发生的网页操作。
- 不控制地址栏、浏览器设置、原生弹窗、文件选择器，也不绕过验证码。closed shadow DOM 无法穿透。
- `<a target="_blank">`、下载链接和会打开其他窗口的表单会返回明确错误。用 `zen_open` 打开已观察到的普通网页链接。
- 网站自己的脚本、系统弹窗和其他扩展可能有独立行为。本插件不提供对任意网站的系统焦点绝对保证；实测覆盖与未验证项见 [验证记录](docs/VALIDATION.md)。
- 网页、标题、URL 和截图是任务数据，不是对 Codex 的指令。附带技能要求操作前观察、操作后回读，且不把接管标签页当作提交交易或发送消息的授权。
- 超时可能发生在网页已经执行、回包尚未到达的时候。应先观察结果，再决定是否重试写入。

## 故障检查与回滚

```powershell
pwsh -NoProfile -File .\scripts\doctor.ps1
```

常见情况：

- `NOT_CONNECTED`：检查 Node 是否在 PATH、本机宿主是否注册、Zen 临时扩展是否仍加载。
- `NOT_ATTACHED`：尚未控制该标签或连接身份已变化；核对目标后连接。重新连接不会解除用户的暂停。
- `CONTROL_STOPPED` / `CONTROL_CHANGED`：已暂停、接管或旧指令失效；等待用户继续，不重放旧指令。
- `OBSERVATION_REQUIRED` / `NAVIGATION_CHANGED`：页面或控制状态已变化，读取新 snapshot 后重新判断。
- `PAGE_LOADING`：等待页面完成导航，然后重新观察。
- `PROFILE_SETUP_REQUIRED`：先检查指定配置，再使用配置脚本预览及明确应用；启动器没有修改配置。
- `NATIVE_UNAVAILABLE`：没有通过启动器启动，或扩展仍在加载。普通 DOM 模式可以独立使用。
- `NATIVE_SESSION_BUSY`：异常中断后浏览器保留了旧调试会话；正常关闭该配置后用启动器重新打开，不重试旧动作。
- `INPUT_PROBE_UNAVAILABLE`：原生键盘来源检测程序不可用，重新安装宿主；不把无法判断的键盘输入当作成功。
- `STALE_REF`：获取新的 snapshot。
- `BROWSER_ERROR` / host permission：页面可能是 Firefox 限制页面、正在跳转，或网站访问权限被关闭。
- 多个配置：从 `zen_status` 选择明确的 `connectionId`。

安装脚本输出具体回滚收据路径。回滚注册时使用该路径：

```powershell
pwsh -NoProfile -File .\scripts\unregister-host.ps1 -Receipt "完整的 install-时间戳.json 路径"
```

脚本只恢复这次安装的 Native Messaging 注册，保留宿主文件、收据和所有浏览器数据。它不会递归删除目录。扩展可以在 Zen 附加组件管理中单独移除，Codex 插件也可以独立停用。

回滚原生模式的单项偏好时，先正常退出该配置，再使用配置脚本输出的收据：

```powershell
pwsh -NoProfile -File .\scripts\configure-native-profile.ps1 -ProfilePath "C:\完整路径\Zen配置" -RestoreReceipt "完整的 zen-native-setup-时间戳.json 路径" -Apply
```

脚本按字节恢复原 `user.js`，并恢复 `prefs.js` 中这一个偏好的原值，保留其他后续设置。若原本没有 `user.js`，留下空文件；若该文件在设置后被修改，脚本拒绝覆盖。

## 开发与复现测试

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm audit
$env:ZEN_BINARY = 'D:\Software\Zen Browser\zen.exe'
npm run test:zen
npm run test:native
npm run package
```

实机测试需要 PowerShell 7。`ZEN_BINARY` 必须是实际 Zen；测试创建全新的配置，不读取或修改日常配置。测试期间只注册 `io.github.reasonw6.zen_browser_test`，结束后恢复原值。测试证据保存在 `.artifacts/`，不加入 Git。

需要带窗口测试时设置 `ZEN_HEADED=1`。若要求 Windows 系统焦点采样必须可用，再设置 `ZEN_REQUIRE_FOREGROUND=1`；空窗口句柄必须报告未验证，不能算通过。两套实机测试共用专用测试宿主注册，必须顺序运行。

Mozilla 的扩展校验可单独执行：

```powershell
npm exec --yes --package=web-ext@10.6.0 -- web-ext lint --source-dir extension
```

`web-ext` 是外部校验工具，未放入插件运行时或开发依赖锁文件。项目仅为 React 集成测试锁定 `react`、`react-dom` 和 `esbuild`。构建产生可重复的 ZIP/XPI 及 `SHA256SUMS.txt`，不会自动发布或签名。

## 实现与数据

见 [架构与权限说明](docs/ARCHITECTURE.md)。MCP 与 Windows 宿主通过随机命名的本机管道和按用户保护的凭据通信。原生模式额外启用 Zen 的回环调试端口，调试接口具备浏览器级权限，本机其他进程可能访问它；没有绑定外部网卡。键盘来源辅助程序只提供事件次数和时间，不记录或传输按键内容。扩展返回的网页信息进入调用它的 Codex 任务；本项目没有独立云服务和遥测。不要把“本地桥接”误解成 Codex 本身完全离线。

本插件按 [MIT License](LICENSE) 分发，与 OpenAI、Mozilla、Zen 官方没有隶属关系。
