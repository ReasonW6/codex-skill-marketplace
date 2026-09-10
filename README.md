# ReasonW6 Codex Skill Marketplace

一个面向 Codex 的个人插件市场，提供可以独立安装的 Skill 集合与本地工具插件：

- `gsap-skills`：来自 [GreenSock 官方 GSAP Skills](https://github.com/greensock/gsap-skills)，包含 8 个 GSAP 动画工程 Skill。
- `taste-skill-suite`：来自 [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)，包含 13 个前端与视觉设计 Skill。
- `mattpocock-engineering`：来自 [Matt Pocock Skills](https://github.com/mattpocock/skills)，包含 9 个工程 Skill 和 `grilling` 工作流。
- `zen-browser`：本仓库开发的 [Zen Browser Bridge](plugins/zen-browser/README.md)，在真实 Zen 标签页中后台读取、填表、点击、导航和截图；支持原生标签标记、点进观看，以及暂停、继续、接管和完成状态。

上游 Skill 内容及版权归各自作者所有，详情见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。`zen-browser` 为独立开发的 MIT 插件，其安装步骤、已验证能力和限制见插件目录。

## 在 Codex 桌面端添加市场（推荐）

打开 Codex 的插件目录，点击 **添加插件市场**，然后填写：

| 输入框 | 填写内容 |
| --- | --- |
| 来源 | `ReasonW6/codex-skill-marketplace` |
| Git 引用 | `main` |
| 稀疏路径 | **留空，不要填写** |

也可以在“来源”中填写完整 Git URL：

```text
https://github.com/ReasonW6/codex-skill-marketplace.git
```

> “稀疏路径”输入框里的 `plugins/codex` 只是 Codex 界面的占位示例，不是本市场的路径。这个仓库同时需要 `.agents/plugins/marketplace.json` 和 `plugins/` 目录，因此最简单可靠的方式是留空，让 Codex 获取完整仓库。

点击 **添加市场**，然后重启 Codex 桌面应用。再次打开插件目录，在市场来源中选择 **ReasonW6 Plugins**，按需安装：

- **GSAP Skills**
- **Taste Skill Suite**
- **Matt Pocock Engineering**
- **Zen Browser**（需同时安装配套 Zen 扩展和本机宿主，当前 XPI 为未签名开发包）

## 使用命令行添加（备用）

如果更习惯终端，可以在 Codex 的集成终端或 PowerShell 中运行：

```powershell
codex plugin marketplace add ReasonW6/codex-skill-marketplace
```

确认市场已被识别：

```powershell
codex plugin marketplace list
```

然后重启 Codex 桌面应用，在插件目录中选择 **ReasonW6 Plugins**。

如果 GitHub 简写不可用，也可以使用完整地址：

```powershell
codex plugin marketplace add https://github.com/ReasonW6/codex-skill-marketplace.git
```

## 更新市场

仓库更新后，刷新这个市场：

```powershell
codex plugin marketplace upgrade reasonw6-plugins
```

随后重启 Codex。若插件详情页显示有更新，请重新安装或更新对应插件。

## 移除市场

```powershell
codex plugin marketplace remove reasonw6-plugins
```

## 插件内容

### GSAP Skills

- `gsap-core`
- `gsap-timeline`
- `gsap-scrolltrigger`
- `gsap-plugins`
- `gsap-utils`
- `gsap-react`
- `gsap-performance`
- `gsap-frameworks`

### Taste Skill Suite

- `taste-skill`
- `taste-skill-v1`
- `gpt-tasteskill`
- `image-to-code-skill`
- `redesign-skill`
- `soft-skill`
- `output-skill`
- `minimalist-skill`
- `brutalist-skill`
- `stitch-skill`
- `imagegen-frontend-web`
- `imagegen-frontend-mobile`
- `brandkit`

### Matt Pocock Engineering

- `grilling`
- `prototype`
- `research`
- `domain-modeling`
- `codebase-design`
- `tdd`
- `diagnosing-bugs`
- `code-review`
- `resolving-merge-conflicts`
- `wizard`

该插件打包上游 9 个不需要修改调用元数据的工程 Skill，并保留 `grilling` 工作流。未包含另外 9 个需要兼容性改动的工程 Skill，以及 `in-progress`、`deprecated`、`misc` 和其他通用生产力 Skill。

### Zen Browser Bridge

后台操作真实 Zen 标签页，用户点进标签可以继续观看，实际输入或点击接管才停止 AI。0.3.0 新增 BiDi 可信点击、键盘输入、拖动，以及每次启动自动加载未签名扩展的配套启动器；不包含 Mozilla 签名流程。支持普通及 React 表单、iframe、open shadow DOM、后台截图和状态标识。它是独立 MCP 接入，官方私有 `@Browser` 入口仍不可用。原生模式需要明确选择配置并完成单项可回滚设置，详见 [安装说明](plugins/zen-browser/README.md)和[验证记录](plugins/zen-browser/docs/VALIDATION.md)。

## 避免重复加载

如果这些 Skill 已经单独安装在 `~/.codex/skills/`，建议先确认插件版本运行正常，再把重复的独立 Skill 移到备份目录。不要同时保留两个来源的同名 Skill，以免触发规则重复或来源难以判断。

## 目录结构

```text
.
├── .agents/plugins/marketplace.json
└── plugins/
    ├── gsap-skills/
    │   ├── .codex-plugin/plugin.json
    │   └── skills/
    ├── taste-skill-suite/
    │   ├── .codex-plugin/plugin.json
    │   └── skills/
    ├── mattpocock-engineering/
    │   ├── .codex-plugin/plugin.json
    │   └── skills/
    └── zen-browser/
        ├── .codex-plugin/plugin.json
        ├── .mcp.json
        ├── extension/
        ├── server/
        ├── scripts/
        └── skills/zen-browser/
```

Codex 插件与市场格式参考 [OpenAI 官方文档](https://developers.openai.com/plugins/build/plugins)。
