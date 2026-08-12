# ============================================================
#  PrynX Production Build Pipeline
#  Nuitka compile Python -> native binary + Tauri bundle
#  (ASCII-only: Windows PowerShell parses .ps1 as ANSI when no BOM)
# ============================================================
#
#  Usage:
#    .\build_production.ps1                  # Full build (manual installer)
#    .\build_production.ps1 -SkipNuitka      # Skip Python compilation
#    .\build_production.ps1 -SkipTauri       # Skip Tauri build
#    .\build_production.ps1 -NuitkaOnly      # Only compile Python
#    .\build_production.ps1 -NuitkaJobs 4    # Limit parallel MSVC jobs (default: 4)
#    .\build_production.ps1 -Release         # Build updater artifacts (needs signing key)
#    .\build_production.ps1 -SkipPreflightQA # Emergency build without automated QA
#    .\build_production.ps1 -NoOpenExplorer  # Do not open Explorer after build
#    .\build_production.ps1 -Version 1.0.0-beta.13  # Bump version before build
#    Ghostscript is never bundled; dev/test/release share one no-GS contract.
#
# ============================================================

param(
    [switch]$SkipNuitka,
    [switch]$SkipTauri,
    [switch]$NuitkaOnly,
    [switch]$Release,
    [switch]$AllowPlaintextDieline,
    [switch]$SkipPreflightQA,
    [switch]$ReusePassedNoGs,
    [switch]$NoOpenExplorer,
    [ValidateRange(1, 8)]
    [int]$NuitkaJobs = 4,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition

# SEC (audit 2026-08-03 §REL.SECRET): nếu CI/CLI cũ truyền key qua env, lấy ra
# và xóa NGAY trước bất kỳ git/node/rust/python process con nào. Launcher chuẩn
# không dùng env; nó để build đọc kho DPAPI đúng tại bước REST bên dưới.
$script:CapturedReleaseSupabaseSecret = [string]$env:PRYNX_SUPABASE_SECRET_KEY
$script:CapturedLegacySupabaseServiceKey = [string]$env:PRYNX_SUPABASE_SERVICE_KEY
$script:CapturedTauriSigningPrivateKey = [string]$env:TAURI_SIGNING_PRIVATE_KEY
$script:CapturedTauriSigningKeyFile = [string]$env:PRYNX_TAURI_SIGNING_KEY_FILE
$script:CapturedTauriSigningPrivateKeyPassword = [string]$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Remove-Item Env:PRYNX_SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
Remove-Item Env:PRYNX_SUPABASE_SERVICE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:PRYNX_TAURI_SIGNING_KEY_FILE -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue

# BUILD (audit 2026-08-04 BLD.05): build co the duoc goi trong mot PowerShell
# -NoExit, nen moi bien process do pipeline so huu phai tro ve dung trang thai dau.
$script:BuildOwnedEnvironmentSnapshot = @{}
foreach ($environmentName in @(
    "VITE_FEATURE_GATING_ENABLED",
    "PRYNX_FEATURE_GATING_ENABLED",
    "VITE_LOGO_REBUILD_ENABLED",
    "PRYNX_LOGO_REBUILD_ENABLED",
    "PRYNX_FRONTEND_HASH",
    "PRYNX_SIDECAR_HASH",
    "DEV_MODE",
    "PYTHONIOENCODING",
    "NUITKA_CACHE_DIR",
    "PRYNX_DIELINE_VERSION",
    "VIRTUAL_ENV",
    "PYTHONPATH",
    "PRYNX_RELEASE_NATIVE_SITE",
    "PRYNX_NO_GS_AUDIT_OUT",
    "PRYNX_BUILD_SOURCE_REVISION",
    "PRYNX_BUILD_SOURCE_DIRTY",
    "PRYNX_BUILD_TIMESTAMP_UTC",
    "PRYNX_BUILD_REQUIRE_CLEAN",
    "_CL_",
    "RUSTFLAGS",
    "CARGO_PROFILE_RELEASE_LTO",
    "CARGO_PROFILE_RELEASE_CODEGEN_UNITS",
    "CARGO_PROFILE_RELEASE_STRIP"
)) {
    $environmentValue = [Environment]::GetEnvironmentVariable(
        $environmentName,
        [EnvironmentVariableTarget]::Process
    )
    $script:BuildOwnedEnvironmentSnapshot[$environmentName] = @{
        Exists = $null -ne $environmentValue
        Value = if ($null -ne $environmentValue) { [string]$environmentValue } else { $null }
    }
}

function Restore-BuildOwnedEnvironment {
    foreach ($entry in $script:BuildOwnedEnvironmentSnapshot.GetEnumerator()) {
        $value = if ($entry.Value.Exists) { [string]$entry.Value.Value } else { $null }
        [Environment]::SetEnvironmentVariable(
            [string]$entry.Key,
            $value,
            [EnvironmentVariableTarget]::Process
        )
    }
}

try {

# Release artifacts must be rebuilt from current sources and must pass the full QA gate.
if ($SkipNuitka) {
    throw "-SkipNuitka has been retired: every installer must compile the sidecar from current sources."
}
if ($Release -and $SkipPreflightQA) {
    throw "Release build refuses -SkipPreflightQA: security regression tests are mandatory."
}
if ($ReusePassedNoGs -and -not $Release) {
    throw "-ReusePassedNoGs chi duoc dung cho luong phat hanh."
}
if ($Release -and ($SkipTauri -or $NuitkaOnly)) {
    throw "Release build must create and verify a fresh installer; -SkipTauri/-NuitkaOnly are not allowed."
}
if ($Release -and -not [string]::IsNullOrWhiteSpace($Version)) {
    throw "Release build refuses inline -Version mutation. Commit the synchronized version before release."
}

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Cyan
Write-Host "       PrynX Production Build Pipeline" -ForegroundColor Cyan
Write-Host "  ===========================================" -ForegroundColor Cyan
Write-Host ""

$VENV_PYTHON = "$ROOT\backend\venv\Scripts\python.exe"
$env:NUITKA_CACHE_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "prynx-nuitka-cache"
$SIDECAR_DIR = "$ROOT\desktop\src-tauri\binaries"
$SIDECAR_NAME = "pdf-inspector-backend"

$TAURI_CONF = "$ROOT\desktop\src-tauri\tauri.conf.json"
$PKG_JSON = "$ROOT\desktop\package.json"
$PKG_LOCK = "$ROOT\desktop\package-lock.json"
$CARGO_TOML = "$ROOT\desktop\src-tauri\Cargo.toml"
$CARGO_LOCK = "$ROOT\desktop\src-tauri\Cargo.lock"

function ConvertTo-BuildToolVersion {
    param([string]$VersionText)

    $match = [regex]::Match($VersionText, '(?<!\d)(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success) { return $null }
    try {
        return [version]::Parse(("{0}.{1}.{2}" -f @(
            $match.Groups[1].Value,
            $match.Groups[2].Value,
            $match.Groups[3].Value
        )))
    } catch {
        return $null
    }
}

function Test-PythonDistribution {
    param([Parameter(Mandatory = $true)][string]$Name)

    # BUILD (audit 2026-08-03 REL.PY311): `pip show` ghi warning ra stderr khi
    # package chua cai; Windows PowerShell 5 + ErrorActionPreference=Stop bien
    # phep probe binh thuong thanh NativeCommandError. Metadata probe nay im lang
    # va chi tra exit code de nhanh cai dat tu xu ly dung hop dong.
    & $VENV_PYTHON -c @'
import importlib.metadata as metadata
import sys

name = sys.argv[1].lower()
found = any((dist.metadata.get('Name') or '').lower() == name for dist in metadata.distributions())
sys.exit(0 if found else 1)
'@ $Name
    return ($LASTEXITCODE -eq 0)
}

function Assert-BuildToolchain {
    # BUILD (audit 2026-08-03 REL.07/REL.08): fail early, before QA or file mutation.
    $requiredNode = '^20.19.0 || >=22.12.0'
    $pkg = Get-Content -LiteralPath $PKG_JSON -Raw | ConvertFrom-Json
    if ([string]$pkg.engines.node -ne $requiredNode) {
        throw "desktop/package.json engines.node drifted from the audited contract: $requiredNode"
    }

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { throw "Node.js not found. Required: $requiredNode" }
    $nodeText = (& node --version 2>&1 | Select-Object -First 1)
    $nodeVersion = ConvertTo-BuildToolVersion "$nodeText"
    $nodeOk = $null -ne $nodeVersion -and (
        ($nodeVersion.Major -eq 20 -and $nodeVersion -ge [version]'20.19.0') -or
        ($nodeVersion -ge [version]'22.12.0')
    )
    if (-not $nodeOk) {
        throw "Node.js $nodeText is unsupported. Required: $requiredNode"
    }

    $cargoText = Get-Content -LiteralPath $CARGO_TOML -Raw
    $rustMatch = [regex]::Match($cargoText, '(?m)^rust-version\s*=\s*"([^"]+)"')
    if (-not $rustMatch.Success) {
        throw "desktop/src-tauri/Cargo.toml must declare rust-version."
    }
    $requiredRust = ConvertTo-BuildToolVersion ($rustMatch.Groups[1].Value + '.0')
    $rustCmd = Get-Command rustc -ErrorAction SilentlyContinue
    if (-not $rustCmd) { throw "rustc not found. Required: >=$($rustMatch.Groups[1].Value)" }
    $rustText = (& rustc --version 2>&1 | Select-Object -First 1)
    $rustVersion = ConvertTo-BuildToolVersion "$rustText"
    if ($null -eq $requiredRust -or $null -eq $rustVersion -or $rustVersion -lt $requiredRust) {
        throw "Rust $rustText is unsupported. Required: >=$($rustMatch.Groups[1].Value)"
    }

    Write-Host "  Toolchain: Node $nodeVersion | Rust $rustVersion" -ForegroundColor Green
}

function Assert-ReleaseSourceState {
    param([switch]$CaptureCommit)

    if (-not $Release) { return }
    $inside = @(& git -C $ROOT rev-parse --is-inside-work-tree 2>$null)
    if ($LASTEXITCODE -ne 0 -or $inside.Count -ne 1 -or $inside[0].Trim() -ne "true") {
        throw "Release build requires a valid Git worktree."
    }
    $dirty = @(& git -C $ROOT status --porcelain=v1 --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "Cannot verify release worktree cleanliness." }
    if ($dirty.Count -gt 0) {
        throw "Release build requires a clean committed worktree; found $($dirty.Count) dirty entries."
    }
    $commitOutput = @(& git -C $ROOT rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $commitOutput.Count -ne 1) {
        throw "Cannot resolve the release source commit."
    }
    $commit = $commitOutput[0].Trim()
    if ($CaptureCommit) {
        $script:ReleaseSourceCommit = $commit
    } elseif ([string]::IsNullOrWhiteSpace($script:ReleaseSourceCommit) -or
        $commit -ne $script:ReleaseSourceCommit) {
        throw "Release source commit changed during the build."
    }
}

function Copy-DirectoryWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePattern,
        [Parameter(Mandatory = $true)][string]$Destination,
        [int]$MaxAttempts = 5
    )
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Copy-Item -Path $SourcePattern -Destination $Destination -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $MaxAttempts) { throw }
            Write-Host "  Resource file busy; retry $attempt/$MaxAttempts..." -ForegroundColor Yellow
            Start-Sleep -Seconds 1
        }
    }
}

Assert-BuildToolchain
Assert-ReleaseSourceState -CaptureCommit

# ---- Optional: bump version from -Version (Build NOI BO / CLI) ----
# Truoc day chi release_update.ps1 ghi version; build noi bo doc tauri.conf cu
# -> go 1.0.0-beta.12 van ra installer .11. Ghi UTF-8 khong BOM (tranh hong JSON).
if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $Version = $Version.Trim()
    if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$') {
        Write-Host "ERROR: -Version phai la SemVer (vd 1.0.0-beta.12), nhan duoc: $Version" -ForegroundColor Red
        exit 1
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    if (Test-Path $TAURI_CONF) {
        $conf = [System.IO.File]::ReadAllText($TAURI_CONF, [System.Text.Encoding]::UTF8)
        $conf = [regex]::Replace($conf, '("version"\s*:\s*")[^"]*(")', "`${1}$Version`${2}", 1)
        [System.IO.File]::WriteAllText($TAURI_CONF, $conf.TrimStart([char]0xFEFF), $utf8NoBom)
    }
    if (Test-Path $PKG_JSON) {
        $pkg = [System.IO.File]::ReadAllText($PKG_JSON, [System.Text.Encoding]::UTF8)
        $pkg = [regex]::Replace($pkg, '("version"\s*:\s*")[^"]*(")', "`${1}$Version`${2}", 1)
        [System.IO.File]::WriteAllText($PKG_JSON, $pkg.TrimStart([char]0xFEFF), $utf8NoBom)
    }
    if (Test-Path $PKG_LOCK) {
        $pkgLock = [System.IO.File]::ReadAllText($PKG_LOCK, [System.Text.Encoding]::UTF8)
        $pkgLock = [regex]::Replace(
            $pkgLock,
            '("name"\s*:\s*"prynx"\s*,\s*"version"\s*:\s*")[^"]*(")',
            ('${1}' + $Version + '${2}')
        )
        [System.IO.File]::WriteAllText($PKG_LOCK, $pkgLock.TrimStart([char]0xFEFF), $utf8NoBom)
    }
    if (Test-Path $CARGO_TOML) {
        $cargo = [System.IO.File]::ReadAllText($CARGO_TOML, [System.Text.Encoding]::UTF8)
        # Chi dong [package] version dau file, khong dong dependency
        $cargo = [regex]::Replace($cargo, '(?m)^(version\s*=\s*")[^"]*(")', "`${1}$Version`${2}", 1)
        [System.IO.File]::WriteAllText($CARGO_TOML, $cargo.TrimStart([char]0xFEFF), $utf8NoBom)
    }
    if (Test-Path $CARGO_LOCK) {
        $cargoLock = [System.IO.File]::ReadAllText($CARGO_LOCK, [System.Text.Encoding]::UTF8)
        $cargoLock = [regex]::Replace(
            $cargoLock,
            '(?ms)(\[\[package\]\]\s*name = "pdf-inspector"\s*version = ")[^"]*(")',
            ('${1}' + $Version + '${2}')
        )
        [System.IO.File]::WriteAllText($CARGO_LOCK, $cargoLock.TrimStart([char]0xFEFF), $utf8NoBom)
    }
    Write-Host "  [OK] Da dat version=$Version (Tauri + npm + Cargo, gom ca lockfiles)" -ForegroundColor Green
}

# ---- Derive version from tauri.conf.json (single source of truth) ----
# tauri.conf.json giu SemVer (co the kem prerelease: 1.0.0-beta.9). Nhung Windows
# version resource (Nuitka --file-version/--product-version) BAT BUOC numeric 4 phan
# X.X.X.X -- chuoi "1.0.0-beta.9" se lam Nuitka bao loi. Anh xa so prerelease sang
# phan thu 4: 1.0.0-beta.9 -> 1.0.0.9 ; khong prerelease -> .0. Nho vay file .exe
# hien dung phien ban thay vi ket "1.0.0" nhu truoc (build_production.ps1 hardcode).
$APP_VERSION = "1.0.0"
$NUMERIC_VERSION = "1.0.0.0"
if (Test-Path $TAURI_CONF) {
    try {
        $confJson = Get-Content $TAURI_CONF -Raw | ConvertFrom-Json
        if ($confJson.version) {
            $APP_VERSION = [string]$confJson.version
            if ($APP_VERSION -match '^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9]+\.?(\d+))?') {
                $p4 = if ($Matches[4]) { $Matches[4] } else { "0" }
                $NUMERIC_VERSION = "$($Matches[1]).$($Matches[2]).$($Matches[3]).$p4"
            }
        }
    } catch {
        Write-Host "  WARNING: Cannot parse version from tauri.conf.json, using $APP_VERSION" -ForegroundColor Yellow
    }
}
Write-Host "  App version: $APP_VERSION (Windows resource: $NUMERIC_VERSION)" -ForegroundColor DarkGray

# Validate venv exists
if (-not (Test-Path $VENV_PYTHON)) {
    Write-Host "ERROR: Python venv not found at $VENV_PYTHON" -ForegroundColor Red

    Write-Host "  Run run_dev.bat first to create the venv." -ForegroundColor Yellow
    exit 1
}

# A stale venv can leave python.exe present while its base interpreter was removed.
& $VENV_PYTHON --version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Python venv exists but cannot start: $VENV_PYTHON" -ForegroundColor Red
    Write-Host "  Recreate backend\venv before building." -ForegroundColor Yellow
    exit 1
}

# Public release keeps the documented Python 3.11 ABI. Internal QA may exercise
# Python 3.12 explicitly, but that does not silently redefine the release contract.
$PYTHON_MM = (& $VENV_PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
if ($PYTHON_MM -eq '3.11') {
    Write-Host "  Python ABI: 3.11 (release contract)" -ForegroundColor Green
} elseif ($PYTHON_MM -eq '3.12' -and -not $Release) {
    Write-Host "  WARNING: Internal build uses Python 3.12; public release remains pinned to 3.11." -ForegroundColor Yellow
} elseif ($PYTHON_MM -eq '3.12') {
    throw "Release build requires Python 3.11; current venv is Python 3.12. Recreate backend\venv explicitly."
} else {
    throw "Unsupported Python ABI $PYTHON_MM. Internal build supports 3.11/3.12; release requires 3.11."
}

# Production builds must enforce the same Free/Pro entitlements in both layers.
# Explicit values here avoid silently shipping an unrestricted build when local
# .env files omit the rollout flags.
$env:VITE_FEATURE_GATING_ENABLED = "true"
$env:PRYNX_FEATURE_GATING_ENABLED = "true"
Write-Host "  Free/Pro feature gating: ENABLED (frontend + backend)" -ForegroundColor Green

# LOGO-REBUILD (audit 2026-08-09 §LR3.10): tính năng vẫn đang HOLD. Hai cờ
# được nung vào frontend/Tauri host cùng một giá trị để sidecar không thể mở lệch UI.
$env:VITE_LOGO_REBUILD_ENABLED = "false"
$env:PRYNX_LOGO_REBUILD_ENABLED = "false"
Write-Host "  Logo Rebuild release gate: HOLD (frontend + backend)" -ForegroundColor Yellow


# ---- Step 0: Full release QA gate -----------------------------------------
# The gate is executed after the native wheel is staged below. Running it here
# would validate whatever .pyd happens to be installed in the mutable dev venv.
if (-not $SkipPreflightQA) {
    if ($SkipNuitka) {
        # Internal convenience path only: no new wheel exists, so retain the old
        # behavior and test the active dev runtime instead of silently skipping QA.
        Write-Host "[0/5] Running internal QA against the active dev native runtime..." -ForegroundColor Yellow
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ROOT\scripts\run_release_qa.ps1"
        if ($LASTEXITCODE -ne 0) {
            throw "Internal regression gate failed while -SkipNuitka was active."
        }
        Write-Host "  Internal regression gate passed on the active dev runtime." -ForegroundColor Green
    } else {
        Write-Host "[0/5] Release QA queued for the staged native wheel." -ForegroundColor DarkGray
    }
} else {
    Write-Host "[0/5] Skipped ALL automated release tests (-SkipPreflightQA)." -ForegroundColor DarkGray
}

# ---- Step 1: Nuitka compile backend ----
if (-not $SkipNuitka) {
    Write-Host "[1/5] Compiling Python backend with Nuitka..." -ForegroundColor Yellow
    Write-Host "  Cache-aware build; first compile is slower. MSVC jobs: $NuitkaJobs." -ForegroundColor DarkGray

    if (-not (Test-PythonDistribution -Name "nuitka")) {
        Write-Host "  Installing Nuitka + dependencies..." -ForegroundColor DarkGray
        & $VENV_PYTHON -m pip install Nuitka==4.1.2 ordered-set==4.1.0 zstandard==0.25.0
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to install Nuitka" -ForegroundColor Red
            exit 1
        }
    }

    # Bundle the protected TypeScript engine before Rust include_str! embeds it.
    # This keeps the generator out of the WebView while preserving the existing
    # well-tested geometry implementation inside the native extension.
    Push-Location "$ROOT\desktop"
    if (-not (Test-Path "$ROOT\desktop\node_modules\.bin\vite.cmd")) {
        # RELEASE BUILD (audit 2026-07-27): npm ci cannot replace a live
        # node_modules tree while Vite holds native DLLs on Windows. Install the
        # lockfile in Temp, then copy only MISSING files back; existing/locked
        # files are never overwritten.
        $toolStageRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
            ("prynx-build-node-repair-" + [guid]::NewGuid().ToString("N"))
        $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
        $toolStageFull = [System.IO.Path]::GetFullPath($toolStageRoot)
        if (-not $toolStageFull.StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            Pop-Location
            throw "Frontend dependency staging path escaped Temp: $toolStageFull"
        }
        $toolStageDesktop = Join-Path $toolStageFull "desktop"
        New-Item -ItemType Directory -Path $toolStageDesktop | Out-Null
        try {
            Copy-Item -LiteralPath "$ROOT\desktop\package.json" -Destination $toolStageDesktop
            Copy-Item -LiteralPath "$ROOT\desktop\package-lock.json" -Destination $toolStageDesktop
            Push-Location $toolStageDesktop
            npm.cmd ci --no-audit --no-fund
            $npmRepairExit = $LASTEXITCODE
            Pop-Location
            if ($npmRepairExit -ne 0) {
                Pop-Location
                throw "Failed to install locked frontend dependencies in isolated staging."
            }

            & robocopy (Join-Path $toolStageDesktop "node_modules") `
                "$ROOT\desktop\node_modules" /E /XC /XN /XO /R:1 /W:1 `
                /NFL /NDL /NJH /NJS /NP
            $repairCopyExit = $LASTEXITCODE
            if ($repairCopyExit -gt 7) {
                Pop-Location
                throw "Failed to restore missing frontend dependencies (robocopy=$repairCopyExit)."
            }
        } finally {
            if (Test-Path -LiteralPath $toolStageFull) {
                Remove-Item -LiteralPath $toolStageFull -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not (Test-Path "$ROOT\desktop\node_modules\.bin\vite.cmd")) {
            Write-Host "ERROR: Vite is still missing after isolated dependency repair." -ForegroundColor Red
            Pop-Location
            exit 1
        }
    }
    npm.cmd run build:dieline-sidecar
    $dielineBundleExit = $LASTEXITCODE
    Pop-Location
    if ($dielineBundleExit -ne 0) {
        Write-Host "ERROR: Failed to build protected dieline engine" -ForegroundColor Red
        exit 1
    }

    # ============================================================
    #  Step 1a-pre: KHOA ENGINE DIELINE THEO BAN PHAT HANH (anticrack 2026-07-26)
    #
    #  Vi sao: truoc day viec kiem license cho engine dieline chi la mot ham tra
    #  Result<(), String> -> ke crack patch thanh Ok(()) la dung duoc. Nay engine bi
    #  MA HOA AES-256-GCM bang khoa RIENG cua tung ban phat hanh; khoa KHONG nam trong
    #  binary ma do edge function license-verify cap trong token da ky (claim "rk").
    #  Patch bo verify => khong co khoa => giai ma ra rac => engine khong nap duoc.
    #
    #  Release/prod builds are fail-closed. Plaintext is available only behind the
    #  explicit -AllowPlaintextDieline switch for local development diagnostics.
    # ============================================================
    $env:PRYNX_DIELINE_KEY_B64 = ""
    $env:PRYNX_DIELINE_VERSION = $APP_VERSION
    # SEC (audit 2026-08-03 §REL.SECRET): public release chỉ dùng sb_secret_
    # độc lập. service_role JWT cũ đã lộ và bị từ chối; sb_secret_ chỉ đi qua
    # header apikey, không gửi Authorization: Bearer vì nó không phải JWT.
    $releaseSupabaseSecret = [string]$script:CapturedReleaseSupabaseSecret
    $legacySupabaseServiceKey = [string]$script:CapturedLegacySupabaseServiceKey
    $secureReleaseSupabaseSecret = $null
    $secretStoreScript = Join-Path $ROOT "scripts\release_secret_store.ps1"
    if (-not (Test-Path -LiteralPath $secretStoreScript -PathType Leaf)) {
        throw "Thieu script hop dong kho khoa phat hanh: $secretStoreScript"
    }
    . $secretStoreScript
    $expectedReleaseSupabaseUrl = [string]$script:PrynXReleaseSupabaseUrl
    try {
    if ([string]::IsNullOrWhiteSpace($releaseSupabaseSecret) -and
        [string]::IsNullOrWhiteSpace($legacySupabaseServiceKey)) {
        $secretStorePath = Resolve-PrynXReleaseSecretStorePath
        if (Test-Path -LiteralPath $secretStorePath -PathType Leaf) {
            $secureReleaseSupabaseSecret = Get-PrynXReleaseSupabaseSecret -StorePath $secretStorePath
            $releaseSupabaseSecret = ConvertFrom-PrynXSecureString -SecureValue $secureReleaseSupabaseSecret
        }
    }
    if ($Release -and -not [string]::IsNullOrWhiteSpace($legacySupabaseServiceKey)) {
        throw "Release refuses legacy PRYNX_SUPABASE_SERVICE_KEY. Configure a rotated sb_secret_ key in the DPAPI store."
    }
    if (-not [string]::IsNullOrWhiteSpace($releaseSupabaseSecret) -and
        $releaseSupabaseSecret -notmatch '^sb_secret_[A-Za-z0-9_-]{20,}$') {
        throw "PRYNX_SUPABASE_SECRET_KEY is not a valid sb_secret_ key."
    }
    $useLegacyServiceKey = [string]::IsNullOrWhiteSpace($releaseSupabaseSecret) -and
        -not [string]::IsNullOrWhiteSpace($legacySupabaseServiceKey) -and -not $Release
    $releaseSupabaseUrlCandidate = if (-not [string]::IsNullOrWhiteSpace($env:PRYNX_SUPABASE_URL)) {
        [string]$env:PRYNX_SUPABASE_URL
    } else {
        $expectedReleaseSupabaseUrl
    }
    if ($Release) {
        try {
            $releaseSupabaseUri = [Uri]$releaseSupabaseUrlCandidate
            $expectedReleaseSupabaseUri = [Uri]$expectedReleaseSupabaseUrl
            $normalizedReleaseSupabaseUrl = $releaseSupabaseUri.AbsoluteUri.TrimEnd('/')
            $normalizedExpectedReleaseSupabaseUrl = $expectedReleaseSupabaseUri.AbsoluteUri.TrimEnd('/')
        } catch {
            throw "URL Supabase phat hanh phai khop project DPAPI da cau hinh va dung HTTPS."
        }
        if (-not $releaseSupabaseUri.IsAbsoluteUri -or
            $releaseSupabaseUri.Scheme -cne "https" -or
            -not [string]::IsNullOrWhiteSpace($releaseSupabaseUri.UserInfo) -or
            $normalizedReleaseSupabaseUrl -cne $normalizedExpectedReleaseSupabaseUrl) {
            throw "URL Supabase phat hanh phai khop project DPAPI da cau hinh va dung HTTPS."
        }
        # Public release luôn dùng URL đã khóa trong store sau khi xác minh input cũ.
        $releaseSupabaseUrl = $expectedReleaseSupabaseUrl
    } else {
        # Build nội bộ giữ khả năng trỏ tới Supabase/staging riêng của người phát triển.
        $releaseSupabaseUrl = $releaseSupabaseUrlCandidate
    }
    $lockDieline = $releaseSupabaseUrl -and
        (-not [string]::IsNullOrWhiteSpace($releaseSupabaseSecret) -or $useLegacyServiceKey)
    if (-not $lockDieline) {
        if ($Release -or -not $AllowPlaintextDieline) {
            throw "Missing PRYNX_SUPABASE_URL/PRYNX_SUPABASE_SECRET_KEY. Refusing an unlocked build. Use -AllowPlaintextDieline only for local development."
        }
        Write-Host "  WARNING: explicit development override enabled; dieline engine is plaintext." -ForegroundColor Yellow
    } else {
        if ($useLegacyServiceKey) {
            Write-Host "  WARNING: internal build is using deprecated service_role credentials." -ForegroundColor Yellow
            $keyHeaders = @{
                apikey        = $legacySupabaseServiceKey
                Authorization = "Bearer $legacySupabaseServiceKey"
            }
        } else {
            $keyHeaders = @{ apikey = $releaseSupabaseSecret }
        }
        $restBase = $releaseSupabaseUrl.TrimEnd('/')
        # Supabase chan sb_secret_ neu User-Agent giong browser. Windows
        # PowerShell mac dinh dung Mozilla/...WindowsPowerShell nen phai khai
        # bao ro day la backend release builder, khong phai renderer/client.
        $releaseBuilderUserAgent = "PrynX-Release-Builder/1.0"
        $encodedVersion = [Uri]::EscapeDataString($APP_VERSION)
        $keyUri = "$restBase/rest/v1/release_resource_keys?select=resource_key&product_id=eq.prynx&app_version=eq.$encodedVersion&resource=eq.dieline_engine&limit=2"

        try {
            # RELEASE BUILD (audit 2026-07-27): Windows PowerShell treats the
            # empty JSON array returned by Invoke-RestMethod as one non-enumerated
            # pipeline object when the call sits directly inside @(...). Assign
            # first, then normalize, otherwise "no row" looks like one blank row.
            $existingResponse = Invoke-RestMethod -Method Get -Uri $keyUri -Headers $keyHeaders `
                -UserAgent $releaseBuilderUserAgent -ErrorAction Stop
            $existingRows = @($existingResponse)
        } catch {
            throw "Cannot query the existing dieline resource key: $($_.Exception.Message)"
        }
        if ($existingRows.Count -gt 1) {
            throw "Multiple resource keys found for prynx/$APP_VERSION/dieline_engine. Refusing an ambiguous build."
        }

        if ($existingRows.Count -eq 1) {
            $keyB64 = [string]$existingRows[0].resource_key
            try { $decodedKey = [Convert]::FromBase64String($keyB64) } catch { $decodedKey = $null }
            if ($null -eq $decodedKey -or $decodedKey.Length -ne 32) {
                throw "Existing dieline resource key is malformed; refusing to rotate or overwrite it."
            }
            Write-Host "  Reusing immutable dieline resource key for version $APP_VERSION." -ForegroundColor Green
            $decodedKey = $null
        } else {
            $keyBytes = New-Object byte[] 32
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($keyBytes) } finally { $rng.Dispose() }
            $keyB64 = [Convert]::ToBase64String($keyBytes)
            $body = @{
                product_id   = "prynx"
                app_version  = $APP_VERSION
                resource     = "dieline_engine"
                resource_key = $keyB64
            } | ConvertTo-Json -Compress
            try {
                $null = Invoke-RestMethod -Method Post -Uri "$restBase/rest/v1/release_resource_keys" `
                    -Headers ($keyHeaders + @{
                        'Content-Type' = 'application/json'
                        Prefer = 'return=minimal'
                    }) -UserAgent $releaseBuilderUserAgent -Body $body -ErrorAction Stop
                Write-Host "  Created immutable dieline resource key for version $APP_VERSION." -ForegroundColor Green
            } catch {
                throw "Cannot create dieline resource key (existing keys are never overwritten): $($_.Exception.Message)"
            } finally {
                if ($keyBytes) { [Array]::Clear($keyBytes, 0, $keyBytes.Length) }
                $keyBytes = $null
            }
        }
        $env:PRYNX_DIELINE_KEY_B64 = $keyB64
    }
    } finally {
        # Không cho secret rò sang maturin/npm/Nuitka/Tauri và process con.
        $releaseSupabaseSecret = $null
        $legacySupabaseServiceKey = $null
        $script:CapturedReleaseSupabaseSecret = $null
        $script:CapturedLegacySupabaseServiceKey = $null
        if ($secureReleaseSupabaseSecret) { $secureReleaseSupabaseSecret.Dispose() }
        $secureReleaseSupabaseSecret = $null
        Remove-Item Env:PRYNX_SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:PRYNX_SUPABASE_SERVICE_KEY -ErrorAction SilentlyContinue
    }
    # ---- Step 1a: Build the Rust/Python native extension ----

    # Rebuild the Rust/Python extension for the active Python ABI on every full
    # production build. Reusing an extension from an older venv can make Nuitka
    # fail or silently ship stale native PDF logic.
    if (-not (Test-PythonDistribution -Name "maturin")) {
        Write-Host "  Installing Maturin..." -ForegroundColor DarkGray
        & $VENV_PYTHON -m pip install maturin==1.13.3
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to install Maturin" -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "  Building pdfcompare_native wheel for the active Python..." -ForegroundColor DarkGray
    $previousVirtualEnv = $env:VIRTUAL_ENV
    $env:VIRTUAL_ENV = "$ROOT\backend\venv"
    $previousPythonPath = $env:PYTHONPATH
    # RELEASE BUILD (audit 2026-07-27): never `maturin develop` into the live
    # venv. A running backend may hold the extension DLL open. Build/install to
    # an isolated staging path and put it first on PYTHONPATH for Nuitka.
    $nativeStageRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("prynx-native-stage-" + [guid]::NewGuid().ToString("N"))
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    $nativeStageFull = [System.IO.Path]::GetFullPath($nativeStageRoot)
    if (-not $nativeStageFull.StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Native staging path escaped Temp: $nativeStageFull"
    }
    $nativeWheelDir = Join-Path $nativeStageFull "wheels"
    $nativeSiteDir = Join-Path $nativeStageFull "site"
    New-Item -ItemType Directory -Path $nativeWheelDir | Out-Null
    New-Item -ItemType Directory -Path $nativeSiteDir | Out-Null
    # PERF (audit 2026-07 muc 5.7): bat SSE4.2+ baseline cho vong per-pixel Rust.
    # x86-64-v2 an toan cho CPU ~2009+ (Nehalem tro len) - may van phong cu van chay.
    $previousRustFlags = $env:RUSTFLAGS
    $env:RUSTFLAGS = "-C target-cpu=x86-64-v2"
    # PERF: LTO/CGU chi bat cho BAN DONG GOI qua env - Cargo.toml khong dat [profile.release]
    # de maturin develop --release trong run_dev.bat van build nhanh (dev loop khong cho LTO).
    $previousLto = $env:CARGO_PROFILE_RELEASE_LTO
    $previousCgu = $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS
    $previousStripSym = $env:CARGO_PROFILE_RELEASE_STRIP
    # BUILD (audit 2026-08-10 PPE.REAUDIT.7): pin identity for exactly this
    # native build. The staged module must echo these values via capabilities;
    # a stale wheel with the same crate version is rejected below.
    $nativeCommitOutput = @(& git -C $ROOT rev-parse HEAD 2>$null)
    $nativeCommitExit = $LASTEXITCODE
    if ($nativeCommitExit -ne 0 -or $nativeCommitOutput.Count -ne 1) {
        throw "Cannot resolve native source revision."
    }
    $script:PpeNativeSourceRevision = ([string]$nativeCommitOutput[0]).Trim().ToLowerInvariant()
    if ($script:PpeNativeSourceRevision -notmatch '^[0-9a-f]{40}$') {
        throw "Native source revision is invalid: $($script:PpeNativeSourceRevision)"
    }
    if ($Release -and $script:PpeNativeSourceRevision -ne $script:ReleaseSourceCommit) {
        throw "Native source revision no longer matches the captured release commit."
    }
    $nativeDirtyOutput = @(& git -C $ROOT status --porcelain=v1 --untracked-files=all 2>$null)
    $nativeDirtyExit = $LASTEXITCODE
    if ($nativeDirtyExit -ne 0) { throw "Cannot resolve native source dirty state." }
    $script:PpeNativeSourceDirty = $nativeDirtyOutput.Count -gt 0
    if ($Release -and $script:PpeNativeSourceDirty) {
        throw "Release native build refuses a dirty source tree."
    }
    $script:PpeNativeBuildTimestampUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $env:PRYNX_BUILD_SOURCE_REVISION = $script:PpeNativeSourceRevision
    $env:PRYNX_BUILD_SOURCE_DIRTY = if ($script:PpeNativeSourceDirty) { "true" } else { "false" }
    $env:PRYNX_BUILD_TIMESTAMP_UTC = $script:PpeNativeBuildTimestampUtc
    $env:PRYNX_BUILD_REQUIRE_CLEAN = if ($Release) { "true" } else { "false" }
    $env:CARGO_PROFILE_RELEASE_LTO = "thin"
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "1"
    $env:CARGO_PROFILE_RELEASE_STRIP = "symbols"
    & $VENV_PYTHON -m maturin build --release --interpreter $VENV_PYTHON `
        --manifest-path "$ROOT\native\Cargo.toml" --out $nativeWheelDir
    $nativeExit = $LASTEXITCODE
    if ($nativeExit -eq 0) {
        $nativeWheel = Get-ChildItem -LiteralPath $nativeWheelDir -Filter *.whl -File |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $nativeWheel) {
            $nativeExit = 1
        } else {
            & $VENV_PYTHON -m pip install --no-deps --target $nativeSiteDir $nativeWheel.FullName
            $nativeExit = $LASTEXITCODE
        }
    }
    if ($nativeExit -eq 0) {
        $env:PYTHONPATH = if ($previousPythonPath) {
            "$nativeSiteDir;$previousPythonPath"
        } else { $nativeSiteDir }
        # BUILD (audit 2026-08-10 §PPE.SCOPE.3): một cờ overprint không đại diện
        # cho toàn bộ ABI PPE. Artifact cũ từng có cờ đó nhưng thiếu Export CMYK,
        # subset composite và các điều khiển Output Preview. Chốt cả symbol lẫn
        # capability trước khi full QA để fail sớm trên đúng wheel staging.
        $ppeCapabilityGate = @(
            'import json, os, re',
            'import pdfcompare_native as n',
            'caps = dict(n.ppe_capabilities())',
            'required_symbols = {''PpeRenderSession'', ''ppe_separations'', ''ppe_compose_separation_subset'', ''ppe_softproof'', ''ppe_export_cmyk'', ''ppe_text_outlines'', ''ppe_capabilities'', ''combine_image_manifest_native''}',
            'required_flags = {''process_separations'', ''spot_separations'', ''separation_subset_composite'', ''overprint_preview_toggle'', ''text_outlines'', ''icc_color_management'', ''render_session'', ''softproof'', ''softproof_paper_color'', ''softproof_black_ink'', ''softproof_page_background'', ''softproof_viewport_clip''}',
            'expected_filters = {''all'', ''device-cmyk'', ''device-rgb'', ''device-gray'', ''spot'', ''text'', ''images'', ''line-art'', ''smooth-shades''}',
            'expected_oc_configs = {''print'', ''view''}',
            'expected_revision = os.environ.get(''PRYNX_BUILD_SOURCE_REVISION'', '''').lower()',
            'expected_dirty = os.environ.get(''PRYNX_BUILD_SOURCE_DIRTY'', '''').lower() == ''true''',
            'expected_timestamp = os.environ.get(''PRYNX_BUILD_TIMESTAMP_UTC'', '''')',
            'require_clean = os.environ.get(''PRYNX_BUILD_REQUIRE_CLEAN'', '''').lower() == ''true''',
            'missing_symbols = sorted(name for name in required_symbols if not hasattr(n, name))',
            'missing_flags = sorted(name for name in required_flags if caps.get(name) is not True)',
            'missing_filters = sorted(expected_filters - set(caps.get(''output_preview_filters'') or ()))',
            'missing_oc_configs = sorted(expected_oc_configs - set(caps.get(''optional_content_configs'') or ()))',
            'identity = {key: caps.get(key) for key in (''source_revision'', ''source_dirty'', ''build_timestamp_utc'', ''build_profile'', ''build_provenance'', ''build_identity'')}',
            'identity_problems = []',
            'if not re.fullmatch(r''[0-9a-f]{40}'', str(identity[''source_revision''] or '''').lower()): identity_problems.append(''unknown-source-revision'')',
            'if str(identity[''source_revision''] or '''').lower() != expected_revision: identity_problems.append(''source-revision-mismatch'')',
            'if identity[''source_dirty''] is not expected_dirty: identity_problems.append(''source-dirty-mismatch'')',
            'if require_clean and identity[''source_dirty''] is not False: identity_problems.append(''dirty-release-source'')',
            'if identity[''build_timestamp_utc''] != expected_timestamp: identity_problems.append(''build-timestamp-mismatch'')',
            'if identity[''build_profile''] != ''release'': identity_problems.append(''build-profile-not-release'')',
            'if identity[''build_provenance''] != ''build_production.ps1'': identity_problems.append(''untrusted-build-provenance'')',
            'if not re.fullmatch(r''[0-9a-f]{64}'', str(identity[''build_identity''] or '''').lower()): identity_problems.append(''invalid-build-identity'')',
            'problems = {''symbols'': missing_symbols, ''flags'': missing_flags, ''filters'': missing_filters, ''oc_configs'': missing_oc_configs, ''identity'': identity_problems}',
            'if any(problems.values()):',
            '    raise RuntimeError(f''Staged pdfcompare_native is missing the required PPE contract: {problems}'')',
            'print(json.dumps(identity, sort_keys=True))'
        ) -join "`n"
        $ppeCapabilityOutput = @(& $VENV_PYTHON -c $ppeCapabilityGate)
        $nativeExit = $LASTEXITCODE
        if ($nativeExit -eq 0) {
            if ($ppeCapabilityOutput.Count -ne 1) {
                $nativeExit = 1
            } else {
                try {
                    $ppeNativeIdentity = ([string]$ppeCapabilityOutput[0]) | ConvertFrom-Json
                    $script:PpeNativeBuildIdentity = [string]$ppeNativeIdentity.build_identity
                    $script:PpeNativeBuildProfile = [string]$ppeNativeIdentity.build_profile
                    $script:PpeNativeBuildProvenance = [string]$ppeNativeIdentity.build_provenance
                } catch {
                    $nativeExit = 1
                }
            }
        }
        if ($nativeExit -eq 0) {
            $nativePydCandidates = @(Get-ChildItem -LiteralPath "$nativeSiteDir\pdfcompare_native" `
                -Filter "*.pyd" -File -ErrorAction SilentlyContinue)
            if ($nativePydCandidates.Count -ne 1) {
                $nativeExit = 1
            } else {
                $script:PpeNativeSha256 = (Get-FileHash -LiteralPath $nativePydCandidates[0].FullName `
                    -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    }
    if ($null -eq $previousRustFlags) { Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue }
    else { $env:RUSTFLAGS = $previousRustFlags }
    if ($null -eq $previousLto) { Remove-Item Env:CARGO_PROFILE_RELEASE_LTO -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_LTO = $previousLto }
    if ($null -eq $previousCgu) { Remove-Item Env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = $previousCgu }
    if ($null -eq $previousStripSym) { Remove-Item Env:CARGO_PROFILE_RELEASE_STRIP -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_STRIP = $previousStripSym }
    if ($null -eq $previousVirtualEnv) { Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue }
    else { $env:VIRTUAL_ENV = $previousVirtualEnv }
    # Xoa khoa khoi moi truong NGAY sau khi maturin dung xong: cac buoc sau (Nuitka,
    # Tauri, NSIS) khong duoc thay khoa, va khong de khoa roi vao log/child process.
    $script:DIELINE_LOCKED = if ($env:PRYNX_DIELINE_KEY_B64) { "yes" } else { "no" }
    Remove-Item Env:PRYNX_DIELINE_KEY_B64 -ErrorAction SilentlyContinue
    if ($nativeExit -ne 0) {
        if ($null -eq $previousPythonPath) { Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue }
        else { $env:PYTHONPATH = $previousPythonPath }
        if (Test-Path -LiteralPath $nativeStageFull) {
            Remove-Item -LiteralPath $nativeStageFull -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Host "ERROR: Failed to build/stage pdfcompare_native" -ForegroundColor Red
        exit 1
    }

    # requirements.txt pin onnxruntime CPU (CI Ubuntu + dev da nen -- directml
    # ---- Step 1b: GPU (DirectML) onnxruntime cho ban Windows ship ----
    # KHONG co wheel Linux). Ban Windows ship can DirectML de TU bat GPU (DX12:
    # NVIDIA/AMD/Intel), CPU fallback tu dong -- KHONG can khach cai CUDA/cuDNN.
    # Do thuc (RTX 3060, 1024x1024): isnet ~10x, birefnet-lite ~1.7x so voi CPU.
    if (-not (Test-PythonDistribution -Name "onnxruntime-directml")) {
        Write-Host "  Installing onnxruntime-directml (GPU) into build venv..." -ForegroundColor DarkGray
        if (Test-PythonDistribution -Name "onnxruntime") {
            & $VENV_PYTHON -m pip uninstall -y onnxruntime
            if ($LASTEXITCODE -ne 0) {
                Write-Host "ERROR: Failed to remove CPU onnxruntime before DirectML install" -ForegroundColor Red
                exit 1
            }
        }
        & $VENV_PYTHON -m pip install -r "$ROOT\backend\requirements-win-gpu.txt"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to install onnxruntime-directml" -ForegroundColor Red
            exit 1
        }
    }

    New-Item -ItemType Directory -Force -Path $SIDECAR_DIR | Out-Null

    Push-Location "$ROOT\backend"

    # --- Locate pdfium.dll for pdfcompare_native (Rust PyO3 module) ---
    # The native module needs pdfium.dll at runtime for PDF operations.
    $PDFIUM_DLL = "$ROOT\native\pdfium.dll"
    $PDFIUM_FLAG = ""
    if (Test-Path $PDFIUM_DLL) {
        $PDFIUM_FLAG = "--include-data-files=$PDFIUM_DLL=pdfium.dll"
        Write-Host "  pdfium.dll found: $PDFIUM_DLL" -ForegroundColor DarkGray
    } else {
        Write-Host "ERROR: pdfium.dll not found at $PDFIUM_DLL" -ForegroundColor Red
        Write-Host "  pdfcompare_native REQUIRES pdfium.dll at runtime (core PDF ops)." -ForegroundColor Red
        Write-Host "  Build aborted to avoid shipping a broken artifact." -ForegroundColor Red
        Pop-Location
        exit 1
    }

    # DirectML.dll cua onnxruntime-directml -- dam bao Nuitka onefile gom kem (GPU EP).
    # Neu khong co (venv CPU-only) -> bo qua, chay CPU binh thuong (khong loi).
    $DML_FLAG = ""
    $dmlPath = (& $VENV_PYTHON -c "import os,onnxruntime as o;p=os.path.join(os.path.dirname(o.__file__),'capi','DirectML.dll');print(p if os.path.exists(p) else '')").Trim()
    if ($dmlPath -and (Test-Path $dmlPath)) {
        $DML_FLAG = "--include-data-files=$dmlPath=onnxruntime/capi/DirectML.dll"
        Write-Host "  DirectML.dll bundled (GPU): $dmlPath" -ForegroundColor DarkGray
    } else {
        if ($Release) {
            Pop-Location
            throw "Release build requires DirectML.dll from onnxruntime-directml."
        }
        Write-Host "  DirectML.dll not found (onnxruntime CPU) - shipping CPU inference." -ForegroundColor DarkGray
    }

    # ---- Model Real-ESRGAN (upscale): convert .pth -> .onnx roi bundle vao exe ----
    # KHAC isnet/birefnet (tai runtime tu URL): repo goc xinntao CHI phat hanh .pth nen
    # KHONG co URL .onnx de tai. Phai convert san (scripts/convert_realesrgan_onnx.py,
    # can torch) roi gom .onnx vao app/data/models -> engine doc tu do (fallback sau
    # ~/.u2net). torch CHI o may build, KHONG bundle (app runtime chi import onnxruntime).
    $UPSCALE_MODELS_FLAG = ""
    $SOURCE_MODELS_DIR = "$ROOT\backend\app\data\models"
    $PACKAGED_MODELS_DIR = Join-Path $nativeStageFull "models"
    New-Item -ItemType Directory -Force -Path $PACKAGED_MODELS_DIR | Out-Null
    $SOURCE_GEN_ONNX = "$SOURCE_MODELS_DIR\realesr-general-x4v3.onnx"
    $SOURCE_QUALITY_ONNX = "$SOURCE_MODELS_DIR\realesrgan-x4plus.onnx"
    $SOURCE_ISNET_ONNX = "$SOURCE_MODELS_DIR\isnet-general-use.onnx"
    $GEN_ONNX = "$PACKAGED_MODELS_DIR\realesr-general-x4v3.onnx"
    $QUALITY_ONNX = "$PACKAGED_MODELS_DIR\realesrgan-x4plus.onnx"
    $ISNET_ONNX = "$PACKAGED_MODELS_DIR\isnet-general-use.onnx"
    $EXPECTED_ISNET_SHA256 = "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"
    # RELEASE (audit 2026-07-28 §BG.02): luôn bundle model Nhanh để Tách nền
    # hoạt động offline ngay lần đầu. Helper tải `.part`, kiểm hash rồi rename atomic.
    # BUILD (audit 2026-08-03 REL.06): prepare the bundle under Temp. A public
    # release must not download/copy generated data into its clean source tree.
    $resolvedIsnet = $SOURCE_ISNET_ONNX
    if (-not (Test-Path $resolvedIsnet) -or
        (Get-FileHash -LiteralPath $resolvedIsnet -Algorithm SHA256).Hash.ToLowerInvariant() -ne $EXPECTED_ISNET_SHA256) {
        $resolvedIsnet = (& $VENV_PYTHON -c "from app.workers.isnet_engine import _download_model_if_needed; print(_download_model_if_needed())").Trim()
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $resolvedIsnet)) {
            Write-Host "ERROR: Cannot prepare verified ISNet model for offline bundle." -ForegroundColor Red
            Pop-Location
            exit 1
        }
    }
    Copy-Item -LiteralPath $resolvedIsnet -Destination $ISNET_ONNX -Force
    $actualIsnetHash = (Get-FileHash -LiteralPath $ISNET_ONNX -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualIsnetHash -ne $EXPECTED_ISNET_SHA256) {
        Write-Host "ERROR: ISNet model SHA-256 mismatch: $actualIsnetHash" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    if (-not (Test-Path $SOURCE_GEN_ONNX) -or -not (Test-Path $SOURCE_QUALITY_ONNX)) {
        # Try conversion when the build venv has torch.
        & $VENV_PYTHON -c "import torch" *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Converting Real-ESRGAN .pth -> .onnx (build-time)..." -ForegroundColor DarkGray
            # UPSCALE (audit 2026-07-29 SNET.02): truyen --alpha TUONG MINH. alpha la
            # denoise_strength cua upstream: 0 = khu nhieu yeu (giu hat), 1 = manh nhat.
            # Chot 0.5 = mac dinh upstream (truoc day de default 1.0 = khu nhieu manh
            # nhat, chinh la nguyen nhan do duoc cua cam giac anh "bet").
            # Doi so nay PHAI cap nhat EXPECTED_UPSCALE_SHA256 ben duoi,
            # realesrgan_engine.MODEL_SHA256, scripts/bundled_components.json,
            # THIRD_PARTY_NOTICES.md va do lai corpus.
            & $VENV_PYTHON "$ROOT\backend\scripts\convert_realesrgan_onnx.py" --out "$PACKAGED_MODELS_DIR" --model all --alpha 0.5
        } else {
            Write-Host "  torch not in build venv; cannot generate the required upscale model." -ForegroundColor Yellow
        }
    } else {
        Copy-Item -LiteralPath $SOURCE_GEN_ONNX -Destination $GEN_ONNX -Force
        Copy-Item -LiteralPath $SOURCE_QUALITY_ONNX -Destination $QUALITY_ONNX -Force
    }
    if ((Test-Path $GEN_ONNX) -and (Test-Path $QUALITY_ONNX)) {
        $UPSCALE_MODELS_FLAG = "--include-data-dir=$PACKAGED_MODELS_DIR=app/data/models"
        Write-Host "  AI models staged for bundle: $PACKAGED_MODELS_DIR" -ForegroundColor DarkGray
        # RELEASE QA (audit 2026-07-28 §UP-05/11): khóa đúng model đã benchmark.
        # UPSCALE (audit 2026-07-29 §NET.02): hash doi vi model general chuyen sang
        # DNI alpha 0.5. Hash cu (alpha 1.0): 027319ffe4f00ec2550957c0957d44969638a03d2ed2f0329af9fd6cd44a457a
        #
        # LUU Y (do duoc 2026-07-29): export .onnx KHONG byte-reproducible giua cac
        # ban torch/onnx — convert lai dung alpha 1.0 tren torch 2.6.0+cpu / onnx
        # 1.17.0 cho trong so GIONG HET (lech 0.0000 muc mau) nhung hash khac.
        # Vi .onnx duoc commit vao git nen buoc convert o tren chi chay khi file
        # BIEN MAT; neu no chay that thi hash se lech va build dung o day. Khi do
        # phai do lai chat luong roi cap nhat hash o CA BA cho (day,
        # realesrgan_engine.MODEL_SHA256, scripts/bundled_components.json).
        $EXPECTED_UPSCALE_SHA256 = "3ae50bb3a9131697d62ac79f934e57c2ef9cd3b8762993ca0d1fabd8a36a343f"
        $actualUpscaleHash = (Get-FileHash -LiteralPath $GEN_ONNX -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualUpscaleHash -ne $EXPECTED_UPSCALE_SHA256) {
            Write-Host "ERROR: Real-ESRGAN model SHA-256 mismatch: $actualUpscaleHash" -ForegroundColor Red
            Pop-Location
            exit 1
        }
        $EXPECTED_QUALITY_SHA256 = "c1b85fae35947577b4c4b7d310af54546c6e7971f14a0862a769e83689ddc003"
        $actualQualityHash = (Get-FileHash -LiteralPath $QUALITY_ONNX -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualQualityHash -ne $EXPECTED_QUALITY_SHA256) {
            Write-Host "ERROR: RealESRGAN_x4plus SHA-256 mismatch: $actualQualityHash" -ForegroundColor Red
            Pop-Location
            exit 1
        }
        & $VENV_PYTHON -c "from app.workers.realesrgan_engine import warmup; raise SystemExit(0 if warmup('general') and warmup('quality') else 1)"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Real-ESRGAN bundled-model smoke inference failed." -ForegroundColor Red
            Pop-Location
            exit 1
        }
        & $VENV_PYTHON -c "from app.workers.isnet_engine import warmup; raise SystemExit(0 if warmup() else 1)"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Bundled ISNet smoke inference failed." -ForegroundColor Red
            Pop-Location
            exit 1
        }
    } else {
        Write-Host "ERROR: Real-ESRGAN model absent: $GEN_ONNX or $QUALITY_ONNX" -ForegroundColor Red
        Write-Host "  Build aborted to avoid shipping a broken AI Upscale feature." -ForegroundColor Red
        Pop-Location
        exit 1
    }

    # Fail fast before the expensive C backend. These are the runtime slices we
    # intentionally keep after removing broad SciPy/ONNX helper trees.
    Write-Host "  Verifying frozen-runtime imports..." -ForegroundColor DarkGray
    & $VENV_PYTHON -c "import scipy.ndimage; import skimage.metrics; import skimage.measure; import onnxruntime; from fontTools import subset; from fontTools.ttLib import TTFont"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Required runtime dependency import failed before Nuitka." -ForegroundColor Red
        Pop-Location
        exit 1
    }

    if (-not $SkipPreflightQA) {
        # BUILD (audit 2026-08-03 REL.09): PYTHONPATH already points at the wheel
        # built above. The child gate also proves pdfcompare_native resolves under
        # this exact staging directory before it runs backend/no-GS coverage.
        Write-Host "[0/5] Running full release QA against the staged native wheel..." -ForegroundColor Yellow
        $nativePydCandidates = @(Get-ChildItem -LiteralPath "$nativeSiteDir\pdfcompare_native" `
            -Filter "*.pyd" -File -ErrorAction SilentlyContinue)
        if ($nativePydCandidates.Count -ne 1) {
            throw "Expected exactly one staged pdfcompare_native .pyd; found $($nativePydCandidates.Count)."
        }
        $nativeQaId = (Get-FileHash -LiteralPath $nativePydCandidates[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0, 16)
        $buildNoGsAuditOut = Join-Path $ROOT "tmp\release_no_gs_audit-native-$nativeQaId.json"
        $previousReleaseNativeSite = $env:PRYNX_RELEASE_NATIVE_SITE
        $previousNoGsAuditOut = $env:PRYNX_NO_GS_AUDIT_OUT
        $env:PRYNX_RELEASE_NATIVE_SITE = $nativeSiteDir
        $env:PRYNX_NO_GS_AUDIT_OUT = $buildNoGsAuditOut
        try {
            if ($ReusePassedNoGs) {
                & powershell.exe -NoProfile -ExecutionPolicy Bypass `
                    -File "$ROOT\scripts\run_release_qa.ps1" -ReusePassedNoGs
            } else {
                & powershell.exe -NoProfile -ExecutionPolicy Bypass `
                    -File "$ROOT\scripts\run_release_qa.ps1"
            }
            $releaseQaExit = $LASTEXITCODE
        } finally {
            if ($null -eq $previousReleaseNativeSite) {
                Remove-Item Env:PRYNX_RELEASE_NATIVE_SITE -ErrorAction SilentlyContinue
            } else {
                $env:PRYNX_RELEASE_NATIVE_SITE = $previousReleaseNativeSite
            }
            if ($null -eq $previousNoGsAuditOut) {
                Remove-Item Env:PRYNX_NO_GS_AUDIT_OUT -ErrorAction SilentlyContinue
            } else {
                $env:PRYNX_NO_GS_AUDIT_OUT = $previousNoGsAuditOut
            }
        }
        if ($releaseQaExit -ne 0) {
            if ($null -eq $previousPythonPath) { Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue }
            else { $env:PYTHONPATH = $previousPythonPath }
            if (Test-Path -LiteralPath $nativeStageFull) {
                Remove-Item -LiteralPath $nativeStageFull -Recurse -Force -ErrorAction SilentlyContinue
            }
            Pop-Location
            throw "Release regression gate failed against the staged native wheel."
        }
        Write-Host "  Full release regression gate passed on the staged native wheel." -ForegroundColor Green
    }

    # MSVC /Ox exhausts compiler heap on some large Nuitka-generated modules.
    # Keep /O1 for generated Python C code. D9025 la command-line diagnostic,
    # khong phai C warning; /wd9025 chi sinh them D9014 tren moi C file.
    $previousClAppend = $env:_CL_
    $env:_CL_ = if ([string]::IsNullOrWhiteSpace($previousClAppend)) { "/O1" } else { "$previousClAppend /O1" }
    & $VENV_PYTHON -m nuitka `
        --standalone `
        --jobs=$NuitkaJobs `
        --no-prefer-source-code `
        --onefile `
        --onefile-tempdir-spec="{CACHE_DIR}\PrynX\sidecar-{VERSION}" `
        --output-filename="$SIDECAR_NAME.exe" `
        --output-dir="$SIDECAR_DIR" `
        --include-package=app `
        --include-package=uvicorn `
        --include-package=fastapi `
        --include-package=pikepdf `
        --include-package=reportlab `
        --include-package=cv2 `
        --include-package=numpy `
        --include-package=PIL `
        --include-package=pypdfium2 `
        --include-package=pydantic `
        --include-package=pydantic_settings `
        --include-package=httpx `
        --include-package=cryptography `
        --include-package=sqlalchemy `
        --include-package=starlette `
        --include-package=pdfcompare_native `
        --include-package=segno `
        --include-package=redis `
        --include-package=aiofiles `
        --include-package=multipart `
        --include-package=shapely `
        --include-package=skimage.metrics `
        --include-package=skimage.measure `
        --include-package=scipy.ndimage `
        --include-package=pdfplumber `
        --include-package=pytesseract `
        --include-package=celery `
        --include-package=pypdf `
        --include-package=uharfbuzz `
        --include-module=onnxruntime `
        --include-package=onnxruntime.capi `
        --include-package-data=onnxruntime `
        --include-package=openpyxl `
        --include-package=serial `
        --include-data-dir=app/assets=app/assets `
        --include-data-dir=app/workers/cut_export/profiles=app/workers/cut_export/profiles `
        $PDFIUM_FLAG `
        $DML_FLAG `
        $UPSCALE_MODELS_FLAG `
        --nofollow-import-to=tkinter `
        --nofollow-import-to=unittest `
        --nofollow-import-to=pytest `
        --nofollow-import-to=hypothesis `
        --nofollow-import-to=*.tests `
        --nofollow-import-to=sympy `
        --nofollow-import-to=onnxruntime.tools `
        --nofollow-import-to=scipy.special._precompute `
        --nofollow-import-to=scipy.interpolate._interpnd_info `
        --nofollow-import-to=sqlalchemy.testing `
        --nofollow-import-to=fontTools.pens.momentsPen `
        --noinclude-pytest-mode=nofollow `
        --noinclude-unittest-mode=nofollow `
        --nofollow-import-to=test `
        --nofollow-import-to=pip `
        --nofollow-import-to=setuptools `
        --nofollow-import-to=torch `
        --nofollow-import-to=torchvision `
        --nofollow-import-to=torchaudio `
        --nofollow-import-to=basicsr `
        --nofollow-import-to=realesrgan `
        --windows-console-mode=disable `
        --remove-output `
        --assume-yes-for-downloads `
        --company-name="PrynX" `
        --product-name="PrynX Backend" `
        --file-version="$NUMERIC_VERSION" `
        --product-version="$NUMERIC_VERSION" `
        --file-description="PrynX PDF Processing Engine" `
        app\main.py

    $nuitkaExit = $LASTEXITCODE
    if ($null -eq $previousClAppend) { Remove-Item Env:_CL_ -ErrorAction SilentlyContinue }
    else { $env:_CL_ = $previousClAppend }
    if ($null -eq $previousPythonPath) { Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue }
    else { $env:PYTHONPATH = $previousPythonPath }
    if (Test-Path -LiteralPath $nativeStageFull) {
        Remove-Item -LiteralPath $nativeStageFull -Recurse -Force -ErrorAction SilentlyContinue
    }
    Pop-Location

    if ($nuitkaExit -ne 0) {
        Write-Host "ERROR: Nuitka compilation failed!" -ForegroundColor Red
        $crashReport = Join-Path $ROOT "backend\nuitka-crash-report.xml"
        if (Test-Path -LiteralPath $crashReport) {
            $heapError = Select-String -Path $crashReport -Pattern "fatal error C1002" -SimpleMatch |
                Select-Object -First 1
            if ($heapError) {
                Write-Host "  MSVC compiler heap failure detected. Do not rerun unchanged." -ForegroundColor Yellow
                Write-Host "  Crash report: $crashReport" -ForegroundColor Yellow
            }
        }
        exit 1
    }
    Write-Host "  Backend compiled successfully." -ForegroundColor Green
}

if ($NuitkaOnly) {
    Write-Host "`nDone (Nuitka only)." -ForegroundColor Green
    exit 0
}

# ---- Step 2: Prepare sidecar and dependencies ----
Write-Host "`n[2/5] Preparing sidecar binary and external dependencies..." -ForegroundColor Yellow

$SIDECAR_SRC = "$SIDECAR_DIR\$SIDECAR_NAME.exe"
$TARGET_TRIPLE = "x86_64-pc-windows-msvc"
$SIDECAR_FINAL = "$SIDECAR_DIR\$SIDECAR_NAME-$TARGET_TRIPLE.exe"

if (Test-Path $SIDECAR_SRC) {
    Copy-Item -Force $SIDECAR_SRC $SIDECAR_FINAL
    Write-Host "  Sidecar: $SIDECAR_FINAL" -ForegroundColor Green
} elseif (Test-Path $SIDECAR_FINAL) {
    Write-Host "  Sidecar already exists: $SIDECAR_FINAL" -ForegroundColor Green
} else {
    Write-Host "ERROR: Sidecar binary not found!" -ForegroundColor Red
    exit 1
}

# GS-SUNSET (audit 2026-08-08 GS-C1): Ghostscript khong con la dependency hay
# resource cua san pham. Tripwire nay chi KIEM TRA staging va fail-closed; build
# khong tu dong xoa dau vet de tranh che lap payload ban tu lan build cu.
$legacyGhostscriptDir = Join-Path $SIDECAR_DIR "gs"
$forbiddenGhostscriptPayload = @(Get-ChildItem -LiteralPath $SIDECAR_DIR -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -match '^(?:gs(?:win(?:32|64)c?)?\.exe|gsdll\d*\.dll)$'
    })
if ((Test-Path -LiteralPath $legacyGhostscriptDir) -or $forbiddenGhostscriptPayload.Count -gt 0) {
    Write-Host "ERROR: Ghostscript payload detected in Tauri staging." -ForegroundColor Red
    Write-Host "  Remove the stale binaries\gs directory/files, then rebuild from clean staging." -ForegroundColor Yellow
    Write-Host "  Build aborted to preserve the PPE-only release contract." -ForegroundColor Red
    exit 1
}
Write-Host "  Ghostscript payload absent (PPE-only release contract)." -ForegroundColor Green

# Copy Tesseract
$TESS_SRC = "C:\Program Files\Tesseract-OCR"
$TESS_DEST = "$SIDECAR_DIR\tesseract"
if (Test-Path $TESS_SRC) {
    Write-Host "  Copying Tesseract-OCR..." -ForegroundColor DarkGray
    New-Item -ItemType Directory -Force -Path $TESS_DEST | Out-Null
    Copy-DirectoryWithRetry -SourcePattern "$TESS_SRC\*" -Destination $TESS_DEST
    # Prune training/utility tools: app chi CHAY OCR (tesseract.exe), khong huan luyen.
    # Xoa ~42MB exe training (lstmtraining, text2image, mftraining...) + uninstaller.
    # GIU tesseract.exe + moi DLL (libtesseract, leptonica, icu) + tessdata/.
    $tessKeepExe = "tesseract.exe"
    Get-ChildItem -Path $TESS_DEST -Filter *.exe -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $tessKeepExe } | Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Host "  Tesseract bundled (pruned training tools)." -ForegroundColor Green
} else {
    Write-Host "ERROR: Tesseract not found at $TESS_SRC." -ForegroundColor Red
    Write-Host "  Build aborted to avoid shipping a broken OCR feature." -ForegroundColor Red
    exit 1
}

# ---- Third-party notices ----
# Sinh lai NOTICE tu lockfile THAT o moi lan build. Ly do: NOTICE viet tay se lac
# hau ngay sau lan `pip install` / `npm i` ke tiep, va mot NOTICE sai con te hon
# khong co -- no la tuyen bo bang van ban rang ta da kiem ma thuc ra chua.
# Danh sach thanh phan phai khop dung payload dang dong goi; component khai
# `bundled=false` duoc generator loai tu dong.
Write-Host "  Generating THIRD_PARTY_NOTICES.md..." -ForegroundColor DarkGray
if (-not (Test-Path -LiteralPath $VENV_PYTHON -PathType Leaf)) {
    Write-Host "ERROR: Khong tim thay $VENV_PYTHON de sinh NOTICE." -ForegroundColor Red
    exit 1
}
$noticeArgs = @("$ROOT\scripts\gen_third_party_notices.py")
$env:PYTHONIOENCODING = "utf-8"
& $VENV_PYTHON @noticeArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Khong sinh duoc THIRD_PARTY_NOTICES.md." -ForegroundColor Red
    Write-Host "  Khong phat hanh khi chua co danh muc ghi cong hop le." -ForegroundColor Red
    exit 1
}
# Dua NOTICE vao bundle (tauri.conf.json khai resource "THIRD_PARTY_NOTICES.md").
Copy-Item -Force "$ROOT\THIRD_PARTY_NOTICES.md" "$ROOT\desktop\src-tauri\THIRD_PARTY_NOTICES.md"
Write-Host "  THIRD_PARTY_NOTICES.md generated and staged for bundle." -ForegroundColor Green

$requiredBundleFiles = @(
    "$ROOT\desktop\src-tauri\bin\pdfium.dll",
    "$ROOT\desktop\src-tauri\installer-hooks.nsh",
    "$ROOT\desktop\src-tauri\icons\icon.ico"
)
foreach ($requiredFile in $requiredBundleFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        Write-Host "ERROR: Required Tauri bundle file missing: $requiredFile" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  Required Tauri resources verified." -ForegroundColor Green

# ---- Step 3: Compute SHA-256 hash for integrity verification ----
Write-Host "`n[3/5] Computing sidecar integrity hash..." -ForegroundColor Yellow

$HASH = (Get-FileHash $SIDECAR_FINAL -Algorithm SHA256).Hash.ToLower()
Write-Host "  PRYNX_SIDECAR_HASH = $HASH" -ForegroundColor Green

# ---- Step 4: Build Tauri installer ----
if (-not $SkipTauri) {
    Write-Host "`n[4/5] Building frontend + computing integrity hash..." -ForegroundColor Yellow

    # BUILD (audit 2026-08-04 BLD.02): manifest khong duoc tu khai gate=enabled
    # neu process thuc te da bi mot script/agent khac doi co truoc luc Vite bundle.
    if ([string]$env:VITE_FEATURE_GATING_ENABLED -ne "true" -or
        [string]$env:PRYNX_FEATURE_GATING_ENABLED -ne "true" -or
        [string]$env:VITE_LOGO_REBUILD_ENABLED -ne "false" -or
        [string]$env:PRYNX_LOGO_REBUILD_ENABLED -ne "false") {
        throw "Production frontend/backend feature gates must stay synchronized before bundling."
    }

    Push-Location "$ROOT\desktop"
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Frontend build failed!" -ForegroundColor Red
        Pop-Location
        exit 1
    }

    npm.cmd run check:dieline-webview
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Protected dieline engine leaked into frontend bundle!" -ForegroundColor Red
        Pop-Location
        exit 1
    }

    # Compute frontend hash - ALL files in dist/ (must match Rust sha256_directory)
    $DIST_DIR = "$ROOT\desktop\dist"
    if (Test-Path $DIST_DIR) {
        Write-Host "  Hashing entire dist/ directory..." -ForegroundColor DarkGray
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $allFiles = Get-ChildItem -Path $DIST_DIR -Recurse -File | Sort-Object { $_.FullName.Substring($DIST_DIR.Length) }
        foreach ($f in $allFiles) {
            $relPath = $f.FullName.Substring($DIST_DIR.Length + 1).Replace('\', '/')
            $pathBytes = [System.Text.Encoding]::UTF8.GetBytes($relPath)
            $sha.TransformBlock($pathBytes, 0, $pathBytes.Length, $pathBytes, 0) | Out-Null
            $fileBytes = [System.IO.File]::ReadAllBytes($f.FullName)
            $sha.TransformBlock($fileBytes, 0, $fileBytes.Length, $fileBytes, 0) | Out-Null
        }
        $sha.TransformFinalBlock(@(), 0, 0) | Out-Null
        $FRONTEND_HASH = [BitConverter]::ToString($sha.Hash).Replace('-', '').ToLower()
        Write-Host "  PRYNX_FRONTEND_HASH = $FRONTEND_HASH ($($allFiles.Count) files)" -ForegroundColor Green
        $env:PRYNX_FRONTEND_HASH = $FRONTEND_HASH
    } else {
        Write-Host "  WARNING: dist/ not found, skipping frontend hash." -ForegroundColor Yellow
    }
    Pop-Location

    Write-Host "`n[5/5] Building Tauri installer..." -ForegroundColor Yellow

    $env:PRYNX_SIDECAR_HASH = $HASH
    $env:DEV_MODE = "false"

    # Re-check after generators/tests and immediately before the public bundle.
    Assert-ReleaseSourceState
    # -Release: tao installer truoc, sau do ky updater bang signer rieng de ho tro
    # khoa co mat khau rong ma khong de Tauri build dung cho prompt tuong tac.
    # Default: externalBin-only config (manual installer, no signing required).
    $tauriConfig = if ($Release) { "src-tauri/tauri.release.conf.json" } else { "src-tauri/tauri.prod.conf.json" }
    $nsisDir = "$ROOT\desktop\src-tauri\target\release\bundle\nsis"
    $installerNamePattern = '^.+_' + [regex]::Escape($APP_VERSION) + '_.*-setup\.exe$'
    $installersBeforeBuild = @{}
    if (Test-Path -LiteralPath $nsisDir -PathType Container) {
        foreach ($oldInstaller in @(Get-ChildItem -LiteralPath $nsisDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match $installerNamePattern })) {
            $installersBeforeBuild[$oldInstaller.FullName.ToLowerInvariant()] = @{
                Length = $oldInstaller.Length
                LastWriteTimeUtc = $oldInstaller.LastWriteTimeUtc
            }
        }
    }
    # BUILD (audit 2026-08-03 REL.10): installer stale khong duoc tinh la output cua lan build nay.
    $tauriBuildStartedAtUtc = [DateTime]::UtcNow
    if ($Release -and
        [string]::IsNullOrWhiteSpace($script:CapturedTauriSigningPrivateKey) -and
        [string]::IsNullOrWhiteSpace($script:CapturedTauriSigningKeyFile)) {
        $script:CapturedTauriSigningPrivateKey = $null
        $script:CapturedTauriSigningKeyFile = $null
        $script:CapturedTauriSigningPrivateKeyPassword = $null
        throw "Build phat hanh can khoa ky updater. Hay dung launcher doc ~/.tauri/prynx.key."
    }
    # PERF (audit 2026-07 muc 5.7): target-cpu baseline nhu buoc native (SSE4.2+).
    $previousRustFlags = $env:RUSTFLAGS
    $env:RUSTFLAGS = "-C target-cpu=x86-64-v2"
    # PERF: LTO/CGU chi bat cho BAN DONG GOI qua env - Cargo.toml khong dat [profile.release]
    # de maturin develop --release trong run_dev.bat van build nhanh (dev loop khong cho LTO).
    $previousLto = $env:CARGO_PROFILE_RELEASE_LTO
    $previousCgu = $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS
    $previousStripSym = $env:CARGO_PROFILE_RELEASE_STRIP
    $env:CARGO_PROFILE_RELEASE_LTO = "thin"
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "1"
    $env:CARGO_PROFILE_RELEASE_STRIP = "symbols"
    $tauriLocationPushed = $false
    $tauriExit = $null
    try {
        Push-Location "$ROOT\desktop"
        $tauriLocationPushed = $true
        npx @tauri-apps/cli build --config $tauriConfig
        $tauriExit = $LASTEXITCODE
    } finally {
        if ($tauriLocationPushed) { Pop-Location }
        if ($null -eq $previousRustFlags) { Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue }
        else { $env:RUSTFLAGS = $previousRustFlags }
        if ($null -eq $previousLto) { Remove-Item Env:CARGO_PROFILE_RELEASE_LTO -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_LTO = $previousLto }
        if ($null -eq $previousCgu) { Remove-Item Env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = $previousCgu }
        if ($null -eq $previousStripSym) { Remove-Item Env:CARGO_PROFILE_RELEASE_STRIP -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_STRIP = $previousStripSym }
    }

    if ($tauriExit -ne 0) {
        $script:CapturedTauriSigningPrivateKey = $null
        $script:CapturedTauriSigningKeyFile = $null
        $script:CapturedTauriSigningPrivateKeyPassword = $null
        Write-Host "ERROR: Tauri build failed!" -ForegroundColor Red
        exit 1
    }

    # BUILD (audit 2026-08-04 BLD.01): Tauri la buoc lau nhat; IDE/agent khac co
    # the commit hoac sua source trong luc no chay. Chot lai TRUOC khi copy/manifest.
    Assert-ReleaseSourceState

    $installerCandidates = @(Get-ChildItem -LiteralPath $nsisDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $installerNamePattern })
    if ($installerCandidates.Count -ne 1) {
        throw "Tauri completed but expected exactly one NSIS installer for app version $APP_VERSION in $nsisDir; found $($installerCandidates.Count)."
    }
    $installer = $installerCandidates[0]
    $oldInstaller = $installersBeforeBuild[$installer.FullName.ToLowerInvariant()]
    $installerChangedThisRun = $null -eq $oldInstaller -or
        $installer.Length -ne $oldInstaller.Length -or
        $installer.LastWriteTimeUtc -gt $oldInstaller.LastWriteTimeUtc
    $installerWrittenAfterStart = $installer.LastWriteTimeUtc -ge $tauriBuildStartedAtUtc.AddSeconds(-1)
    if (-not $installerChangedThisRun -or -not $installerWrittenAfterStart) {
        throw "Tauri returned success but did not create or rewrite the $APP_VERSION installer during this build. Refusing stale artifact: $($installer.FullName)"
    }

    if ($Release) {
        # SEC (audit 2026-08-06 REL.SIGN.EMPTY): chi signer duoc nhan khoa. Dung
        # --password= khi khoa co mat khau rong de khong treo o prompt tuong tac.
        $signaturePath = "$($installer.FullName).sig"
        if (Test-Path -LiteralPath $signaturePath -PathType Leaf) {
            Remove-Item -LiteralPath $signaturePath -Force
        }
        $tauriSignerArgs = @("@tauri-apps/cli", "signer", "sign")
        $tauriSigningPrivateKey = [string]$script:CapturedTauriSigningPrivateKey
        $signerLocationPushed = $false
        $signerExit = $null
        try {
            if ([string]::IsNullOrWhiteSpace($tauriSigningPrivateKey)) {
                if (-not (Test-Path -LiteralPath $script:CapturedTauriSigningKeyFile -PathType Leaf)) {
                    throw "Khong thay khoa ky updater: $($script:CapturedTauriSigningKeyFile)"
                }
                $tauriSignerArgs += @("-f", $script:CapturedTauriSigningKeyFile)
            } else {
                $env:TAURI_SIGNING_PRIVATE_KEY = $tauriSigningPrivateKey
            }
            if ([string]::IsNullOrEmpty($script:CapturedTauriSigningPrivateKeyPassword)) {
                $tauriSignerArgs += "--password="
            } else {
                $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $script:CapturedTauriSigningPrivateKeyPassword
            }
            $tauriSignerArgs += $installer.FullName
            Push-Location "$ROOT\desktop"
            $signerLocationPushed = $true
            npx @tauriSignerArgs
            $signerExit = $LASTEXITCODE
        } finally {
            if ($signerLocationPushed) { Pop-Location }
            Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
            Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
            $tauriSigningPrivateKey = $null
            $script:CapturedTauriSigningPrivateKey = $null
            $script:CapturedTauriSigningKeyFile = $null
            $script:CapturedTauriSigningPrivateKeyPassword = $null
        }
        if ($signerExit -ne 0) {
            throw "Tauri signer that bai voi exit code $signerExit."
        }
        if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf) -or
            (Get-Item -LiteralPath $signaturePath).Length -le 0 -or
            (Get-Item -LiteralPath $signaturePath).LastWriteTimeUtc -lt $installer.LastWriteTimeUtc) {
            throw "Tauri signer khong tao chu ky updater moi hop le: $signaturePath"
        }
    }

    Write-Host ""
    Write-Host "  ===========================================" -ForegroundColor Green
    Write-Host "              BUILD COMPLETE" -ForegroundColor Green
    Write-Host "  ===========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Sidecar:   $SIDECAR_FINAL"
    Write-Host "  SHA-256:   $HASH"
    if ($installer) {
        # Copy to root folder for easier access
        $publishDir = "$ROOT\Ban_Phat_Hanh"
        New-Item -ItemType Directory -Force -Path $publishDir | Out-Null
        $finalInstallerPath = "$publishDir\$($installer.Name)"
        Copy-Item -Force $installer.FullName $finalInstallerPath

        Write-Host "  Installer: $finalInstallerPath"
        Write-Host "  Size:      $([math]::Round((Get-Item $finalInstallerPath).Length / 1MB, 1)) MB"

        if ($Release -and $script:DIELINE_LOCKED -ne "yes") {
            throw "Release artifact is not dieline-locked. Refusing to publish installer/manifest."
        }

        # ---- Release manifest (audit 2026-07-25) ----
        # Tauri patch metadata theo bundle NSIS; binary CAI RA co the khac binary
        # target\release sau khi bundle xong. Khong gan nham hash build cho runtime.
        # EXE_SHA256 duoc dien boi scripts\verify_installed_artifact.ps1 (cai silent
        # vao Temp roi do hash payload that); BUILD_EXE_SHA256 la dau vet cua output
        # build de chan truong hop file target bi thieu/thay ngoai y muon.
        $exePath = "$ROOT\desktop\src-tauri\target\release\pdf-inspector.exe"
        if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
            throw "Built application executable not found: $exePath"
        }
        $buildExeHash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLower()
        $installerHash = (Get-FileHash $finalInstallerPath -Algorithm SHA256).Hash.ToLower()
        $manifestPath = "$publishDir\release-manifest.txt"
        if ([string]$env:VITE_FEATURE_GATING_ENABLED -ne "true" -or
            [string]$env:PRYNX_FEATURE_GATING_ENABLED -ne "true" -or
            [string]$env:VITE_LOGO_REBUILD_ENABLED -ne "false" -or
            [string]$env:PRYNX_LOGO_REBUILD_ENABLED -ne "false") {
            throw "Feature gate state changed before manifest creation."
        }
        $manifestGitOutput = if ($Release) {
            @($script:ReleaseSourceCommit)
        } else {
            @(& git -C $ROOT rev-parse HEAD 2>$null)
        }
        if ($manifestGitOutput.Count -ne 1) {
            throw "Cannot resolve exactly one source commit for release manifest."
        }
        # BUILD (audit 2026-08-04 BLD.06): PowerShell unwrap mang mot phan tu thanh scalar;
        # boc lai bang @() truoc khi lay [0] de khong goi Trim() tren System.Char.
        $manifestGitCommit = ([string](@($manifestGitOutput)[0])).Trim()
        if ([string]::IsNullOrWhiteSpace($manifestGitCommit)) {
            throw "Cannot resolve source commit for release manifest."
        }
        $manifestDirtyOutput = if ($Release) {
            @()
        } else {
            @(& git -C $ROOT status --porcelain=v1 --untracked-files=all 2>$null)
        }
        if (-not $Release -and $LASTEXITCODE -ne 0) {
            throw "Cannot resolve source dirty state for release manifest."
        }
        $manifestGitDirty = if ($Release) {
            "no"
        } elseif ($manifestDirtyOutput.Count -gt 0) {
            "yes"
        } else {
            "no"
        }
        $nativeDirtyManifestValue = if ($script:PpeNativeSourceDirty) { "yes" } else { "no" }
        if ($manifestGitCommit.ToLowerInvariant() -ne $script:PpeNativeSourceRevision -or
            $manifestGitDirty -ne $nativeDirtyManifestValue) {
            throw "Native provenance no longer matches the source state recorded by the installer manifest."
        }
        foreach ($requiredNativeIdentity in @(
            [string]$script:PpeNativeBuildIdentity,
            [string]$script:PpeNativeBuildProfile,
            [string]$script:PpeNativeBuildProvenance,
            [string]$script:PpeNativeBuildTimestampUtc,
            [string]$script:PpeNativeSha256
        )) {
            if ([string]::IsNullOrWhiteSpace($requiredNativeIdentity)) {
                throw "Native provenance is incomplete; refusing to write release manifest."
            }
        }
        $manifestBuildMode = if ($Release) { "public-release" } else { "internal-full" }
        $manifestBuildProvenance = if ($Release) { "git-clean-commit" } else { "local-working-tree" }
        $manifestLines = @(
            "PrynX release manifest",
            "BUILT_AT_UTC   = $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))",
            "GIT_COMMIT     = $manifestGitCommit",
            "GIT_DIRTY      = $manifestGitDirty",
            "BUILD_MODE     = $manifestBuildMode",
            "BUILD_PROVENANCE = $manifestBuildProvenance",
            "PPE_NATIVE_SOURCE_REVISION = $($script:PpeNativeSourceRevision)",
            "PPE_NATIVE_SOURCE_DIRTY = $nativeDirtyManifestValue",
            "PPE_NATIVE_BUILD_TIMESTAMP_UTC = $($script:PpeNativeBuildTimestampUtc)",
            "PPE_NATIVE_BUILD_PROFILE = $($script:PpeNativeBuildProfile)",
            "PPE_NATIVE_BUILD_PROVENANCE = $($script:PpeNativeBuildProvenance)",
            "PPE_NATIVE_BUILD_IDENTITY = $($script:PpeNativeBuildIdentity)",
            "PPE_NATIVE_SHA256 = $($script:PpeNativeSha256)",
            "SIDECAR_PROVENANCE = compiled-this-run",
            "PYTHON_ABI     = $PYTHON_MM",
            "FRONTEND_FEATURE_GATE = enabled",
            "BACKEND_FEATURE_GATE = enabled",
            "LOGO_REBUILD   = hold",
            "APP_VERSION    = $APP_VERSION",
            "INSTALLER      = $($installer.Name)",
            "INSTALLER_SHA256 = $installerHash",
            "EXE_SHA256     = NOT_VERIFIED_INSTALL_PAYLOAD",
            "BUILD_EXE_SHA256 = $buildExeHash",
            "SIDECAR_SHA256 = $HASH",
            "FRONTEND_SHA256 = $($env:PRYNX_FRONTEND_HASH)",
            "CODE_SIGNED    = no (Windows Authenticode not configured; updater .sig is separate)",
            "DIELINE_LOCKED = $(if ($script:DIELINE_LOCKED) { $script:DIELINE_LOCKED } else { 'no' })",
            "RUNTIME_VERIFIED = no"
        )
        Set-Content -Path $manifestPath -Value $manifestLines -Encoding ASCII
        Write-Host "  Manifest:  $manifestPath" -ForegroundColor Cyan
        Write-Host "  Build EXE SHA-256: $buildExeHash (installed payload requires smoke verification)" -ForegroundColor DarkGray
        Write-Host "  Buoc ke tiep de dien EXE_SHA256 (neo doi chieu runtime):" -ForegroundColor Yellow
        Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\verify_installed_artifact.ps1" -ForegroundColor Yellow
        if (-not $Release -and -not $NoOpenExplorer) {
            Write-Host ""
            Write-Host "  >> Da copy file cai dat ra ngoai thu muc de de lay hon..." -ForegroundColor Cyan
            Start-Process explorer.exe -ArgumentList "/select,`"$finalInstallerPath`""
        }
    }
} else {
    Write-Host "`n[4/5] Skipped Tauri build." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Build complete (Nuitka only)." -ForegroundColor Green
    Write-Host "  Sidecar: $SIDECAR_FINAL"
    Write-Host "  SHA-256: $HASH"
}

Write-Host ""
} finally {
    Restore-BuildOwnedEnvironment
}
