@echo off
title Connect Meadow to your apps
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app-updates\connect-apps.ps1"
pause
