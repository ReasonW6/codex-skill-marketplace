# ReasonW6 Codex Skill Marketplace

一个面向 Codex 的个人插件市场，把以下三套开源 Skill 集合整理成三个可独立安装的插件：

- `gsap-skills`：来自 [GreenSock 官方 GSAP Skills](https://github.com/greensock/gsap-skills)，包含 8 个 GSAP 动画工程 Skill。
- `taste-skill-suite`：来自 [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)，包含 13 个前端与视觉设计 Skill。
- `mattpocock-engineering`：来自 [Matt Pocock Skills](https://github.com/mattpocock/skills)，包含 18 个稳定工程 Skill 和 1 个共享依赖。

本仓库只负责 Codex 插件化打包和分发。Skill 内容及版权归各自上游作者所有，详情见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

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

- `ask-matt`
- `grill-with-docs`
- `grilling`（共享依赖）
- `setup-matt-pocock-skills`
- `wayfinder`
- `to-spec`
- `to-tickets`
- `triage`
- `prototype`
- `research`
- `domain-modeling`
- `codebase-design`
- `improve-codebase-architecture`
- `tdd`
- `diagnosing-bugs`
- `implement`
- `code-review`
- `resolving-merge-conflicts`
- `wizard`

该插件按上游的稳定 `skills/engineering/` 分类完整打包，并补充这些流程共同调用的 `grilling`。未包含 `in-progress`、`deprecated`、`misc` 和无关的通用生产力 Skill。

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
    └── mattpocock-engineering/
        ├── .codex-plugin/plugin.json
        └── skills/
```

Codex 插件与市场格式参考 [OpenAI 官方文档](https://developers.openai.com/plugins/build/plugins)。
