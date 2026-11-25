@echo off
title Meadow first-time setup
cd /d "%~dp0"
echo.
echo   Setting up Meadow...
echo.
rem 1. start with Windows: a shortcut to run-hidden.vbs in the Startup folder
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Meadow.lnk'); $s.TargetPath='%~dp0run-hidden.vbs'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo   [ok] Meadow will start by itself when you log in to Windows.
rem 2. share it privately with your phone over Tailscale on port 10000
where tailscale >nul 2>&1
if errorlevel 1 (
  echo   [!] Tailscale wasn't found. Your phone can still use it on the same Wi-Fi.
) else (
  tailscale serve --bg --https=10000 3200
  echo   [ok] Shared privately through Tailscale on port 10000.
)
rem 3. start it now and open it
call "%~dp0start.bat"
echo.
for /f "delims=" %%h in ('powershell -NoProfile -Command "try{((tailscale status --json)|ConvertFrom-Json).Self.DNSName.TrimEnd('.')}catch{}"') do set TSHOST=%%h
if defined TSHOST (
  echo   On your iPhone open:  https://%TSHOST%:10000
) else (
  echo   On your iPhone open the Tailscale address of this PC with :10000 at the end.
)
echo   Then tap Share, then Add to Home Screen.
echo.
pause
