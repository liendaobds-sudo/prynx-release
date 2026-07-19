# Run production-style Free-token entitlement E2E locally.
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\run_free_token_e2e.ps1
$ErrorActionPreference = "Stop"
$BackendRoot = Split-Path $PSScriptRoot -Parent
$Python = Join-Path $BackendRoot "venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    throw "Backend virtual environment not found: $Python"
}

Push-Location $BackendRoot
try {
    & $Python -m pytest tests\test_free_token_e2e.py -v --tb=short
    if ($LASTEXITCODE -ne 0) {
        throw "Free-token E2E failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
