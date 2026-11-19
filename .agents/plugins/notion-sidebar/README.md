# Antigravity Notion 独立侧栏入口 (`notion-sidebar`)

为 Antigravity 左侧任务栏挂载独立的 **Notion** 入口，还原 Codex 风格的 Notion 工作台与笔记悬浮提问体验。

## 核心能力
- **左侧独立 Notion 入口**：在左侧任务栏（「Cowart」正下方；未装 Cowart 时位于「自动化」正下方）挂载带 Notion 图标的独立入口，并与 `cowart-sidebar` 自动互斥切换。
- **官方 Notion OAuth 一键直连**：本地舞台服务（`127.0.0.1:45793`）基于标准 OAuth 2.1 PKCE + 动态客户端注册（RFC 7591）直连官方 Notion Hosted MCP（`https://mcp.notion.com/mcp`），一次浏览器授权即可访问整个工作区，无需手动创建 Integration Token。
- **工作台首页**：展示工作区标识、时段问候语、搜索框（支持关键词检索与粘贴 Notion 链接直达）、`新建页面` 按钮以及 `最近访问的页面` 卡片列表与 `查看全部`（最近 / 私人 / 收藏 / 共享）。
- **笔记阅读与轻量编辑**：支持面包屑导航、子页面钻取、代码块语法高亮与一键复制、勾选待办事项即时同步、行内编辑标题/段落/代码块、底部按 `/` 插入常用区块以及 Markdown 源码编辑写回。
- **底部悬浮提问 + 自动左右分栏 + 专属 Notion 项目隔离**：打开任意笔记后，底部居中浮现可收起、可自由拖拽的悬浮提问胶囊（支持模型切换、快捷提问模板与划选笔记正文自动引用）；发送问题后自动切换至专属的 **`Notion`** Antigravity 项目（默认目录 `Documents/Notion`）并展开「左侧 Notion 笔记 + 右侧可拖拽调宽的原生 Antigravity 聊天栏」，同时自动注入当前页面上下文，避免与代码开发项目会话混杂。

## 安装与卸载
```bash
node .agents/plugins/notion-sidebar/installer/install-notion.mjs install
node .agents/plugins/notion-sidebar/installer/install-notion.mjs status
node .agents/plugins/notion-sidebar/installer/install-notion.mjs uninstall
```
也可直接运行仓库根目录的 `manage.cmd`，或双击 `cmd/install-notion.cmd` / `cmd/uninstall-notion.cmd`。
