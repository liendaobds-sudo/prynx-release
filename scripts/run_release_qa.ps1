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

# BUILD (audit 2026-08-11 §REL.QA.UTF8): pytest fd-capture đọc theo UTF-8, còn
# ProcessPool con trên Windows có thể kế thừa code page hệ thống và ghi byte khác
# UTF-8 vào cùng handle. Ép đồng nhất encoding cho toàn bộ Python con rồi hoàn
# nguyên môi trường khi gate kết thúc hoặc thất bại.
$previousPythonIoEncoding = [Environment]::GetEnvironmentVariable(
    "PYTHONIOENCODING",
    [EnvironmentVariableTarget]::Process
)
try {
$env:PYTHONIOENCODING = "utf-8:replace"

if (-not (Test-Path -LiteralPath $PYTHON)) {
    throw "Python venv not found: $PYTHON"
}

# BUILD (audit 2026-08-03 REL.09): when production staging is active, prove
# every Python test imports the exact native wheel selected for Nuitka.
if (-not [string]::IsNullOrWhiteSpace($env:PRYNX_RELEASE_NATIVE_SITE)) {
    $expectedNativeSiteInput = [System.IO.Path]::GetFullPath($env:PRYNX_RELEASE_NATIVE_SITE).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $expectedNativeSiteInput -PathType Container)) {
        throw "Staged native site not found: $expectedNativeSiteInput"
    }

    # BUILD (audit 2026-08-03 REL.09): compare both paths after pathlib resolves
    # Windows 8.3 aliases (KHANHP~1) to their long form. GetFullPath alone does
    # not canonicalize that alias and previously rejected the correct staged wheel.
    $nativeOutput = @(& $PYTHON -c "import json, os, pathlib, pdfcompare_native; site=pathlib.Path(os.environ['PRYNX_RELEASE_NATIVE_SITE']).resolve(); package=pathlib.Path(pdfcompare_native.__file__).resolve().parent; print(json.dumps({'site': str(site), 'package': str(package), 'inside': package.is_relative_to(site)}))" 2>&1)
    if ($LASTEXITCODE -ne 0 -or $nativeOutput.Count -eq 0) {
        throw "Cannot import the staged pdfcompare_native package."
    }

    try {
        $nativeProbe = ([string]$nativeOutput[-1]) | ConvertFrom-Json
    } catch {
        throw "Cannot parse staged native import probe: $([string]$nativeOutput[-1])"
    }
    $expectedNativeSite = [string]$nativeProbe.site
    $actualNativePackage = [string]$nativeProbe.package
    if (-not [bool]$nativeProbe.inside) {
        throw "QA imported pdfcompare_native outside the staged wheel: $actualNativePackage"
    }
    Write-Host "  [QA] Native runtime pinned to staged wheel." -ForegroundColor Green
}

# BUILD (audit 2026-08-15 ARCH.BUDGET): số dòng chỉ là tín hiệu quy hoạch.
# Báo cáo có lỗi nội bộ cũng không được biến thành lỗi artifact/release QA.
Write-Host "  [QA] Architecture debt report (informational)..." -ForegroundColor DarkGray
& $PYTHON "$ROOT\scripts\report_architecture_debt.py"
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: Architecture debt report unavailable; release QA continues." -ForegroundColor Yellow
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
$frontendQaImpositionFixtures = Join-Path $frontendQaFull "imposition_core\tests\fixtures"
$frontendQaNormalizeSource = Join-Path $frontendQaFull "imposition_core\src\mixed_nesting"
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
    # NupGridSolver.parity.test.ts resolves the shared Rust oracle through the
    # same workspace-sibling contract; stage only the exact external fixture.
    New-Item -ItemType Directory -Path $frontendQaImpositionFixtures | Out-Null
    Copy-Item -LiteralPath "$ROOT\imposition_core\tests\fixtures\grid_parity_simple_auto.json" `
        -Destination $frontendQaImpositionFixtures
    # previewGeometry.test.ts locks frontend normalization against the Rust
    # source contract. Stage the exact source file used by those assertions.
    New-Item -ItemType Directory -Path $frontendQaNormalizeSource | Out-Null
    Copy-Item -LiteralPath "$ROOT\imposition_core\src\mixed_nesting\normalize.rs" `
        -Destination $frontendQaNormalizeSource

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
$previousPyo3EnvironmentSignature = $env:PYO3_ENVIRONMENT_SIGNATURE
$previousNativePath = $env:PATH
$nativePythonBase = (& $PYTHON -c "import sys; print(sys.base_prefix)").Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nativePythonBase)) {
    throw "Cannot resolve the base Python runtime for native tests: $nativePythonBase"
}
$nativePythonVersion = (& $PYTHON -c "import sys; print('.'.join(map(str, sys.version_info[:3])))").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nativePythonVersion)) {
    throw "Cannot resolve the Python version for native tests."
}

# BUILD (audit 2026-08-03 REL.08): PyO3 test binaries load python3*.dll at
# runtime. Expose only this venv's base runtime while the native gate runs.
# pyo3-build-config intentionally tracks PYO3_ENVIRONMENT_SIGNATURE instead of
# PYO3_PYTHON, so bind the signature to this interpreter to invalidate stale
# cargo artifacts produced by another Python minor version.
$env:PYO3_PYTHON = $PYTHON
$env:PYO3_ENVIRONMENT_SIGNATURE = $PYTHON + "|" + $nativePythonVersion
$env:PATH = $nativePythonBase + [System.IO.Path]::PathSeparator + $previousNativePath
Push-Location "$ROOT\native"
try {
    Invoke-Checked "Native PDF tests" { cargo test --locked }
    Invoke-Checked "Native PDF release compile" { cargo check --release --locked }
} finally {
    Pop-Location
    $env:PATH = $previousNativePath
    if ($null -eq $previousPyo3Python) {
        Remove-Item Env:PYO3_PYTHON -ErrorAction SilentlyContinue
    } else {
        $env:PYO3_PYTHON = $previousPyo3Python
    }
    if ($null -eq $previousPyo3EnvironmentSignature) {
        Remove-Item Env:PYO3_ENVIRONMENT_SIGNATURE -ErrorAction SilentlyContinue
    } else {
        $env:PYO3_ENVIRONMENT_SIGNATURE = $previousPyo3EnvironmentSignature
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
} finally {
    [Environment]::SetEnvironmentVariable(
        "PYTHONIOENCODING",
        $previousPythonIoEncoding,
        [EnvironmentVariableTarget]::Process
    )
}
