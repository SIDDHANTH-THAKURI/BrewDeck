@echo off
title BREWDECK
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
node server.js
pause
