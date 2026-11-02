# Installs Ephemera for the current Windows user, with nothing else needed:
#   irm https://raw.githubusercontent.com/SneakyShadyLurker/ephemera/main/install.ps1 | iex
# It installs Bun, downloads Ephemera into %LOCALAPPDATA%\Ephemera, adds
# Start menu and desktop shortcuts and the `ephemera` command, then runs setup.
# Run again to update, or to repair an install that stopped half way.
# ASCII only: Windows PowerShell 5.1 reads scripts without a byte order mark
# in the system code page. No `exit` before the end: under `iex` it would
# close the user's PowerShell window.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repository = 'SneakyShadyLurker/ephemera'
$Ref = if ($env:EPHEMERA_REF) { $env:EPHEMERA_REF } else { 'main' }
$HomeDir = if ($env:EPHEMERA_HOME) { $env:EPHEMERA_HOME } else { Join-Path $env:LOCALAPPDATA 'Ephemera' }
$Shim = Join-Path $HomeDir 'ephemera.cmd'
$Current = Join-Path $HomeDir 'current'

function Say($text) { Write-Host "  $text" }

# Failures throw: a function that returned a value would capture the output
# of the commands it runs, and setup would lose its terminal.
function Install-Bun {
  $bunDir = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE '.bun' }
  $bun = Join-Path $bunDir 'bin\bun.exe'
  if ((Get-Command bun -ErrorAction SilentlyContinue) -or (Test-Path $bun)) { return }
  Say 'Installing Bun, which Ephemera runs on...'
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command 'irm https://bun.sh/install.ps1 | iex' | Out-Null
  if (-not (Test-Path $bun)) { throw 'Bun did not install. See https://bun.com/docs/installation.' }
}

# The latest version, as an archive: no Git needed. Named in `current` once complete.
function Get-Ephemera {
  Say 'Downloading Ephemera...'
  $revision = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/commits/$Ref" -Headers @{ Accept = 'application/vnd.github.sha' }).Trim()
  if ($revision -notmatch '^[0-9a-f]{40}$') { throw 'GitHub did not name the latest version; try again later.' }
  $app = Join-Path $HomeDir "app-$revision"
  $partial = "$app.partial"
  $archive = "$partial.tar.gz"
  if (Test-Path $partial) { Remove-Item $partial -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $partial | Out-Null
  Invoke-WebRequest -Uri "https://codeload.github.com/$Repository/tar.gz/$revision" -OutFile $archive -UseBasicParsing
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $archive -C $partial --strip-components=1 | Out-Null
  $unpacked = $LASTEXITCODE
  Remove-Item $archive -Force
  if ($unpacked -ne 0) { throw 'The download could not be unpacked.' }
  [IO.File]::WriteAllText((Join-Path $partial 'REVISION'), "$revision`n")
  if (Test-Path $app) { Remove-Item $app -Recurse -Force }
  Rename-Item $partial (Split-Path -Leaf $app)
  [IO.File]::WriteAllText($Current, "app-$revision")
}

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

# The `ephemera` command, its place on the Path and the shortcuts: made on
# every run, so a rerun repairs whatever an interrupted one left out.
function Install-Integration($fresh) {
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
  $app = Join-Path $HomeDir ([IO.File]::ReadAllText($Current).Trim())
  Copy-Item (Join-Path $app 'apps\web\public\favicon.ico') (Join-Path $HomeDir 'ephemera.ico') -Force

  # Read and written raw, so entries such as %USERPROFILE%\... stay expandable.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($raw -split ';' | Where-Object { $_ })
  if ($entries -notcontains $HomeDir) {
    $key.SetValue('Path', (($entries + $HomeDir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    # Tells Explorer, and so every new terminal, that the environment changed.
    [Environment]::SetEnvironmentVariable('EPHEMERA_INSTALLING', '1', 'User')
    [Environment]::SetEnvironmentVariable('EPHEMERA_INSTALLING', $null, 'User')
  }
  $key.Close()
  if (($env:Path -split ';') -notcontains $HomeDir) { $env:Path = "$env:Path;$HomeDir" }

  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Ephemera.lnk') 'start --pause' 1
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) { New-Shortcut (Join-Path $desktop 'Ephemera.lnk') 'start --pause' 1 }
  if ($fresh) {
    $autostart = $env:EPHEMERA_AUTOSTART
    if (-not $autostart) { $autostart = Read-Host '  Start Ephemera when you sign in to Windows? [Y/n]' }
    if ($autostart -notmatch '^(n|no|0|off)$') {
      New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Ephemera.lnk') 'start --no-open' 7
    }
  }
}

function Install-Ephemera {
  Write-Host ''
  Write-Host '  Ephemera' -ForegroundColor Yellow
  Write-Host ''
  Install-Bun
  $fresh = -not (Test-Path $Current)
  if ($fresh) {
    New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
    Get-Ephemera
  }
  Install-Integration $fresh
  if (Test-Path (Join-Path $HomeDir '.env')) {
    Say 'Ephemera is installed; checking for an update.'
    & $Shim update
  } else {
    Say 'Installed. Now the setup:'
    & $Shim setup
  }
  $script:Code = $LASTEXITCODE
}

$Code = 1
try {
  Install-Ephemera
} catch {
  Say "The install stopped: $($_.Exception.Message)"
  Say 'Run the same command again to carry on.'
}
if ($MyInvocation.MyCommand.Path) { exit $Code }
$global:LASTEXITCODE = $Code
