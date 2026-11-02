@echo off
rem Ephemera's one command on Windows: `ephemera help` lists what it does.
rem The PowerShell launcher beside it makes sure Bun and the dependencies are
rem there, then hands over to scripts\ephemera\main.ts.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ephemera\launch.ps1" %*
exit /b %ERRORLEVEL%
