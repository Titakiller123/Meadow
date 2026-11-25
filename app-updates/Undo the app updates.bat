@echo off
title Undo the Meadow app updates
echo.
echo   This puts back the server.js files that "Connect my apps" replaced.
echo   Drag your Money folder or your Dice and Luck "program" folder onto this window and press Enter.
echo.
set /p F=Folder: 
set F=%F:"=%
if not exist "%F%\server.before-meadow.js" ( echo   No saved copy in that folder, nothing to undo. & pause & exit /b )
copy /y "%F%\server.before-meadow.js" "%F%\server.js" >nul
echo   Done. Restart that app (or wait a few seconds if it restarts by itself).
pause
