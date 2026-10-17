@echo off
rem Double-click to start the AMO Studio development build; see start-studio.ps1 (-Install, -Stop).
rem Started from PowerShell 7, Windows PowerShell would inherit its module path and fail to load its own modules.
setlocal
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-studio.ps1" %*
if errorlevel 1 pause
