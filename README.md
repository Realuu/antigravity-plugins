# Antigravity Plugins

面向 **Google Antigravity** 桌面客户端（Windows / Windows + WSL 2）的一组增强插件合集，涵盖 Codex 风格界面主题、实时上下文占用监控、模型额度展示、独立画布/笔记侧栏入口与内置交互式 WSL 终端。

所有插件均按 Antigravity 标准插件目录结构组织（`.agents/plugins/`），彼此采用独立标记增量挂载，**可按需任选安装，也可全部共存**。

---

## 插件总览

| 插件 | 版本 | 核心能力 | 架构形态 | 本地端口 | WSL 兼容 | 详细说明 |
| --- | --- | --- | --- | --- | --- | --- |
| **Codex Aurora Theme** (`codex-theme`) | `1.5.1` | 浅色模式极光冰蓝顶部栏 + 左侧任务栏 Windows Acrylic 亚克力微透玻璃效果，深色模式与内置浏览器无感兼容 | 主进程钩子 + 渲染层 | 无 | Windows UI | [README](.agents/plugins/codex-theme/README.md) |
| **Context Donut** (`context-donut`) | `1.2.0` | 输入框工具栏实时 SVG 上下文甜甜圈（精确解析 `transcript.jsonl` 缓存命中与 Token 占比、512k/1M 切换、一键 `/compact`）、每轮任务顶端总耗时计时条、右侧监控 Sidecar | 主进程钩子 + 渲染层 + Sidecar | `127.0.0.1:45789` | Windows + WSL 2 双模 | [README](.agents/plugins/context-donut/README.md) |
| **Quota Pill** (`quota-pill`) | `1.3.0` | 左下角 Codex 风格四分段动态进度环按钮，悬浮/点击展示真实套餐来源、各模型额度池剩余比例与重置倒计时 | 主进程钩子 + 渲染层 + Sidecar | `127.0.0.1:45790` | Windows + WSL 2 双模 | [README](.agents/plugins/quota-pill/README.md) |
| **Cowart Sidebar** (`cowart-sidebar`) | `1.0.0` | 左侧任务栏独立 Cowart 入口，支持全屏无限画布、底部悬浮提问胶囊、提问自动切换「左画布 + 右窄聊天栏」分栏与工作区切换 | 主进程钩子 + 渲染层 + 本地服务 | `127.0.0.1:45791` | Windows UI | [README](.agents/plugins/cowart-sidebar/README.md) |
| **Notion Sidebar** (`notion-sidebar`) | `1.0.0` | 左侧任务栏独立 Notion 笔记入口，基于 OAuth 2.1 PKCE 直连官方 Notion Hosted MCP，支持页面阅读、行内轻量编辑、`/` 插入区块与专属项目分栏提问 | 主进程钩子 + 渲染层 + 本地服务 | `127.0.0.1:45793` | Windows UI | [README](.agents/plugins/notion-sidebar/README.md) |
| **WSL Terminal** (`wsl-terminal`) | `1.0.0` | 在右侧辅助面板打开原生交互式多标签 WSL Linux 终端，自动映射当前工作区路径（`/mnt/...`），支持真彩色、快捷键中断与后台会话保持 | 纯标准 Sidecar（不改 `app.asar`） | 动态端口 | WSL 2 | [README](.agents/plugins/wsl-terminal/README.md) |
| **Tab Suggest** (`tab-suggest`) | `1.0.0` | 每轮任务结束后基于 Vertex AI `deepseek-ai/deepseek-v4.1-flash-maas` 自动在输入框内渲染下一条幽灵灰字建议，按 `Tab` 键一键填入 | 主进程钩子 + Stop Hook + 渲染层 + 本地服务 | `127.0.0.1:45794` | Windows + WSL 2 双模 | [README](.agents/plugins/tab-suggest/README.md) |

---

## 环境要求

- **操作系统**：Windows 10 / Windows 11（`codex-theme` 的亚克力透底在 Windows 11 效果最佳）
- **客户端**：Google Antigravity 桌面端
- **运行时**：[Node.js](https://nodejs.org/) `18+`（用于执行安装脚本及本地桥接/Sidecar 服务）
- **可选依赖**：
  - 使用 `wsl-terminal` 需要本机已启用 WSL 2 且默认发行版内置 `python3`（用于 PTY 伪终端驱动）
  - 使用 `cowart-sidebar` 建议先在 Antigravity 中安装并启用 Cowart 扩展

---

## 快速开始

### 1. 获取仓库

```powershell
git clone https://github.com/Realuu/antigravity-plugins.git
cd antigravity-plugins
```

### 2. 使用统一管理菜单（推荐）

直接双击根目录下的 [`manage.cmd`](manage.cmd)，在交互菜单中按需选择：
- 输入 `1` ~ `7`：安装或更新单个插件
- 输入 `A`：一键安装 / 更新全部 7 个插件
- 输入 `S`：检查全部插件的安装与挂载状态
- 输入 `U`：进入卸载菜单，按需卸载单个或全部插件

也支持直接通过命令行批量执行：

```powershell
# 查看全部插件状态
.\manage.cmd status

# 一键安装全部插件
.\manage.cmd install-all

# 一键卸载全部插件
.\manage.cmd uninstall-all
```

### 3. 单独安装 / 卸载

你也可以直接双击 `cmd/` 目录下的独立批处理（如 `cmd/install-donut.cmd`、`cmd/uninstall-donut.cmd`），或在终端中直接调用 Node 安装器：

```powershell
# 通用格式：install | status | uninstall
node .agents/plugins/codex-theme/installer/install-theme.mjs install
node .agents/plugins/context-donut/installer/install-donut.mjs install
node .agents/plugins/quota-pill/installer/install-quota.mjs install
node .agents/plugins/cowart-sidebar/installer/install-cowart.mjs install
node .agents/plugins/notion-sidebar/installer/install-notion.mjs install
node .agents/plugins/wsl-terminal/installer/install-wsl-terminal.mjs install
node .agents/plugins/tab-suggest/installer/install-tab-suggest.mjs install
```

> 安装脚本会将插件同步到全局配置目录 `~/.gemini/config/plugins/<plugin-name>`（`context-donut`、`quota-pill` 与 `tab-suggest` 还会自动同步到已安装的 WSL 2 发行版），并在支持热加载的场景下尝试实时挂载到当前运行中的 Antigravity 窗口。

---

## 目录结构

```text
antigravity-plugins/
├── .agents/
│   └── plugins/
│       ├── codex-theme/        # Codex 极光冰蓝主题
│       ├── context-donut/      # 上下文甜甜圈 + 任务耗时 + Sidecar
│       ├── cowart-sidebar/     # Cowart 独立侧栏入口
│       ├── notion-sidebar/     # Notion 独立侧栏工作台
│       ├── quota-pill/         # 左下角四分段额度显示
│       ├── tab-suggest/        # 任务结束对话框幽灵补全 + 右上角 Sidecar
│       └── wsl-terminal/       # 右侧辅助面板 WSL 终端
├── cmd/                        # 各插件独立安装 / 卸载批处理脚本
├── manage.cmd                  # 根目录统一交互管理入口
├── LICENSE                     # MIT 开源协议
└── README.md
```

---

## 常见问题与注意事项

1. **Antigravity 客户端自动更新后 UI 插件不显示怎么办？**
   - `wsl-terminal` 为纯标准 Sidecar 插件，客户端更新不会受影响。
   - 其余 6 个深度集成 UI 的插件通过对客户端 `app.asar` 的入口文件做**独立块标记增量注入**实现。当 Antigravity 桌面客户端覆盖升级后，重新运行一次 `manage.cmd`（输入 `A` 或对应编号）即可无损恢复挂载。
2. **端口占用与隐私安全**
   - 所有本地桥接与舞台服务均仅监听本机回环地址 `127.0.0.1`（端口 `45789`、`45790`、`45791`、`45793`、`45794`），不向外部网络暴露。
   - `notion-sidebar` 的 OAuth 凭据与 `tab-suggest` 的 Google Cloud JSON 凭证仅保存在你本机用户目录，不包含任何硬编码密钥。
3. **免责声明**
   - 本仓库为社区自制增强插件合集，与 Google / Antigravity / Notion 官方无隶属关系。安装脚本会在首次修改 `app.asar` 时保留备份并支持随时通过 `uninstall` 精确剥离，使用前仍建议确认客户端版本兼容性。

---

## 第三方开源致谢

- `wsl-terminal` 内置离线打包了 [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) 与 `@xterm/addon-fit`（MIT License）。

## License

本项目基于 [MIT License](LICENSE) 开源。
