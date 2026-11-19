@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity Context Donut (Windows + WSL 双模一键安装)
echo ========================================================
node "%~dp0..\.agents\plugins\context-donut\installer\install-donut.mjs" install
echo.
pause
