@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity Codex Aurora Theme (极光冰蓝 UI) 一键卸载
echo ========================================================
node "%~dp0..\.agents\plugins\codex-theme\installer\install-theme.mjs" uninstall
echo.
pause
