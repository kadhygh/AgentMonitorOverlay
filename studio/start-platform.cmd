@echo off
rem Double-click to start AMO Platform from this source checkout; see start-platform.ps1 (-Test for the test channel, -Install).
rem Started from PowerShell 7, Windows PowerShell would inherit its module path and fail to load its own modules.
setlocal
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-platform.ps1" %*
if errorlevel 1 pause
