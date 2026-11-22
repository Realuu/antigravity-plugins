# Tab Suggest（对话框智能下一步补全）

当 Antigravity 每轮任务结束后，自动在后台预测你接下来最可能发送的下一句指令，并在空白聊天输入框内以纯净代码补全式的 **半透明幽灵灰字（Ghost Text）** 呈现：

- **双通道兼容**：支持 **常见 OpenAI 兼容格式**（OpenAI 官方、DeepSeek、OpenRouter、硅基流动、智谱/火山/百炼、OneAPI/NewAPI 中转站、本地 Ollama / LM Studio 等）与 **Google Cloud Vertex AI**（Service Account / ADC JSON 凭证）一键切换；
- 按 **`Tab`** 键：一键将建议填入输入框并将光标移至末尾，可直接回车发送或微调后再发；
- 按 **`Esc`** 键或直接打字：幽灵补全立即无感消失，绝不覆盖已有草稿或干扰中文输入法选词；
- **管理与配置入口**：位于右上角辅助面板菜单 **「插件 → Tab 智能补全 (Tab Suggest)」**。

---

## 配置模型接口与密钥

密钥与 JSON 凭证均安全隔离存储在 `~/.gemini/antigravity/sidecar_data/tab-suggest/`，不会进入代码仓库。

### 通道一：OpenAI 兼容接口
1. 点击窗口右上角面板菜单 → **「插件 → Tab 智能补全 (Tab Suggest)」**，切换到 **「OpenAI 兼容」**；
2. 填写 **接口地址 (`Base URL`)**、**`API Key`**（本地 `127.0.0.1` / `localhost` 服务如 Ollama 可留空）与 **模型名称 (`Model`)**；
   - 填写根地址（如 `https://api.openai.com`、`https://api.deepseek.com`）会自动补全 `/v1/chat/completions`；
   - 已带版本路径（如 `/v1`、`/api/paas/v4`、`/api/v3`、`/v1beta/openai`）会自动补全 `/chat/completions`；
   - 末尾加 `#` 可跳过自动补 `/v1`；
3. 点击 **「保存并测试连接」** 即可验证延迟并启用。

命令行快捷配置：
```powershell
node .agents/plugins/tab-suggest/scripts/suggest-service.mjs set-openai "https://api.deepseek.com/v1" "deepseek-chat" "sk-xxx"
node .agents/plugins/tab-suggest/scripts/suggest-service.mjs test
```

### 通道二：Google Cloud Vertex AI
1. 在右上角插件面板切换到 **「Vertex AI」**，点击 **「选择 .json 文件」**（或粘贴 JSON 凭证内容）；
2. 自动识别 `Project ID`，默认使用 `global` 区域与 `deepseek-ai/deepseek-v4.1-flash-maas`，点击 **「保存并测试连接」** 即可。

命令行快捷导入：
```powershell
node .agents/plugins/tab-suggest/scripts/suggest-service.mjs import-key "C:\path\to\your-vertex-sa.json"
node .agents/plugins/tab-suggest/scripts/suggest-service.mjs test
```

---

## 安装 / 状态 / 卸载

```powershell
# 安装并同步双端
node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs install

# 检查运行与凭证状态
node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs status

# 卸载并恢复
node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs uninstall
```
