@echo off
chcp 65001 >nul
echo ========================================================
echo   Antigravity Task Timer (每轮任务总运行时长一键安装)
echo ========================================================
node "%~dp0..\.agents\plugins\task-timer\installer\install-task-timer.mjs" install
echo.
pause
