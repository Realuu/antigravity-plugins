# Quota Pill Rules for Antigravity

当用户询问 Antigravity 账号剩余额度、模型池重置时间或左下角 Quota Pill 插件状态时（兼容 Windows 本地模式与 WSL 模式）：

1. 可直接运行 `node ~/.gemini/config/plugins/quota-pill/scripts/quota-fetcher.mjs`（Windows PowerShell 下为 `node "$HOME/.gemini/config/plugins/quota-pill/scripts/quota-fetcher.mjs"`）或请求 `http://127.0.0.1:45790/api/quota` 获取精确的实时配额快照。
2. 修改渲染、桥接代码或需要将插件同步到 Windows + WSL 双环境时，执行 `node ~/.gemini/config/plugins/quota-pill/installer/install-quota.mjs install`（或在工作区执行 `node .agents/plugins/quota-pill/installer/install-quota.mjs install`）即可完成双端同步并热刷新当前窗口。
