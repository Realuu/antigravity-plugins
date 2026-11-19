@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity Context Donut (Windows + WSL 双模一键卸载)
echo ========================================================
node "%~dp0..\.agents\plugins\context-donut\installer\install-donut.mjs" uninstall
echo.
pause
