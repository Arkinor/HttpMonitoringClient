# Builds a single-file Windows executable.
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Find-Python {
    if (Test-Path ".venv\Scripts\python.exe") {
        return (Resolve-Path ".venv\Scripts\python.exe").Path
    }
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        return "py -3"
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return $python.Source
    }
    throw "Python 3.10+ was not found. Install Python and run setup_and_run.bat first."
}

$python = Find-Python
Write-Host "Using Python: $python"

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "Creating virtual environment..."
    Invoke-Expression "$python -m venv .venv"
    $python = (Resolve-Path ".venv\Scripts\python.exe").Path
}

Write-Host "Installing build dependencies..."
& $python -m pip install --disable-pip-version-check --quiet --upgrade pip
& $python -m pip install --disable-pip-version-check --quiet -r requirements.txt
& $python -m pip install --disable-pip-version-check --quiet "pyinstaller==6.18.0"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install dependencies."
}

if (-not (Test-Path "assets\icon.ico")) {
    Write-Host "Generating application icon..."
    & $python tools\make_icon.py
}

Write-Host "Building ServiceMonitor.exe..."
& $python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name ServiceMonitor `
    --icon "assets\icon.ico" `
    --version-file "tools\version_info.txt" `
    --add-data "servicemonitor\web\static;web\static" `
    run.py
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed."
}

$exe = Join-Path $root "dist\ServiceMonitor.exe"
if (-not (Test-Path $exe)) {
    throw "Build finished, but dist\ServiceMonitor.exe was not created."
}

$spec = Join-Path $root "ServiceMonitor.spec"
if (Test-Path $spec) {
    Remove-Item $spec -Force
}

$size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ""
Write-Host "Build complete: $exe ($size MB)"
Write-Host "User data:    $(Join-Path $root 'dist\data')"
