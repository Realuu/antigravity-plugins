@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity WSL 终端 (右侧面板交互式终端) 一键卸载程序
echo ========================================================
node "%~dp0..\.agents\plugins\wsl-terminal\installer\install-wsl-terminal.mjs" uninstall
echo.
pause
