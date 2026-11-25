# Meadow auto-updater
Every 10 minutes Windows runs `update.ps1` (Task Scheduler task "Meadow updater"). If there's a new version on GitHub it copies the app files into this folder and restarts Meadow. The `data` folder is never touched.

- Log: `.updater\update.log`
- Update now: right-click `update.ps1` > Run with PowerShell, or `schtasks /run /tn "Meadow updater"`
- Turn it off: `schtasks /change /tn "Meadow updater" /disable`
