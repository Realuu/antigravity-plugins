@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity Quota Pill (左下角额度显示) 一键安装程序
echo ========================================================
node "%~dp0..\.agents\plugins\quota-pill\installer\install-quota.mjs" install
echo.
pause
