---
name: tab-suggest
description: 管理与排查 Antigravity 对话框智能下一步补全插件（Tab Suggest，基于 Vertex AI DeepSeek V4.1 Flash 与 Google Cloud JSON 凭证，支持 Windows + WSL 双模式），导入/测试凭证或同步热更新组件。
---

# Tab Suggest Skill

用于管理、导入凭证、测试连通性与热更新 **Tab Suggest（对话框智能下一步补全）** 插件。

## 常用操作命令

### 1. 检查插件安装与服务状态
```powershell
node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs status
node "$HOME/.gemini/config/plugins/tab-suggest/scripts/suggest-service.mjs" status
```

### 2. 导入 Google Cloud Vertex AI JSON 凭证并实测连通性
用户既可在聊天输入框右下角的 **`Tab` 微图标浮窗** 中一键选择/粘贴 JSON 凭证文件并测试连接，也可通过命令行导入：
```powershell
node "$HOME/.gemini/config/plugins/tab-suggest/scripts/suggest-service.mjs" import-key "C:/path/to/service-account.json"
node "$HOME/.gemini/config/plugins/tab-suggest/scripts/suggest-service.mjs" test
```

### 3. 安装 / 同步双端与实时热更新
```powershell
node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs install
```
