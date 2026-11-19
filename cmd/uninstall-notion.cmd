@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity Notion Sidebar (Notion 独立侧栏) 一键卸载
echo ========================================================
node "%~dp0..\.agents\plugins\notion-sidebar\installer\install-notion.mjs" uninstall
echo.
pause
