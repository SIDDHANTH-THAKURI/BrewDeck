@echo off
title BREWDECK
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
rem --env-file-if-exists keeps this identical to `npm start`. Without it the
rem phone-call path silently gets no keys when launched by double-click, which
rem looks like a broken feature rather than a missing file. Needs Node 20.12+.
node --env-file-if-exists=.env server.js
pause
