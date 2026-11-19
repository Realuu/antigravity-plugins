@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity Cowart Sidebar (Cowart 独立侧栏) 一键安装
echo ========================================================
node "%~dp0..\.agents\plugins\cowart-sidebar\installer\install-cowart.mjs" install
echo.
pause
