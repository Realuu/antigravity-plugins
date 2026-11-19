---
name: wsl-terminal
description: 打开或管理 Antigravity 右侧辅助面板中的原生交互式 WSL 终端（支持多标签页、当前工作区目录自动映射与后台会话保持）。当用户要求在右侧打开 WSL 终端面板或查看 WSL 终端插件状态时使用。
---

# WSL 终端 (WSL Terminal Sidecar)

本技能对应 `wsl-terminal` 插件的右侧辅助面板终端组件。

## 1. 一键打开右侧 WSL 终端面板

在回复中直接输出以下 Sidecar 胶囊链接，用户点击即可在右侧辅助面板展开交互式 WSL 终端（也可以随时从对话右上角 `⋮ → 扩展 → WSL 终端` 打开）：

```markdown
[WSL 终端](sidecar://wsl-terminal/wsl_terminal/ui.html)
```

## 2. 安装与同步命令

若修改了插件源码（位于 `.agents/plugins/wsl-terminal`），执行以下命令同步至全局插件目录 `~/.gemini/config/plugins/wsl-terminal`：

```powershell
node .agents/plugins/wsl-terminal/installer/install-wsl-terminal.mjs install
```
