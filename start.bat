@echo off
rem Opens Meadow. If it isn't running yet, starts it in the background first.
cd /d "%~dp0"
curl -s -o nul http://localhost:3200/api/ping
if errorlevel 1 (
  echo Starting Meadow in the background...
  wscript "%~dp0run-hidden.vbs"
  ping -n 4 127.0.0.1 >nul
)
start "" http://localhost:3200
