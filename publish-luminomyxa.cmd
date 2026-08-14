@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-luminomyxa.ps1" %*
exit /b %errorlevel%
