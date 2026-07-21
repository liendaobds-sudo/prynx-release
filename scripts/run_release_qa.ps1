# ============================================================
# PrynX release regression gate
# Runs every automated test suite used by the shipped desktop app.
# ASCII-only for Windows PowerShell 5 compatibility.
# ============================================================

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$PYTHON = "$ROOT\backend\venv\Scripts\python.exe"
$NPM_CACHE = Join-Path ([System.IO.Path]::GetTempPath()) "prynx-npm-cache"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )

    Write-Host "  [QA] $Label..." -ForegroundColor DarkGray
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

if (-not (Test-Path -LiteralPath $PYTHON)) {
    throw "Python venv not found: $PYTHON"
}

Invoke-Checked "Python dependency consistency" { & $PYTHON -m pip check }
Invoke-Checked "Preflight golden fixtures" { & "$ROOT\backend\scripts\run_preflight_qa.ps1" }
Invoke-Checked "Free-token entitlement E2E" { & "$ROOT\backend\scripts\run_free_token_e2e.ps1" }

Push-Location "$ROOT\backend"
try {
    Invoke-Checked "Backend test suite" { & $PYTHON -m pytest -q }
} finally {
    Pop-Location
}

Push-Location "$ROOT\desktop"
try {
    Invoke-Checked "Locked frontend dependencies" { npm.cmd ci --no-audit --no-fund --cache $NPM_CACHE }
    Invoke-Checked "Frontend test suite" { npm.cmd test }
} finally {
    Pop-Location
}

Push-Location "$ROOT\imposition_core"
try {
    Invoke-Checked "Imposition core tests" { cargo test --locked }
    Invoke-Checked "Imposition core release compile" { cargo check --release --locked }
} finally {
    Pop-Location
}

$previousPyo3Python = $env:PYO3_PYTHON
$env:PYO3_PYTHON = $PYTHON
Push-Location "$ROOT\native"
try {
    Invoke-Checked "Native PDF tests" { cargo test --locked }
    Invoke-Checked "Native PDF release compile" { cargo check --release --locked }
} finally {
    Pop-Location
    if ($null -eq $previousPyo3Python) {
        Remove-Item Env:PYO3_PYTHON -ErrorAction SilentlyContinue
    } else {
        $env:PYO3_PYTHON = $previousPyo3Python
    }
}

Push-Location "$ROOT\desktop\src-tauri"
try {
    Invoke-Checked "Tauri command tests" { cargo test --locked }
    Invoke-Checked "Tauri release compile" { cargo check --release --locked }
} finally {
    Pop-Location
}

Write-Host "  [QA] All release regression suites passed." -ForegroundColor Green