# Context Donut (上下文甜甜圈 · Windows & WSL 双模版) — Antigravity 插件

像 OpenAI Codex 一样，在 Antigravity 对话输入框（Composer）下方工具栏右侧展示一个实时的 **SVG 甜甜圈（圆环进度图）+ 百分比**，直观呈现当前会话的上下文窗口占用情况，并同时兼容 **Windows 本地模式** 与 **WSL 2 模式**。

---

## 核心特性

1. **Windows + WSL 双模无缝兼容**
   - 切换为 WSL 模式后，Electron 主进程桥接层会自动识别当前激活的 WSL 发行版并通过 `\\wsl.localhost\<distro>\...` 优先读取 WSL 内的 `transcript.jsonl`；同时自动向所有 WSL 2 发行版的 `~/.gemini/config/plugins/context-donut` 同步插件副本（Hooks / Sidecar / Skills / Rules 在 WSL 模式下也可原生启动）。
2. **精确数据源（零估算误差）**
   直接解析 Antigravity 官方实时写入的会话日志 `transcript.jsonl` 中每个 `PLANNER_RESPONSE` 节点的精确统计：
   - `cache_read_tokens`（缓存命中上下文 Token，翠绿色圆弧）
   - `input_tokens`（本轮新增输入 Token，天蓝色圆弧）
   - `output_tokens`（模型输出 Token，紫色分段）
3. **100% 还原 Codex 视觉与交互**
   - 直接嵌入 `.agy-composer-footer` 底部工具栏右侧（发送/麦克风按钮旁），支持多窗格分屏独立识别各自会话的 `cascadeId`。
   - **三段式语义变色**：`< 60%` 正常翠绿、`60% ~ 85%` 琥珀色预警、`>= 85%` 红色高占用告警。
   - **悬停/点击详情浮窗**：展示已用/总上限 Token、缓存命中率、各分项明细，支持 **点击固定浮窗**。
4. **上限分母一键切换 (`512k` / `1M`)**
   - 默认以 **512k (`512,000` tokens)** 作为有效上下文参考上限，可在浮窗底部随时点击切换为 `1M`，设置自动持久化。
5. **一键 `/compact` 快捷操作**
   - 浮窗内置 `/compact` 按钮，点击即可一键复制 `/compact` 命令，方便在上下文高占用时快速压缩历史记录。
6. **双形态支持（底部工具栏内嵌 + 右侧 Sidecar 仪表盘）**
   - 除了对话框下方的 SVG 甜甜圈外，还提供完整的右侧副栏（Aux Pane）监控面板，展示最近 30 步的上下文增长柱状图。
7. **无冲突增量安装**
   - 安装脚本直接对 `app.asar` 的 `dist/main.js` 与 `dist/preload.js` 执行块标记增量注入与精确剥离，可与 `codex-theme`、`quota-pill`、`cowart-sidebar`、`task-timer` 等插件安全共存。

> 注：原集成于本插件的「每轮任务顶端总运行时长」能力现已剥离为独立插件 [`task-timer`](../task-timer/README.md)，可按需单独安装。

---

## 快速安装与管理（Windows 与 WSL 通用）

在终端中运行以下命令（或运行仓库根目录的 `manage.cmd` / 双击 `cmd/install-donut.cmd`）即可完成 Windows 与 WSL 双端插件同步、客户端启动挂载及当前运行窗口的实时热注入：

```powershell
# 一键安装并同步至 Windows + WSL 双端（实时热挂载到当前窗口）
node "$HOME/.gemini/config/plugins/context-donut/installer/install-donut.mjs" install

# 检查 Windows / WSL 双端挂载状态
node "$HOME/.gemini/config/plugins/context-donut/installer/install-donut.mjs" status

# 卸载并精确移除本插件钩子与 WSL 副本
node "$HOME/.gemini/config/plugins/context-donut/installer/install-donut.mjs" uninstall
```
