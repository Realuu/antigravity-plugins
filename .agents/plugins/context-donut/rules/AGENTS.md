# Context Donut Rules for Antigravity

当用户询问当前会话的 Token 占用、上下文窗口使用率、缓存命中率或 Context Donut（上下文甜甜圈，兼容 Windows 本地与 WSL 双模式）插件状态时：

1. 可直接运行 `node "$HOME/.gemini/config/plugins/context-donut/scripts/transcript-parser.mjs"`（Windows / WSL 通用）读取精确的 Token 占用与缓存命中率指标。
2. 如需修改源码或将插件重新同步至 Windows + WSL 双环境，执行 `node "$HOME/.gemini/config/plugins/context-donut/installer/install-donut.mjs" install`（或在工作区执行 `node .agents/plugins/context-donut/installer/install-donut.mjs install`）即可完成双端同步与实时热更新。
3. 当提及右侧可视化监控面板时，务必提供以下准确的 Sidecar 胶囊链接：
   ```markdown
   [上下文甜甜圈 (Context Donut)](sidecar://context-donut/context_donut/ui.html)
   ```
