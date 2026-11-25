@echo off
rem Keeps Meadow running in the background (started hidden by run-hidden.vbs).
rem If it ever crashes it restarts after 5 seconds. Use stop.bat to stop it.
cd /d "%~dp0"
if not exist "data" mkdir "data"
curl -s -o nul http://localhost:3200/api/ping
if not errorlevel 1 goto end
if exist "data\stop.flag" del "data\stop.flag"
:loop
echo [%date% %time%] starting> "data\server.log"
node server.js >> "data\server.log" 2>&1
if exist "data\stop.flag" goto end
curl -s -o nul http://localhost:3200/api/ping
if not errorlevel 1 goto end
ping -n 6 127.0.0.1 >nul
goto loop
:end
if exist "data\stop.flag" del "data\stop.flag"
