@echo off
rem Double-click to start the AMO Studio development build; see start-studio.ps1 (-Install, -Stop).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-studio.ps1" %*
if errorlevel 1 pause
