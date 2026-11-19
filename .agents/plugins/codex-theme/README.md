# Antigravity Codex Aurora Theme (`codex-theme`)

将 Antigravity 浅色模式下的顶部栏升级为 Codex 风格极光冰蓝实色渐变，同时为左侧任务栏启用 Windows 原生半透明玻璃透底效果，并保持右侧主对话卡片实心纯白与层次分离。

## 核心特性

1. **顶部实色极光冰蓝 + 左侧半透明玻璃透底（仅浅色模式生效）**：
   - 顶部菜单栏与右上角 `titleBarOverlay` 保持实心不透明的极光冰蓝渐变（`#ebf2fa` / `#e8f1fb` → `#eff4f9`），主进程钩子同步锁定窗口控制按钮浅蓝底色；左侧栏以外的右侧区域同样保持实心 `#eff4f9` 底框；
   - 仅左侧任务栏使用对齐 Codex 隐隐透色质感的清浅冷瓷白微透滤色层（`rgba(252, 253, 254, 0.90)`，仅顶缘 28px 轻柔衔接顶栏，无分段白块色差），主进程钩子同步打通 `BaseWindow` + `hubWcv` + `curtainView` 全链路透明并拦截新版宿主回刷实底 `#FAFAFA`，在 Windows 11 下配合底层原生 **Acrylic 亚克力**背板隐隐透出下方窗口与桌面色调；
   - 左侧选中会话行与悬停态适配为柔和浅雾灰胶囊，保持与浅冷瓷白侧栏的清晰层次；
   - 深色模式保持原版默认不透明黑灰外观，切换主题时自动即时还原背板材质，不作任何覆盖。
2. **主卡片与交互层次提亮**：
   - 右侧主对话区卡片与辅助面板卡片保持实心纯白 `#ffffff`，辅以柔和冷蓝细描边与轻悬浮阴影；
   - 左侧「新建对话」按钮、会话悬停/选中态与左下角 Quota Pill 按钮同步适配为清透毛玻璃冰白质感。
3. **内置浏览器与窗口层安全兼容**：
   - 智能检测内置浏览器 `browser-hole` 打洞及后台停靠隐藏标签状态，防止隐藏页面透穿或破坏打洞容器。

## 常用命令

```powershell
# 安装、同步全局插件并实时热生效
node .agents/plugins/codex-theme/installer/install-theme.mjs install

# 卸载并立即还原默认浅色外观与不透明背板
node .agents/plugins/codex-theme/installer/install-theme.mjs uninstall

# 查看当前插件与 app.asar 挂载状态
node .agents/plugins/codex-theme/installer/install-theme.mjs status
```

也可以直接运行仓库根目录的 `manage.cmd`，或双击 `cmd/install-theme.cmd`、`cmd/uninstall-theme.cmd`。
