# The Windows launcher behind ephemera.cmd, as the root `ephemera` script is on
# macOS and Linux: Bun and the dependencies first, then scripts/ephemera/main.ts.
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 has.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# The oldest Bun this code runs on; the container pins the exact version.
$MinBun = [version]'1.4.0'

function Find-Bun {
  $command = Get-Command bun -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $installDir = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE '.bun' }
  $candidate = Join-Path $installDir 'bin\bun.exe'
  if (Test-Path $candidate) { return $candidate }
  return $null
}

$bun = Find-Bun
if (-not $bun) {
  Write-Host '  Ephemera runs on Bun (https://bun.com). Installing it now...'
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command 'irm https://bun.sh/install.ps1 | iex'
  $bun = Find-Bun
  if (-not $bun) {
    Write-Host '  Bun did not install. See https://bun.com/docs/installation.'
    exit 1
  }
}

$version = [version]((& $bun --version).Trim() -replace '-.*$', '')
if ($version -lt $MinBun) {
  Write-Host "  Ephemera needs Bun $MinBun or newer; this is Bun $version. Run 'bun upgrade', then try again."
  exit 1
}

# The command's own dependencies; a new copy installs everything from bun.lock once.
if (-not (Test-Path (Join-Path $Root 'node_modules\@clack\prompts'))) {
  Write-Host '  Installing dependencies, once...'
  Push-Location $Root
  & $bun install --frozen-lockfile --silent
  $installed = $LASTEXITCODE
  Pop-Location
  if ($installed -ne 0) {
    Write-Host "  Installing dependencies failed; run 'bun install --frozen-lockfile' in $Root to see why."
    exit 1
  }
}

# --no-env-file: the command reads .env itself, so a value it just wrote is the one used.
& $bun --no-env-file (Join-Path $Root 'scripts\ephemera\main.ts') @args
exit $LASTEXITCODE
