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
    [switch]$NoOpenExplorer,
    # GS-SUNSET (audit 2026-07-27 lan 3, muc 3.1): KHONG dong goi Ghostscript la
    # MAC DINH. Co nay giu lai de moi lenh/script cu van chay, khong con tac dung
    # doi hanh vi (mac dinh da la no-GS).
    #
    # Vi sao dao mac dinh: Ghostscript la AGPL-3.0, dong goi vao san pham
    # closed-source la rui ro ban quyen. Khi no-GS chi la MOT CO PHAI NHO, moi
    # duong phat hanh bo sot co do se sinh installer chua AGPL - va do la dung
    # thu da xay ra: release_update.ps1 / PHAT_HANH.bat / quanly_phathanh.ps1
    # deu goi build ma khong truyen co nay.
    [switch]$NoGhostscript,
    [ValidateRange(1, 8)]
    [int]$NuitkaJobs = 4,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Release artifacts must be rebuilt from current sources and must pass the full QA gate.
if ($Release -and $SkipNuitka) {
    throw "Release build refuses -SkipNuitka: the sidecar/native payload could be stale or unlocked."
}
if ($Release -and $SkipPreflightQA) {
    throw "Release build refuses -SkipPreflightQA: security regression tests are mandatory."
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

# Production builds must enforce the same Free/Pro entitlements in both layers.
# Explicit values here avoid silently shipping an unrestricted build when local
# .env files omit the rollout flags.
$env:VITE_FEATURE_GATING_ENABLED = "true"
$env:PRYNX_FEATURE_GATING_ENABLED = "true"
Write-Host "  Free/Pro feature gating: ENABLED (frontend + backend)" -ForegroundColor Green


# ---- Step 0: Full release QA gate (runs before Nuitka/Tauri) ----
if (-not $SkipPreflightQA) {
    Write-Host "[0/5] Running full release regression gate..." -ForegroundColor Yellow
    & "$ROOT\scripts\run_release_qa.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Release regression gate failed. Fix tests before release." -ForegroundColor Red
        Write-Host "  Emergency only: add -SkipPreflightQA to skip this gate." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  Full release regression gate passed." -ForegroundColor Green
} else {
    Write-Host "[0/5] Skipped ALL automated release tests (-SkipPreflightQA)." -ForegroundColor DarkGray
}

# ---- Step 1: Nuitka compile backend ----
if (-not $SkipNuitka) {
    Write-Host "[1/5] Compiling Python backend with Nuitka..." -ForegroundColor Yellow
    Write-Host "  Cache-aware build; first compile is slower. MSVC jobs: $NuitkaJobs." -ForegroundColor DarkGray

    & $VENV_PYTHON -m pip show nuitka *> $null
    if ($LASTEXITCODE -ne 0) {
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
    $lockDieline = $env:PRYNX_SUPABASE_URL -and $env:PRYNX_SUPABASE_SERVICE_KEY
    if (-not $lockDieline) {
        if ($Release -or -not $AllowPlaintextDieline) {
            throw "Missing PRYNX_SUPABASE_URL/PRYNX_SUPABASE_SERVICE_KEY. Refusing an unlocked build. Use -AllowPlaintextDieline only for local development."
        }
        Write-Host "  WARNING: explicit development override enabled; dieline engine is plaintext." -ForegroundColor Yellow
    } else {
        $keyHeaders = @{
            apikey        = $env:PRYNX_SUPABASE_SERVICE_KEY
            Authorization = "Bearer $($env:PRYNX_SUPABASE_SERVICE_KEY)"
        }
        $restBase = $env:PRYNX_SUPABASE_URL.TrimEnd('/')
        $encodedVersion = [Uri]::EscapeDataString($APP_VERSION)
        $keyUri = "$restBase/rest/v1/release_resource_keys?select=resource_key&product_id=eq.prynx&app_version=eq.$encodedVersion&resource=eq.dieline_engine&limit=2"

        try {
            # RELEASE BUILD (audit 2026-07-27): Windows PowerShell treats the
            # empty JSON array returned by Invoke-RestMethod as one non-enumerated
            # pipeline object when the call sits directly inside @(...). Assign
            # first, then normalize, otherwise "no row" looks like one blank row.
            $existingResponse = Invoke-RestMethod -Method Get -Uri $keyUri -Headers $keyHeaders -ErrorAction Stop
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
                    }) -Body $body -ErrorAction Stop
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
    # ---- Step 1a: Build the Rust/Python native extension ----

    # Rebuild the Rust/Python extension for the active Python ABI on every full
    # production build. Reusing an extension from an older venv can make Nuitka
    # fail or silently ship stale native PDF logic.
    & $VENV_PYTHON -m pip show maturin *> $null
    if ($LASTEXITCODE -ne 0) {
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
        & $VENV_PYTHON -c "import pdfcompare_native as n; assert n.ppe_capabilities().get('overprint_preview_toggle') is True"
        $nativeExit = $LASTEXITCODE
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
    & $VENV_PYTHON -m pip show onnxruntime-directml *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Installing onnxruntime-directml (GPU) into build venv..." -ForegroundColor DarkGray
        & $VENV_PYTHON -m pip uninstall -y onnxruntime *> $null
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
        Write-Host "  DirectML.dll not found (onnxruntime CPU) - shipping CPU inference." -ForegroundColor DarkGray
    }

    # ---- Model Real-ESRGAN (upscale): convert .pth -> .onnx roi bundle vao exe ----
    # KHAC isnet/birefnet (tai runtime tu URL): repo goc xinntao CHI phat hanh .pth nen
    # KHONG co URL .onnx de tai. Phai convert san (scripts/convert_realesrgan_onnx.py,
    # can torch) roi gom .onnx vao app/data/models -> engine doc tu do (fallback sau
    # ~/.u2net). torch CHI o may build, KHONG bundle (app runtime chi import onnxruntime).
    $UPSCALE_MODELS_FLAG = ""
    $MODELS_DIR = "$ROOT\backend\app\data\models"
    $GEN_ONNX = "$MODELS_DIR\realesr-general-x4v3.onnx"
    $QUALITY_ONNX = "$MODELS_DIR\realesrgan-x4plus.onnx"
    $ISNET_ONNX = "$MODELS_DIR\isnet-general-use.onnx"
    $EXPECTED_ISNET_SHA256 = "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"
    # RELEASE (audit 2026-07-28 §BG.02): luôn bundle model Nhanh để Tách nền
    # hoạt động offline ngay lần đầu. Helper tải `.part`, kiểm hash rồi rename atomic.
    if (-not (Test-Path $ISNET_ONNX) -or
        (Get-FileHash -LiteralPath $ISNET_ONNX -Algorithm SHA256).Hash.ToLowerInvariant() -ne $EXPECTED_ISNET_SHA256) {
        $resolvedIsnet = (& $VENV_PYTHON -c "from app.workers.isnet_engine import _download_model_if_needed; print(_download_model_if_needed())").Trim()
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $resolvedIsnet)) {
            Write-Host "ERROR: Cannot prepare verified ISNet model for offline bundle." -ForegroundColor Red
            Pop-Location
            exit 1
        }
        Copy-Item -LiteralPath $resolvedIsnet -Destination $ISNET_ONNX -Force
    }
    $actualIsnetHash = (Get-FileHash -LiteralPath $ISNET_ONNX -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualIsnetHash -ne $EXPECTED_ISNET_SHA256) {
        Write-Host "ERROR: ISNet model SHA-256 mismatch: $actualIsnetHash" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    if (-not (Test-Path $GEN_ONNX) -or -not (Test-Path $QUALITY_ONNX)) {
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
            & $VENV_PYTHON "$ROOT\backend\scripts\convert_realesrgan_onnx.py" --out "$MODELS_DIR" --model all --alpha 0.5
        } else {
            Write-Host "  torch not in build venv; cannot generate the required upscale model." -ForegroundColor Yellow
        }
    }
    if ((Test-Path $GEN_ONNX) -and (Test-Path $QUALITY_ONNX)) {
        $UPSCALE_MODELS_FLAG = "--include-data-dir=app/data/models=app/data/models"
        Write-Host "  Real-ESRGAN models bundled: $MODELS_DIR" -ForegroundColor DarkGray
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

    # MSVC /Ox exhausts compiler heap on some large Nuitka-generated modules. Keep
    # /O1 for generated Python C code and silence the expected override warning.
    $previousClAppend = $env:_CL_
    $env:_CL_ = if ([string]::IsNullOrWhiteSpace($previousClAppend)) { "/O1 /wd9025" } else { "$previousClAppend /O1 /wd9025" }
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

# Copy Ghostscript
# Auto-detect: quet C:\Program Files\gs\gs* va chon ban CAO NHAT thay vi hardcode
# mot version. Doi may build / nang cap GS khong con lam build fail oan.
$GS_SRC = ""
$gsRoot = "C:\Program Files\gs"
if (Test-Path $gsRoot) {
    $gsDir = Get-ChildItem -Path $gsRoot -Directory -Filter "gs*" -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName "bin") } |
        Sort-Object {
            # Sort theo so version thuc (10.04.0) chu khong theo chuoi (tranh gs9 > gs10)
            if ($_.Name -match 'gs(\d+)\.(\d+)\.?(\d+)?') {
                $micro = if ($Matches[3]) { $Matches[3] } else { "0" }
                [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $micro)
            } else { [version]"0.0.0" }
        } -Descending | Select-Object -First 1
    if ($gsDir) { $GS_SRC = $gsDir.FullName }
}
$GS_DEST = "$SIDECAR_DIR\gs"

# Quyet dinh co dong goi Ghostscript hay khong.
#
# GS-SUNSET (audit 2026-07-27 lan 3, muc 3.1): MAC DINH la KHONG dong goi.
# Dev, test va release dung cung mot artifact no-GS; khong co co/env bat lai.
$BUNDLE_GS = $false

if (-not $BUNDLE_GS) {
    # Ban KHONG chua AGPL. Phai xoa sach ban copy cu: neu de lai, installer van
    # gom Ghostscript tu lan build truoc va ta tuong la da go -- day la kieu loi
    # nguy hiem nhat vi khong ai thay.
    if (Test-Path $GS_DEST) {
        Write-Host "  Removing previously bundled Ghostscript..." -ForegroundColor DarkGray
        Remove-Item -Recurse -Force $GS_DEST
    }
    # tauri.conf.json khai resource "binaries/gs/**/*". Glob khong khop gi se lam
    # Tauri bao loi, nen de lai dung mot file giai thich -- vua thoa glob, vua tu
    # ghi lai quyet dinh ngay trong ban da cai.
    New-Item -ItemType Directory -Force -Path $GS_DEST | Out-Null
    @(
        "Ghostscript is NOT bundled in this build.",
        "",
        "Reason: Ghostscript is licensed AGPL-3.0-or-later. Bundling it inside a",
        "closed-source installer creates licensing obligations, so this build was",
        "produced with -NoGhostscript.",
        "",
        "Prepress routes use PrynX PPE, pikepdf and fontTools. Unsupported input",
        "must fail loudly; the application does not silently fall back to a bundled",
        "Ghostscript executable. Independent PDF/X conformance remains a release",
        "validation gate. See",
        "docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md for the replacement engine (PPE)."
    ) | Set-Content -Path (Join-Path $GS_DEST "NO_GHOSTSCRIPT.txt") -Encoding UTF8

    Write-Host "  Ghostscript NOT bundled (mac dinh tu 2026-07-27)." -ForegroundColor Green
    Write-Host "  Prepress engine: PPE + pikepdf + fontTools (khong fallback GS bundle)." -ForegroundColor Green
    Write-Host "  No-GS regression gate da chay trong release QA." -ForegroundColor Green
    Write-Host "  Luu y: PDF/X van can doi chieu bang validator doc lap truoc khi public release." -ForegroundColor Yellow
} elseif ($GS_SRC -and (Test-Path $GS_SRC)) {
    Write-Host "  Ghostscript detected: $GS_SRC" -ForegroundColor DarkGray
    Write-Host "  Copying Ghostscript..." -ForegroundColor DarkGray
    New-Item -ItemType Directory -Force -Path $GS_DEST | Out-Null
    Copy-DirectoryWithRetry -SourcePattern "$GS_SRC\*" -Destination $GS_DEST
    # Loai doc/examples (~25MB) -- chi la tai lieu, runtime GS khong dung.
    foreach ($sub in @("doc", "examples")) {
        $p = Join-Path $GS_DEST $sub
        if (Test-Path $p) { Remove-Item -Recurse -Force $p }
    }
    Write-Host "  Ghostscript bundled (doc/examples pruned)." -ForegroundColor Green
    Write-Host "  LUU Y BAN QUYEN: Ghostscript la AGPL-3.0-or-later." -ForegroundColor Yellow
    Write-Host "    Dong goi vao installer closed-source la rui ro ban quyen chua giai quyet." -ForegroundColor Yellow
    Write-Host "    Xem THIRD_PARTY_NOTICES.md muc 1 va docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md." -ForegroundColor DarkYellow
} else {
    Write-Host "ERROR: no-GS invariant was violated in build_production.ps1." -ForegroundColor Red
    Write-Host "  Build cannot continue because Ghostscript bundling is disabled." -ForegroundColor Yellow
    Write-Host "  Build aborted." -ForegroundColor Red
    exit 1
}

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
# Danh sach thanh phan phai khop dung ban DANG dong goi, nen co -NoGhostscript
# duoc truyen xuong de ban khong-AGPL khong liet ke Ghostscript.
Write-Host "  Generating THIRD_PARTY_NOTICES.md..." -ForegroundColor DarkGray
if (-not (Test-Path -LiteralPath $VENV_PYTHON -PathType Leaf)) {
    Write-Host "ERROR: Khong tim thay $VENV_PYTHON de sinh NOTICE." -ForegroundColor Red
    exit 1
}
$noticeArgs = @("$ROOT\scripts\gen_third_party_notices.py")
if (-not $BUNDLE_GS) { $noticeArgs += "--no-ghostscript" }
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

    Push-Location "$ROOT\desktop"
    # -Release: use config with createUpdaterArtifacts (needs TAURI_SIGNING_PRIVATE_KEY).
    # Default: externalBin-only config (manual installer, no signing required).
    $tauriConfig = if ($Release) { "src-tauri/tauri.release.conf.json" } else { "src-tauri/tauri.prod.conf.json" }
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
    npx @tauri-apps/cli build --config $tauriConfig
    $tauriExit = $LASTEXITCODE
    if ($null -eq $previousRustFlags) { Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue }
    else { $env:RUSTFLAGS = $previousRustFlags }
    if ($null -eq $previousLto) { Remove-Item Env:CARGO_PROFILE_RELEASE_LTO -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_LTO = $previousLto }
    if ($null -eq $previousCgu) { Remove-Item Env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = $previousCgu }
    if ($null -eq $previousStripSym) { Remove-Item Env:CARGO_PROFILE_RELEASE_STRIP -ErrorAction SilentlyContinue } else { $env:CARGO_PROFILE_RELEASE_STRIP = $previousStripSym }
    Pop-Location

    if ($tauriExit -ne 0) {
        Write-Host "ERROR: Tauri build failed!" -ForegroundColor Red
        exit 1
    }

    $installer = Get-ChildItem "$ROOT\desktop\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1

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
        $manifestLines = @(
            "PrynX release manifest",
            "BUILT_AT_UTC   = $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))",
            "GIT_COMMIT     = $(git -C $ROOT rev-parse HEAD 2>$null)",
            "GIT_DIRTY      = $(if ((git -C $ROOT status --porcelain 2>$null)) { 'YES (artifact khong tai lap duoc tu cay da commit)' } else { 'no' })",
            "INSTALLER      = $($installer.Name)",
            "INSTALLER_SHA256 = $installerHash",
            "EXE_SHA256     = NOT_VERIFIED_INSTALL_PAYLOAD",
            "BUILD_EXE_SHA256 = $buildExeHash",
            "SIDECAR_SHA256 = $HASH",
            "FRONTEND_SHA256 = $($env:PRYNX_FRONTEND_HASH)",
            "CODE_SIGNED    = no (Windows Authenticode not configured; updater .sig is separate)",
            "DIELINE_LOCKED = $(if ($script:DIELINE_LOCKED) { $script:DIELINE_LOCKED } else { 'no' })"
        )
        Set-Content -Path $manifestPath -Value $manifestLines -Encoding ASCII
        Write-Host "  Manifest:  $manifestPath" -ForegroundColor Cyan
        Write-Host "  Build EXE SHA-256: $buildExeHash (installed payload requires smoke verification)" -ForegroundColor DarkGray
        $verifyArgs = if (-not $BUNDLE_GS) { " -ExpectNoGhostscript" } else { "" }
        Write-Host "  Buoc ke tiep de dien EXE_SHA256 (neo doi chieu runtime):" -ForegroundColor Yellow
        Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\verify_installed_artifact.ps1$verifyArgs" -ForegroundColor Yellow
        if (-not $Release -and -not $NoOpenExplorer) {
            Write-Host ""
            Write-Host "  >> Da copy file cai dat ra ngoai thu muc de de lay hon..." -ForegroundColor Cyan
            Start-Process explorer.exe -ArgumentList "/select,`"$finalInstallerPath`""
        }
    } else {
        Write-Host "  WARNING: Khong tim thay installer trong bundle\nsis\." -ForegroundColor Yellow
    }
} else {
    Write-Host "`n[4/5] Skipped Tauri build." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Build complete (Nuitka only)." -ForegroundColor Green
    Write-Host "  Sidecar: $SIDECAR_FINAL"
    Write-Host "  SHA-256: $HASH"
}

Write-Host ""
