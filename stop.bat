@echo off
title Stop Meadow
cd /d "%~dp0"
echo stop> "data\stop.flag"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3200 " ^| findstr LISTENING') do taskkill /pid %%p /f >nul 2>&1
echo.
echo   Meadow is stopped.
echo   It starts again the next time you log in to Windows, or when you run start.bat.
echo.
pause
