# ReasonW6 Codex Skill Marketplace

一个面向 Codex 的个人插件市场，把以下两套开源 Skill 集合整理成两个可独立安装的插件：

- `gsap-skills`：来自 [GreenSock 官方 GSAP Skills](https://github.com/greensock/gsap-skills)，包含 8 个 GSAP 动画工程 Skill。
- `taste-skill-suite`：来自 [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)，包含 13 个前端与视觉设计 Skill。

本仓库只负责 Codex 插件化打包和分发。Skill 内容及版权归各自上游作者所有，详情见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 在 Codex 中添加市场

在 Codex 的集成终端或 PowerShell 中运行：

```powershell
codex plugin marketplace add ReasonW6/codex-skill-marketplace
```

确认市场已被识别：

```powershell
codex plugin marketplace list
```

然后重启 Codex 桌面应用，打开插件目录，在市场来源中选择 **ReasonW6 Plugins**，按需安装：

- **GSAP Skills**
- **Taste Skill Suite**

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
    └── taste-skill-suite/
        ├── .codex-plugin/plugin.json
        └── skills/
```

Codex 插件与市场格式参考 [OpenAI 官方文档](https://developers.openai.com/plugins/build/plugins)。
