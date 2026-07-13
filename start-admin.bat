@echo off
:: ─────────────────────────────────────────────────────────────────
::  Navi Cleaner — Elevated Launcher
::  Right-click this file and choose "Run as administrator" OR
::  double-click: it will self-elevate via UAC prompt automatically.
:: ─────────────────────────────────────────────────────────────────

:: Check if already running as admin
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :RUN_ELEVATED
) else (
    goto :ELEVATE
)

:ELEVATE
echo Requesting Administrator privileges...
powershell -Command "Start-Process '%~f0' -Verb RunAs -Wait"
exit /b

:RUN_ELEVATED
echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║   Navi Cleaner — Elevated Launch Mode             ║
echo  ║   Administrator privileges confirmed.             ║
echo  ╚══════════════════════════════════════════════════╝
echo.

:: Navigate to the app directory and start the server
cd /d "%~dp0"
node server.js
pause
