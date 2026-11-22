@echo off
chcp 65001 >nul
node "%~dp0..\.agents\plugins\tab-suggest\installer\install-tab-suggest.mjs" uninstall
pause
