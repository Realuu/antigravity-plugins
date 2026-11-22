# Tab Suggest（对话框智能下一步补全）

当 Antigravity 每轮任务结束后，基于 **Google Cloud Vertex AI** 上的 **`deepseek-ai/deepseek-v4.1-flash-maas`** 自动在后台预测你接下来最可能发送的下一句指令，并在空白聊天输入框内以纯净代码补全式的 **半透明幽灵灰字（Ghost Text）** 呈现：

- 按 **`Tab`** 键：一键将建议填入输入框并将光标移至末尾，可直接回车发送或微调后再发；
- 按 **`Esc`** 键或直接打字：幽灵补全立即无感消失，绝不覆盖已有草稿或干扰中文输入法选词；
- **管理与配置入口**：位于右上角辅助面板菜单 **「插件 → Tab 智能补全 (Tab Suggest)」**。

---

## 配置 Google Cloud JSON 凭证

支持两种方式导入你的 Service Account / ADC JSON 凭证（密钥安全隔离存储在 `~/.gemini/antigravity/sidecar_data/tab-suggest/vertex-credentials.json`，不会进入代码仓库）：

### 方式一：右上角「插件」Sidecar 面板导入（推荐）
1. 点击窗口右上角面板菜单 → **「插件 → Tab 智能补全 (Tab Suggest)」**；
2. 点击 **「选择 .json 文件」**（或直接粘贴 JSON 凭证内容），自动识别 `Project ID` 并默认使用 `global` 区域与 `deepseek-ai/deepseek-v4.1-flash-maas`；
3. 点击 **「保存并测试连接」** 即可查看实时延迟与最近会话补全状态。

### 方式二：命令行导入与测试
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
