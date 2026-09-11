# 开发、构建与复现

这些命令用于维护与验收，用户安装流程见 [README](../README.md)。0.4 的连接页负责准备运行时、注册宿主、配置、启动、重试和回滚。

## 构建和离线组件

Windows 助手的源码为 `scripts/NativeLauncher.cs`、`scripts/PhysicalInputProbe.cs`、`scripts/ZenPlatform.cs`。维护者使用 Windows 自带的 .NET Framework 编译器构建，终端用户使用随包的 `bin/*.exe`。

```powershell
pwsh -NoProfile -File scripts/build-windows.ps1
npm ci --ignore-scripts
npm run check
npm test
npm audit --audit-level=moderate
npm run package
python -m zipfile -t dist/zen-browser-0.4.0.zip
```

`bin/manifest.json` 记录每个助手和对应源码的 SHA-256；源文件使用 LF，CI 会拒绝源码与产物清单不符的包。`runtime/manifest.json` 记录固定版本的官方 Node ZIP、可执行文件和许可证哈希。需要重新取得同一运行时时，维护者运行 `python scripts/vendor-node.py`；连接流程不下载或编译程序。安装时再次校验随包 Node 与助手，安装收据记录稳定目录中全部文件的哈希。

ZIP/XPI 使用固定时间戳和 Node 内置 deflate。相同输入字节可生成相同包；输出有 `SHA256SUMS.txt`。构建脚本不发布、不做 Mozilla 或 Windows 签名。

## 真实浏览器验收

需要交互式 Windows 桌面、已安装的 Zen、当前 Windows 用户和维护者的 Node/PowerShell。不要从专用 CodexSandbox 账户注册或启动宿主。三套测试共用 `io.github.reasonw6.zen_browser_test`，必须顺序运行。

```powershell
$env:ZEN_BINARY = 'D:\Software\Zen Browser\zen.exe'
$env:ZEN_HEADED = '1'
$env:ZEN_REQUIRE_FOREGROUND = '1'
npm run test:zen
npm run test:native
$env:CODEX_TEST_BINARY = 'C:\absolute\path\to\codex.exe'
$env:ZEN_CONNECTION_MODE = 'existing'
node tests/connection-e2e.mjs
$env:ZEN_CONNECTION_UI = 'local'
node tests/connection-e2e.mjs
```

每次创建独立配置和证据目录 `.artifacts/`，不修改日常配置。测试宿主的注册必须按收据恢复，保留证据和浏览器数据，不做宽泛删除。

- `zen-e2e.mjs` 验证原有 DOM 操作与控制规则。Marionette 只用于布置测试、注入用户操作、读取界面证据；不是产品控制接口。
- `zen-native-e2e.mjs` 验证实际 MCP → 扩展 → Native Messaging → BiDi 路径。测试专用宿主共享同一 BiDi 会话读取证据；测试副本仅增加选标签和正常关闭测试窗口入口。
- `connection-e2e.mjs` 创建独立 Codex 主目录和插件市场，通过实际 Codex CLI 安装随包插件，再使用真实 app-server 与 MCP App HTML 执行连接。UI 由独立 Marionette 浏览器容器呈现，不等同于已自动点击 Codex 桌面外壳。MCP 的 PATH 限制为 Windows System32，验证无需全局 Node 或 PowerShell 7。

`existing` 模式先用独立配置准备已完成 Zen 首次使用的状态、普通标签和 HttpOnly 测试会话，再完全退出并移除测试调试设置。首次插件连接前没有桥接扩展、原生宿主或远程控制通道，不能把“浏览器本身刚安装、从未运行”与这个场景混为一谈。`fresh` 是需要操作人员完成 Zen 自身引导的单独场景。

部分 Zen 启动必须激活实际窗口才能完成 BiDi 握手。测试打印 `OPERATOR_STARTUP` 时，操作人员核对输出中的测试配置、进程和窗口，再激活该窗口，将实际动作记录到指定 `operator-startup-N.json`。界面测试随后点击继续；记录必须说明是人工还是 Computer Use 模拟，不能伪称自动启动。该记录文件仅属于测试设施，产品用户只操作连接页和 Zen 窗口。

`ZEN_CONNECTION_UI=local` 显式关闭隔离 Codex 的 MCP Apps 特性与客户端能力声明，通过 MCP 返回的真实本地页面执行整条流程。它使用产品自身的本地 HTTP 页面，不使用测试的 MCP App 容器转发。每次 Codex 重启后重新取得有效页面链接；不更改用户的 Codex 设置。

测试版 `0.4.1` 只用于升级路径，源码发布版本仍为 `0.4.0`。组件损坏测试只修改隔离安装副本。多配置测试只更改测试 profiles.ini。

```powershell
npm exec --yes --package=web-ext@10.6.0 -- web-ext lint --source-dir extension
```

`web-ext` 是外部校验工具，不属于产品运行依赖。Windows/Linux CI 验证协议、源码、依赖和包完整性；不能替代上述有窗口的浏览器验收。

## 平台依据和桌面环境

`.mcp.json` 使用 Codex 已实现的相对命令 `./runtime/node.exe` 和 `cwd: .`。连接页使用 MCP Apps 的 UI 资源、app-only 工具与私有 `_meta`；全局、设置和任务入口依据当前 Codex 桌面代码核实。客户端未声明 MCP Apps 时，工具提供同一界面的本地页面链接，不承诺存在内嵌按钮，也不代改 Codex 配置。

Windows 打包应用可能让子进程与正常桌面具有不同的 HKCU 注册表视图。`server/windows.mjs` 通过一次性随机命名管道，与 Explorer 激活的同一份 `zen-platform.exe` 通信。检测不创建请求文件，不改变应用注册表虚拟化策略；注册、校验、回滚和 Zen 均使用浏览器实际所在的桌面环境。助手拒绝专用沙盒账户，不使用管理员权限、令牌切换或 Job breakaway。

实际 Codex MCP 子进程树属于关闭时终止的 Windows Job。Zen 由桌面激活的助手启动，因此 Codex 结束时只断开控制客户端，浏览器保持运行。启动记录位于受当前用户保护的稳定目录中，浏览器和宿主通过该记录验证身份。

## 旧版脚本与收据

`install-host.ps1`、`configure-native-profile.ps1`、`start-zen.ps1`、`doctor.ps1`、`unregister-host.ps1` 保留用于旧版兼容、维护和原有测试，不是 0.4 用户安装步骤。旧脚本的默认目录是 `%LOCALAPPDATA%\ReasonW6\ZenBrowser`，与 0.4 的 `%USERPROFILE%\.zen-browser` 不同。诊断时必须区分实际宿主注册所在的进程视图，不能在虚拟化视图中看到一个值就推断 Zen 看到了它。

旧版脚本创建的收据继续由对应旧版脚本恢复，必须先核对目标和完整收据路径。0.4 连接页仅恢复自己记录的改动；原本已存在的偏好不冒充本版新增设置。不要直接删除安装目录来代替回滚注册，也不要覆盖已由其他安装更改的值。
