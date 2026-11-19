# Antigravity Cowart 独立侧栏入口 (`cowart-sidebar`)

为 Antigravity 左侧任务栏（**「自动化」下方、「自定义配置」上方**）挂载独立的 **Cowart** 入口。

## 核心能力
- **全屏画布 + 底部悬浮提问胶囊**：点击左侧 `Cowart` 即刻全屏打开无限画布，默认优先加载当前活跃项目的 `canvas/` 目录（找不到时回退到系统文稿全局画布），画布内底部工具栏自动上移避让，正下方居中展示紧凑提问胶囊（支持 `+` 上传与 `Ctrl+V` 粘贴参考图）。
- **提问后自动左右分栏同屏**：在下方提问胶囊提问、或在画布内点击「按标注修改 / 生成图片」时，自动切换为「左侧主画布 + 右侧窄聊天栏（默认 400px，可拖拽调宽）」，实时观察 AI 思考与工具执行过程，并支持随时点击 `收起对话` 或右上角 `◫` 按钮回到纯净全屏画布。
- **右上角项目切换**：随时切换其他本地项目工作区或全局 `Documents/Cowart` 画布。

## 安装与卸载
```bash
node .agents/plugins/cowart-sidebar/installer/install-cowart.mjs install
node .agents/plugins/cowart-sidebar/installer/install-cowart.mjs status
node .agents/plugins/cowart-sidebar/installer/install-cowart.mjs uninstall
```
也可直接运行仓库根目录的 `manage.cmd`，或双击 `cmd/install-cowart.cmd` / `cmd/uninstall-cowart.cmd`。
