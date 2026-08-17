@echo off
REM BookTranslator — one-click launcher.
REM Portable: runs from whatever folder this file lives in (any PC / any drive letter).
REM Requires Node.js installed on this PC.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed on this PC. Install it from https://nodejs.org & pause & exit /b 1)
start "BookTranslator server" /min cmd /c "node server\index.js"
timeout /t 1 /nobreak >nul
start "" "http://localhost:4319/"
echo BookTranslator is running at http://localhost:4319/
echo Close the minimised "BookTranslator server" window to stop it.
