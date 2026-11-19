---
name: quota-pill
description: 管理与排查 Antigravity 左下角 Codex 风格额度显示组件（Quota Pill，兼容 Windows 本地与 WSL 双模式），查询真实 RetrieveUserQuotaSummary / GetUserStatus 配额状态与同步双端插件。
---

# Quota Pill (左下角额度显示 · Windows & WSL 双模版)

本插件在 Antigravity 界面左下角展示类似 OpenAI Codex 的上下双圆弧额度按钮（上半环代表 Gemini 5 小时额度，下半环代表 Gemini 周额度），支持上下分区悬停黑色胶囊提示与点击展开完整多模型池额度卡片，且无缝兼容 **Windows 本地模式** 与 **WSL 2 模式**。

## 常用命令（Windows 与 WSL 通用）

- 安装并同步至 Windows + WSL 双端（含热注入）：
  - 工作区目录：`node .agents/plugins/quota-pill/installer/install-quota.mjs install`
  - 全局插件目录：`node "$HOME/.gemini/config/plugins/quota-pill/installer/install-quota.mjs" install`
- 检查 Windows / WSL 双端安装与桥接状态：
  - `node "$HOME/.gemini/config/plugins/quota-pill/installer/install-quota.mjs" status`
- 卸载并清理客户端注入与 WSL 副本：
  - `node "$HOME/.gemini/config/plugins/quota-pill/installer/install-quota.mjs" uninstall`
- 查询当前真实配额 JSON（支持 Windows PowerShell 与 WSL Linux 终端原生执行）：
  - `node "$HOME/.gemini/config/plugins/quota-pill/scripts/quota-fetcher.mjs"`
