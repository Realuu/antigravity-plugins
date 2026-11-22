@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if /i "%~1"=="status" goto :status_all_cli
if /i "%~1"=="install-all" goto :install_all_cli
if /i "%~1"=="uninstall-all" goto :uninstall_all_cli

:menu
cls
echo ================================================================
echo             Antigravity Plugins 统一管理工具 (manage.cmd)
echo ================================================================
echo.
echo   [安装 / 更新单个插件]
echo     1. Codex Aurora Theme  (极光冰蓝顶部栏 + 左侧亚克力毛玻璃主题)
echo     2. Context Donut       (上下文甜甜圈 + 每轮任务耗时 + Sidecar)
echo     3. Quota Pill          (左下角 Codex 风格四分段额度显示)
echo     4. Cowart Sidebar      (左侧栏 Cowart 画布独立入口 + 分栏提问)
echo     5. Notion Sidebar      (左侧栏 Notion 笔记工作台 + OAuth 直连)
echo     6. WSL Terminal        (右侧辅助面板原生交互式多标签 WSL 终端)
echo     7. Tab Suggest         (任务结束对话框幽灵补全 + Tab 一键填入)
echo.
echo   [批量与状态管理]
echo     A. 一键安装 / 更新全部 7 个插件
echo     S. 查看全部插件安装状态
echo     U. 进入卸载菜单
echo     0. 退出
echo.
set "CHOICE="
set /p "CHOICE=请输入选项编号并回车: "

if /i "%CHOICE%"=="1" call :run_one "Codex Aurora Theme" "codex-theme\installer\install-theme.mjs" install & pause & goto :menu
if /i "%CHOICE%"=="2" call :run_one "Context Donut" "context-donut\installer\install-donut.mjs" install & pause & goto :menu
if /i "%CHOICE%"=="3" call :run_one "Quota Pill" "quota-pill\installer\install-quota.mjs" install & pause & goto :menu
if /i "%CHOICE%"=="4" call :run_one "Cowart Sidebar" "cowart-sidebar\installer\install-cowart.mjs" install & pause & goto :menu
if /i "%CHOICE%"=="5" call :run_one "Notion Sidebar" "notion-sidebar\installer\install-notion.mjs" install & pause & goto :menu
if /i "%CHOICE%"=="6" call :run_one "WSL Terminal" "wsl-terminal\installer\install-wsl-terminal.mjs" install & pause & goto :menu
if /i "%CHOICE%"=="7" call :run_one "Tab Suggest" "tab-suggest\installer\install-tab-suggest.mjs" install & pause & goto :menu
if /i "%CHOICE%"=="A" call :run_all install & pause & goto :menu
if /i "%CHOICE%"=="S" call :run_all status & pause & goto :menu
if /i "%CHOICE%"=="U" goto :uninstall_menu
if /i "%CHOICE%"=="0" goto :eof

echo.
echo 无效选项，请重新输入。
timeout /t 2 >nul
goto :menu

:uninstall_menu
cls
echo ================================================================
echo                     卸载 Antigravity 插件
echo ================================================================
echo.
echo     1. 卸载 Codex Aurora Theme
echo     2. 卸载 Context Donut
echo     3. 卸载 Quota Pill
echo     4. 卸载 Cowart Sidebar
echo     5. 卸载 Notion Sidebar
echo     6. 卸载 WSL Terminal
echo     7. 卸载 Tab Suggest
echo     A. 卸载全部 7 个插件
echo     B. 返回主菜单
echo.
set "UCHOICE="
set /p "UCHOICE=请输入要卸载的选项编号并回车: "

if /i "%UCHOICE%"=="1" call :run_one "Codex Aurora Theme" "codex-theme\installer\install-theme.mjs" uninstall & pause & goto :uninstall_menu
if /i "%UCHOICE%"=="2" call :run_one "Context Donut" "context-donut\installer\install-donut.mjs" uninstall & pause & goto :uninstall_menu
if /i "%UCHOICE%"=="3" call :run_one "Quota Pill" "quota-pill\installer\install-quota.mjs" uninstall & pause & goto :uninstall_menu
if /i "%UCHOICE%"=="4" call :run_one "Cowart Sidebar" "cowart-sidebar\installer\install-cowart.mjs" uninstall & pause & goto :uninstall_menu
if /i "%UCHOICE%"=="5" call :run_one "Notion Sidebar" "notion-sidebar\installer\install-notion.mjs" uninstall & pause & goto :uninstall_menu
if /i "%UCHOICE%"=="6" call :run_one "WSL Terminal" "wsl-terminal\installer\install-wsl-terminal.mjs" uninstall & pause & goto :uninstall_menu
if /i "%UCHOICE%"=="7" call :run_one "Tab Suggest" "tab-suggest\installer\install-tab-suggest.mjs" uninstall & pause & goto :uninstall_menu
if /i "%UCHOICE%"=="A" call :run_all uninstall & pause & goto :uninstall_menu
if /i "%UCHOICE%"=="B" goto :menu

echo.
echo 无效选项，请重新输入。
timeout /t 2 >nul
goto :uninstall_menu

:status_all_cli
call :run_all status
exit /b %errorlevel%

:install_all_cli
call :run_all install
exit /b %errorlevel%

:uninstall_all_cli
call :run_all uninstall
exit /b %errorlevel%

:run_all
set "ACTION=%~1"
call :run_one "Codex Aurora Theme" "codex-theme\installer\install-theme.mjs" %ACTION%
call :run_one "Context Donut" "context-donut\installer\install-donut.mjs" %ACTION%
call :run_one "Quota Pill" "quota-pill\installer\install-quota.mjs" %ACTION%
call :run_one "Cowart Sidebar" "cowart-sidebar\installer\install-cowart.mjs" %ACTION%
call :run_one "Notion Sidebar" "notion-sidebar\installer\install-notion.mjs" %ACTION%
call :run_one "WSL Terminal" "wsl-terminal\installer\install-wsl-terminal.mjs" %ACTION%
call :run_one "Tab Suggest" "tab-suggest\installer\install-tab-suggest.mjs" %ACTION%
exit /b 0

:run_one
echo.
echo ----------------------------------------------------------------
echo [%~3] %~1
echo ----------------------------------------------------------------
node "%ROOT%\.agents\plugins\%~2" %~3
exit /b %errorlevel%
