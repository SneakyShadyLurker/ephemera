# Installs Ephemera for the current Windows user, with nothing else needed:
#   irm https://raw.githubusercontent.com/SneakyShadyLurker/ephemera/main/install.ps1 | iex
# It installs Bun, downloads Ephemera into %LOCALAPPDATA%\Ephemera, adds
# Start menu and desktop shortcuts and the `ephemera` command, then runs setup.
# Run again to update. ASCII only: Windows PowerShell 5.1 reads scripts
# without a byte order mark in the system code page.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repository = 'SneakyShadyLurker/ephemera'
$Ref = if ($env:EPHEMERA_REF) { $env:EPHEMERA_REF } else { 'main' }
$HomeDir = if ($env:EPHEMERA_HOME) { $env:EPHEMERA_HOME } else { Join-Path $env:LOCALAPPDATA 'Ephemera' }
$Shim = Join-Path $HomeDir 'ephemera.cmd'

function Say($text) { Write-Host "  $text" }

Write-Host ''
Write-Host '  Ephemera' -ForegroundColor Yellow
Write-Host ''

if (Test-Path (Join-Path $HomeDir 'current')) {
  if (Test-Path (Join-Path $HomeDir '.env')) {
    Say 'Ephemera is installed already; updating it.'
    & $Shim update
  } else {
    Say 'Ephemera is installed already; finishing its setup.'
    & $Shim setup
  }
  exit $LASTEXITCODE
}

# Bun, with its official installer, for this user only.
$bunDir = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE '.bun' }
$bun = Join-Path $bunDir 'bin\bun.exe'
if (-not (Get-Command bun -ErrorAction SilentlyContinue) -and -not (Test-Path $bun)) {
  Say 'Installing Bun, which Ephemera runs on...'
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command 'irm https://bun.sh/install.ps1 | iex' | Out-Null
  if (-not (Test-Path $bun)) { Say 'Bun did not install. See https://bun.com/docs/installation.'; exit 1 }
}

# The latest version, as an archive: no Git needed.
Say 'Downloading Ephemera...'
$revision = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/commits/$Ref" -Headers @{ Accept = 'application/vnd.github.sha' }).Trim()
if ($revision -notmatch '^[0-9a-f]{40}$') { Say 'GitHub did not name the latest version; try again later.'; exit 1 }
$app = Join-Path $HomeDir "app-$revision"
$archive = Join-Path $env:TEMP "ephemera-$revision.tar.gz"
New-Item -ItemType Directory -Force -Path $app | Out-Null
Invoke-WebRequest -Uri "https://codeload.github.com/$Repository/tar.gz/$revision" -OutFile $archive -UseBasicParsing
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $archive -C $app --strip-components=1
$unpacked = $LASTEXITCODE
Remove-Item $archive -Force
if ($unpacked -ne 0) { Say 'The download could not be unpacked.'; exit 1 }
[IO.File]::WriteAllText((Join-Path $app 'REVISION'), "$revision`n")
[IO.File]::WriteAllText((Join-Path $HomeDir 'current'), "app-$revision")

# The `ephemera` command: runs the current version with this folder as its home.
$shimText = @'
@echo off
setlocal
set "EPHEMERA_HOME=%~dp0"
set "EPHEMERA_HOME=%EPHEMERA_HOME:~0,-1%"
set /p EPHEMERA_APP=<"%~dp0current"
call "%~dp0%EPHEMERA_APP%\ephemera.cmd" %*
exit /b %ERRORLEVEL%
'@
[IO.File]::WriteAllText($Shim, ($shimText -replace "`r?`n", "`r`n"))
Copy-Item (Join-Path $app 'apps\web\public\favicon.ico') (Join-Path $HomeDir 'ephemera.ico') -Force

$userPath = @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ })
if ($userPath -notcontains $HomeDir) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath + $HomeDir) -join ';'), 'User')
}
$env:Path = "$env:Path;$HomeDir"

# Shortcuts that start it and open the browser; the window stays open only on an error.
function New-Shortcut($path, $arguments, $windowStyle) {
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $shortcut.TargetPath = $Shim
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $HomeDir
  $shortcut.IconLocation = Join-Path $HomeDir 'ephemera.ico'
  $shortcut.Description = 'Start Ephemera and open it in your browser'
  $shortcut.WindowStyle = $windowStyle
  $shortcut.Save()
}
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Ephemera.lnk') 'start --pause' 1
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Ephemera.lnk') 'start --pause' 1

$autostart = $env:EPHEMERA_AUTOSTART
if (-not $autostart) { $autostart = Read-Host '  Start Ephemera when you sign in to Windows? [Y/n]' }
if ($autostart -notmatch '^(n|no|0|off)$') {
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Ephemera.lnk') 'start --no-open' 7
}

Say 'Installed. Now the setup:'
& $Shim setup
exit $LASTEXITCODE
