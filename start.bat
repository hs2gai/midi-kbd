@echo off
rem Splendid Grand Piano - Web MIDI SFZ Sampler
rem Starts the local server and opens the browser. Press Ctrl+C here to stop.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js not found. Install it from https://nodejs.org
    echo.
    pause
    exit /b 1
)

rem SoundFont location: the "sfz" folder next to this file by default.
rem To use another folder, set the SFZ_ROOT environment variable
rem (for example: set "SFZ_ROOT=D:/SoundFonts").

node server.mjs --open

echo.
echo   Server stopped.
pause
