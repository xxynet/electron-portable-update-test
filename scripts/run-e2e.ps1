param(
    [string]$FromVersion = '1.0.0',
    [string]$ToVersion = '1.0.1',
    [int]$Port = 8001,
    [string]$Python = (Join-Path $PSScriptRoot '..\..\N.E.K.O.-Update\.venv\Scripts\python.exe')
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$targetRelease = Join-Path $root "dist\releases\$ToVersion"
$currentApp = Join-Path $root "dist\stage\$FromVersion\win-unpacked\N.E.K.O.exe"
if (-not (Test-Path -LiteralPath $Python)) { throw "Python for N.E.K.O.-Update was not found: $Python" }
if (-not (Test-Path -LiteralPath $targetRelease)) { throw "Target release was not found: $targetRelease" }
if (-not (Test-Path -LiteralPath $currentApp)) { throw "Current Portable app was not found: $currentApp" }

$staleServices = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'python.exe' -and $_.CommandLine -like '*scripts\run-local-update-service.py*'
}
if ($staleServices) {
    $staleServices | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
}

$updateService = Start-Process -FilePath $Python -ArgumentList @('scripts\run-local-update-service.py', '--release-dir', $targetRelease, '--port', $Port) -WorkingDirectory $root -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
$env:NEKO_UPDATE_SERVICE_URL = "http://127.0.0.1:$Port"
$env:PORTABLE_TEST_PYTHON = $Python
try {
    Start-Process -FilePath $currentApp -WorkingDirectory (Split-Path -Parent $currentApp)
} catch {
    if (-not $updateService.HasExited) { Stop-Process -Id $updateService.Id -Force -ErrorAction SilentlyContinue }
    throw
}
Write-Host "Started v$FromVersion against local v$ToVersion. Click the update button and accept the native prompt."
