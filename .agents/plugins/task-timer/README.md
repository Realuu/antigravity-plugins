# Task Timer (任务总运行时长) — Antigravity 插件

在 Antigravity 每轮对话任务的顶端展示一个轻量胶囊计时条，实时读秒并定格记录整轮任务的总运行时长，弥补原生界面仅展示单步思考耗时（`Thought for Xs`）或被切碎的局部工具耗时（`Worked for ...`）的不足。

---

## 核心特性

1. **每轮任务顶端常驻显示**
   - **标准对话流模式**：挂载于 `[data-testid="user-message"]` 内部吸顶背景层底端（用户提问卡片正下方、回复区最顶端），向下滚动浏览长内容时随提问框一起吸顶常驻可见。
   - **气泡模式 / 隐藏用户步**：自动挂载于对应轮次 `[data-testid="agent-response"]` 的最顶端首行。
2. **运行中实时读秒 + 完成后精准定格**
   - **运行中**：每 500ms 同步一次，显示柔和脉冲圆点与 `运行中 · Xs` / `运行中 · Xm XXs`。
   - **完成后**：切换为时钟图标，按**纯首尾挂钟差值**（从用户发送消息到整轮最后一步结束）定格展示 `总耗时 <1s` / `总耗时 X.Xs` / `总耗时 Xm XXs`。
   - **悬停明细**：鼠标悬停胶囊可通过原生提示查看 `开始 HH:mm:ss · 结束/进行中 · N 步`。
3. **零端口、零磁盘轮询、全模式兼容**
   - 直接读取前端 React Fiber 中的 Turn `steps`、`isRunning` 与 `status`，无需后台端口、不改 `preload.js`，自动适配浅色/深色主题（含 `codex-theme`），且在 Windows 本地与 WSL 2 会话下均可直接使用。
4. **独立无冲突增量安装**
   - 仅对 `app.asar` 的 `dist/main.js` 执行独立块标记增量注入与精确剥离，可单独安装/卸载，与 `context-donut`、`codex-theme`、`quota-pill` 等其他插件完全解耦共存。

---

## 快速安装与管理

双击根目录 `manage.cmd`（选择 `8`）或 `cmd/install-task-timer.cmd`，也可在终端中直接执行：

```powershell
# 一键安装并热注入当前窗口
node .agents/plugins/task-timer/installer/install-task-timer.mjs install

# 检查插件与 ASAR 注入状态
node .agents/plugins/task-timer/installer/install-task-timer.mjs status

# 精确卸载并清理窗口组件
node .agents/plugins/task-timer/installer/install-task-timer.mjs uninstall
```
