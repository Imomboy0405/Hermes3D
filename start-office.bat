@echo off
rem Agent Office: Claude Code adapter + Hermes3D Studio, then open the browser.
cd /d "%~dp0"

if not exist node_modules (
  echo Birinchi ishga tushirish: npm install ...
  call npm install || goto :error
)

start "Agent Office - Claude gateway" cmd /k "npm run claude-gateway"
timeout /t 2 /nobreak >nul
start "Agent Office - Studio" cmd /k "npm run dev"
timeout /t 8 /nobreak >nul
start "" http://localhost:3000/office
exit /b 0

:error
echo npm install xato bilan tugadi.
pause
exit /b 1
