# Meadow auto-updater. Runs every 10 minutes from Task Scheduler (task "Meadow updater").
# Pulls the newest version from the private GitHub repo and copies the app files into the
# Meadow folder. It never touches the data folder (your tasks, settings and backups).
$ErrorActionPreference = 'Stop'
$App  = Split-Path -Parent $PSScriptRoot          # D:\Life App
$Repo = Join-Path $App '.updater\repo'
$Log  = Join-Path $App '.updater\update.log'
$Mark = Join-Path $App '.updater\deployed.txt'
function Say($m) { Add-Content -Path $Log -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $m) }
try {
  if (-not (Test-Path (Join-Path $Repo '.git'))) { Say 'no repo clone yet; run updater\install.ps1 first'; exit 1 }
  git -C $Repo fetch --quiet origin main 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Say 'could not reach GitHub; will try again later'; exit 0 }
  $new = (git -C $Repo rev-parse origin/main).Trim()
  $old = if (Test-Path $Mark) { (Get-Content $Mark -Raw).Trim() } else { '' }
  if ($new -eq $old) { exit 0 }
  git -C $Repo reset --hard --quiet origin/main
  # copy app files only; data, the clone and logs are excluded
  robocopy $Repo $App /E /XD '.git' 'data' '.updater' /XF '.gitignore' /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Say "copy failed (robocopy $LASTEXITCODE)"; exit 1 }
  Set-Content -Path $Mark -Value $new
  $msg = (git -C $Repo log -1 --format=%s).Trim()
  Say "installed $($new.Substring(0,7)): $msg"
  # restart Meadow so server changes take effect (the page itself refreshes on the phone)
  $dataDir = Join-Path $App 'data'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Set-Content -Path (Join-Path $dataDir 'stop.flag') -Value 'update'
  $conn = Get-NetTCPConnection -LocalPort 3200 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 4
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $App 'run-hidden.vbs') + '"') -WorkingDirectory $App
  Start-Sleep -Seconds 6
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://localhost:3200/api/ping | Out-Null; Say 'restarted Meadow: ok' } catch { Say 'restart: Meadow did not answer yet' }
} catch { Say ("error: " + $_.Exception.Message); exit 1 }
