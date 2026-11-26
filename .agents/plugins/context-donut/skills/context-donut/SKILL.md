---
name: context-donut
description: 管理与查看 Codex 风格上下文甜甜圈（Context Donut，兼容 Windows 本地与 WSL 双模式），支持打开右侧实时监控 Sidecar 面板。
---

# Context Donut (上下文甜甜圈 · Windows & WSL 双模版)

当用户需要查询当前会话的上下文 Token 占用、打开实时监控 Sidecar 面板，或者安装/更新/卸载上下文甜甜圈（无缝兼容 **Windows 本地模式** 与 **WSL 2 模式**）时使用本技能。

## 1. 一键打开右侧 Sidecar 监控面板
在回复中附上以下 Sidecar 胶囊链接，用户点击即可在右侧辅助面板展开或切换实时监控台：

```markdown
[上下文甜甜圈 (Context Donut)](sidecar://context-donut/context_donut/ui.html)
```

## 2. 安装、迁移到 WSL 或状态检查（Windows 与 WSL 通用）
- 安装并自动同步至 Windows 与所有 WSL 2 发行版全局目录（含增量注入与当前窗口热加载）：
  - 工作区目录：`node .agents/plugins/context-donut/installer/install-donut.mjs install`
  - 全局插件目录：`node "$HOME/.gemini/config/plugins/context-donut/installer/install-donut.mjs" install`
- 检查 Windows / WSL 双端安装与 `app.asar` 挂载状态：
  - `node "$HOME/.gemini/config/plugins/context-donut/installer/install-donut.mjs" status`
- 卸载并精确移除本插件钩子与 WSL 副本（保留其他插件完整不变）：
  - `node "$HOME/.gemini/config/plugins/context-donut/installer/install-donut.mjs" uninstall`
- 直接查询当前或指定会话的精确 Token 占用 JSON（支持 Windows 与 WSL 原生运行）：
  - `node "$HOME/.gemini/config/plugins/context-donut/scripts/transcript-parser.mjs" [conversationId]`
