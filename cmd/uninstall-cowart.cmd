@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity Cowart Sidebar (Cowart 独立侧栏) 一键卸载
echo ========================================================
node "%~dp0..\.agents\plugins\cowart-sidebar\installer\install-cowart.mjs" uninstall
echo.
pause
