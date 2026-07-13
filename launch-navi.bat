@echo off
:: ─────────────────────────────────────────────────────────────────────────────
::  Navi Cleaner — App-Mode Desktop Launcher
::  Starts the Node.js server silently and opens Chrome in --app mode so it
::  looks and feels like a native desktop application (no address bar, no tabs).
:: ─────────────────────────────────────────────────────────────────────────────

setlocal

:: Navigate to the app directory (same folder as this bat file)
cd /d "%~dp0"

:: Start Node server in a hidden window so no terminal flickers
start "" /B /MIN node server.js

:: Give the server 2 seconds to bind to port 3141
timeout /t 2 /nobreak >nul

:: Try Google Chrome first (most common install paths)
set CHROME_PATH=""
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH="%ProgramFiles%\Google\Chrome\Application\chrome.exe"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH="%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH="%LocalAppData%\Google\Chrome\Application\chrome.exe"
)

:: Launch in --app mode (native window, no chrome UI) with custom profile
if NOT %CHROME_PATH%=="" (
    start "" %CHROME_PATH% ^
        --app=http://localhost:3141 ^
        --window-size=1280,820 ^
        --disable-background-networking ^
        --disable-extensions ^
        --no-first-run ^
        --user-data-dir="%~dp0.chrome-profile"
) else (
    :: Fallback: open in default browser
    start http://localhost:3141
)

endlocal
