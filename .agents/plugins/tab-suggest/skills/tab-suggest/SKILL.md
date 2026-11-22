---
name: tab-suggest
description: 管理与排查 Antigravity 对话框智能下一步补全插件（Tab Suggest，兼容常见 OpenAI 格式接口与 Google Cloud Vertex AI 双通道，支持 Windows + WSL 双模式），配置/测试接口或同步热更新组件。
---

# Tab Suggest Skill

用于管理、配置通道密钥、测试连通性与热更新 **Tab Suggest（对话框智能下一步补全）** 插件。

## 常用操作命令

### 1. 检查插件安装与服务状态
```powershell
node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs status
node "$HOME/.gemini/config/plugins/tab-suggest/scripts/suggest-service.mjs" status
```

### 2. 配置 OpenAI 兼容接口或 Vertex AI 凭证并测试连通性
用户可在右上角 **「插件 → Tab 智能补全 (Tab Suggest)」** Sidecar 面板中一键切换 **OpenAI 兼容 / Vertex AI** 并测试连接，也可通过命令行配置：
```powershell
# 配置 OpenAI 兼容通道（本地 Ollama 等可省略第三个 apiKey 参数）
node "$HOME/.gemini/config/plugins/tab-suggest/scripts/suggest-service.mjs" set-openai "https://api.deepseek.com/v1" "deepseek-chat" "sk-xxx"

# 或导入 Google Cloud Vertex AI JSON 凭证
node "$HOME/.gemini/config/plugins/tab-suggest/scripts/suggest-service.mjs" import-key "C:/path/to/service-account.json"

# 测试当前激活通道的补全生成
node "$HOME/.gemini/config/plugins/tab-suggest/scripts/suggest-service.mjs" test
```

### 3. 安装 / 同步双端与实时热更新
```powershell
node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs install
```
