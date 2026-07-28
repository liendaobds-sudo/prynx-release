# ============================================================
# PrynX release regression gate
# Runs every automated test suite used by the shipped desktop app.
# ASCII-only for Windows PowerShell 5 compatibility.
# ============================================================

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$PYTHON = "$ROOT\backend\venv\Scripts\python.exe"
$NPM_CACHE = Join-Path ([System.IO.Path]::GetTempPath()) "prynx-npm-cache"
$FRONTEND_QA_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ("prynx-frontend-qa-" + [guid]::NewGuid().ToString("N"))
$NO_GS_CORPUS = if ($env:PRYNX_NO_GS_CORPUS) {
    $env:PRYNX_NO_GS_CORPUS
} else {
    Join-Path $ROOT "private_test_corpus\incoming"
}
$NO_GS_AUDIT_OUT = Join-Path $ROOT "tmp\release_no_gs_audit.json"

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

# RELEASE QA (audit 2026-07-28): the no-GS product contract is corpus-backed.
# REFUSED is an intentional fail-closed outcome; GS and ERROR fail the release.
if (-not (Test-Path -LiteralPath $NO_GS_CORPUS)) {
    throw "No-GS corpus not found: $NO_GS_CORPUS (set PRYNX_NO_GS_CORPUS)"
}
Invoke-Checked "No-GS dependency gate (18 files x 16 operations)" {
    & $PYTHON "$ROOT\scripts\gs_dependency_audit.py" $NO_GS_CORPUS `
        --limit 18 --gate --out $NO_GS_AUDIT_OUT
}

# RELEASE QA (audit 2026-07-27): Windows dev servers keep native npm DLLs locked,
# so `npm ci` must not destructively replace the live desktop/node_modules tree.
# Copy the current frontend source to an isolated temp directory, install exactly
# from package-lock.json there, and run the suite against that clean install.
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$frontendQaFull = [System.IO.Path]::GetFullPath($FRONTEND_QA_DIR)
if (-not $frontendQaFull.StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Frontend QA staging path escaped the temp root: $frontendQaFull"
}
New-Item -ItemType Directory -Path $frontendQaFull | Out-Null
$frontendQaDesktop = Join-Path $frontendQaFull "desktop"
$frontendQaNativeFixtures = Join-Path $frontendQaFull "native\tests\fixtures"
try {
    Write-Host "  [QA] Staging frontend source outside the live node_modules tree..." -ForegroundColor DarkGray
    & robocopy "$ROOT\desktop" $frontendQaDesktop /E /NFL /NDL /NJH /NJS /NP `
        /XD node_modules dist target binaries `
        /XF *.log
    $copyExit = $LASTEXITCODE
    if ($copyExit -gt 7) {
        throw "Frontend QA source staging failed with robocopy exit code $copyExit"
    }

    # nativeFixtureParity.test.ts resolves the native fixture through the
    # workspace sibling layout (`desktop/../native`), so preserve that contract.
    New-Item -ItemType Directory -Path $frontendQaNativeFixtures | Out-Null
    Copy-Item -LiteralPath "$ROOT\native\tests\fixtures\dieline_default_request.json" `
        -Destination $frontendQaNativeFixtures

    Push-Location $frontendQaDesktop
    try {
        Invoke-Checked "Locked frontend dependencies (isolated)" {
            npm.cmd ci --no-audit --no-fund --cache $NPM_CACHE
        }
        Invoke-Checked "Frontend typecheck (isolated)" { npm.cmd run typecheck }
        Invoke-Checked "Frontend test suite (isolated)" { npm.cmd test }
    } finally {
        Pop-Location
    }
} finally {
    # Path was canonicalized and proven to be a direct descendant of Temp above.
    if (Test-Path -LiteralPath $frontendQaFull) {
        Remove-Item -LiteralPath $frontendQaFull -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Push-Location "$ROOT\imposition_core"
try {
    Invoke-Checked "Imposition core tests" { cargo test --locked }
    Invoke-Checked "Imposition core release compile" { cargo check --release --locked }
} finally {
    Pop-Location
}

Push-Location "$ROOT\print_engine"
try {
    Invoke-Checked "Print engine tests" { cargo test --locked }
    Invoke-Checked "Print engine release compile" { cargo check --release --locked }
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