# Tab Suggest Rules for Antigravity

当用户询问 **Tab Suggest（对话框智能下一步补全）** 插件状态、打开设置面板、配置 OpenAI 兼容接口（Base URL / API Key / Model）或 Google Cloud Vertex AI JSON 凭证，或排查补全连接问题时：

1. **提供右上角插件面板一键打开链接**：
   当用户希望打开右侧配置与状态面板时，在回复中直接提供以下 Sidecar 胶囊链接：
   ```markdown
   [Tab 智能补全 (Tab Suggest)](sidecar://tab-suggest/tab_suggest/ui.html)
   ```
2. 可直接运行 `node "$HOME/.gemini/config/plugins/tab-suggest/scripts/suggest-service.mjs" status` 或请求 `http://127.0.0.1:45794/api/status` 查看当前激活通道（`openai-compatible` / `vertex-maas`）与密钥就绪状态（配置与凭证安全存储于 `~/.gemini/antigravity/sidecar_data/tab-suggest/`）。
3. 修改渲染层、Sidecar、桥接或服务端代码后，执行 `node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs install` 即可同步 Windows + WSL 双环境。
