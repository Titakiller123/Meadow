# Connects Meadow to Money Quest and Dice and Luck.
# It adds one small, read-only "summary" door to each app's server.js. That door only answers
# programs on this same PC, never phones, Tailscale or the internet, and it can't change anything.
# Before replacing a file it checks it's exactly the version this update was made for, and keeps
# the old one next to it as server.before-meadow.js.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

function NormHash($p) {
  $t = [IO.File]::ReadAllText($p) -replace "`r`n", "`n"
  $sha = [Security.Cryptography.SHA256]::Create()
  ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) | ForEach-Object { $_.ToString('x2') }) -join ''
}
function PickFolder($title) {
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $title
  if ($d.ShowDialog() -eq 'OK') { return $d.SelectedPath } else { return $null }
}
function FindApp($name, $candidates, $marker, $pickTitle) {
  foreach ($c in $candidates) {
    $f = Join-Path $c 'server.js'
    if ((Test-Path $f) -and ((Get-Content $f -TotalCount 3) -join "`n") -match [regex]::Escape($marker)) { return $c }
  }
  Write-Host "  I couldn't find $name by myself. Please pick its folder (the one with server.js in it)."
  $p = PickFolder $pickTitle
  if ($p -and (Test-Path (Join-Path $p 'server.js'))) { return $p }
  if ($p -and (Test-Path (Join-Path $p 'program\server.js'))) { return (Join-Path $p 'program') }
  return $null
}
function Update($name, $folder, $newFile, $origHash) {
  $target = Join-Path $folder 'server.js'
  $newHash = NormHash $newFile
  $cur = NormHash $target
  if ($cur -eq $newHash) { Write-Host "  [ok] $name is already connected."; return $true }
  if ($cur -ne $origHash) {
    Write-Host "  [!] $name's server.js has changed since this update was made, so I left it alone."
    Write-Host "      Nothing was changed. Ask Claude for a fresh Meadow update for $name."
    return $false
  }
  Copy-Item $target (Join-Path $folder 'server.before-meadow.js') -Force
  Copy-Item $newFile $target -Force
  Write-Host "  [ok] $name updated. The old file is saved as server.before-meadow.js."
  return $true
}

$U = $env:USERPROFILE
Write-Host ""
Write-Host "  Connecting Meadow to your apps..."
Write-Host ""

$money = FindApp 'Money Quest' @("$root\..\Money", "$U\OneDrive\Desktop\Money", "$U\Desktop\Money", "$U\OneDrive\Desktop\TTRPG\Money", "$U\OneDrive\Money", "$U\Documents\Money") 'Money Quest - local money tracker' 'Pick your Money Quest folder'
if ($money) {
  if (Update 'Money Quest' $money (Join-Path $here 'Money\server.js') '405bb0a0b51f129aadcda7260bd7bd152a156802e2a221aff51818626172c655') {
    # Money Quest restarts by itself a few seconds after it stops
    Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
} else { Write-Host "  [!] Skipped Money Quest." }

$dice = FindApp 'Dice and Luck' @("$U\OneDrive\Desktop\TTRPG\Dice and Luck\program", "$root\..\Dice and Luck\program", "$U\Desktop\TTRPG\Dice and Luck\program", "$U\OneDrive\Desktop\Dice and Luck\program") 'Dice and Luck v2' 'Pick your Dice and Luck "program" folder'
if ($dice) {
  # Dice and Luck notices a new server.js and restarts itself within a few seconds
  [void](Update 'Dice and Luck' $dice (Join-Path $here 'Dice and Luck\server.js') '64a171781da0f85add38c6ba9ba17b7f0bf8a1c399ef08f9fd19b9a01f599a22')
} else { Write-Host "  [!] Skipped Dice and Luck." }

Write-Host ""
Write-Host "  Done. Open Meadow and look at Settings > Connected apps."
Write-Host "  Dice and Luck shows up once it's running (press its Start button as usual)."
Write-Host ""
