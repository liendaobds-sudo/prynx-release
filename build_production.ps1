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
#    .\build_production.ps1 -Release         # Build updater artifacts (needs signing key)
#    .\build_production.ps1 -SkipPreflightQA # Emergency build without pytest gate
#
# ============================================================

param(
    [switch]$SkipNuitka,
    [switch]$SkipTauri,
    [switch]$NuitkaOnly,
    [switch]$Release,
    [switch]$SkipPreflightQA
)

$ErrorActionPreference = "Continue"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Cyan
Write-Host "       PrynX Production Build Pipeline" -ForegroundColor Cyan
Write-Host "  ===========================================" -ForegroundColor Cyan
Write-Host ""

$VENV_PYTHON = "$ROOT\backend\venv\Scripts\python.exe"
$SIDECAR_DIR = "$ROOT\desktop\src-tauri\binaries"
$SIDECAR_NAME = "pdf-inspector-backend"

# Validate venv exists
if (-not (Test-Path $VENV_PYTHON)) {
    Write-Host "ERROR: Python venv not found at $VENV_PYTHON" -ForegroundColor Red
    Write-Host "  Run run_dev.bat first to create the venv." -ForegroundColor Yellow
    exit 1
}

# ---- Step 0: Preflight QA gate (runs before Nuitka/Tauri) ----
if (-not $SkipPreflightQA) {
    Write-Host "[0/5] Running Preflight QA (pytest + golden fixtures)..." -ForegroundColor Yellow
    & "$ROOT\backend\scripts\run_preflight_qa.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Preflight QA failed. Fix tests before release." -ForegroundColor Red
        Write-Host "  Emergency only: add -SkipPreflightQA to skip this gate." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  Preflight QA passed." -ForegroundColor Green
} else {
    Write-Host "[0/5] Skipped Preflight QA (-SkipPreflightQA)." -ForegroundColor DarkGray
}

# ---- Step 1: Nuitka compile backend ----
if (-not $SkipNuitka) {
    Write-Host "[1/5] Compiling Python backend with Nuitka..." -ForegroundColor Yellow
    Write-Host "  This may take 5-15 minutes on first run." -ForegroundColor DarkGray

    & $VENV_PYTHON -m pip show nuitka *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Installing Nuitka + dependencies..." -ForegroundColor DarkGray
        & $VENV_PYTHON -m pip install nuitka ordered-set zstandard
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to install Nuitka" -ForegroundColor Red
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

    & $VENV_PYTHON -m nuitka `
        --standalone `
        --onefile `
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
        --include-package=skimage `
        --include-package=scipy `
        --include-package=pdfplumber `
        --include-package=pytesseract `
        --include-package=celery `
        --include-package=pypdf `
        --include-package=fontTools `
        --include-package=uharfbuzz `
        --include-package=onnxruntime `
        --include-package-data=onnxruntime `
        --include-data-dir=app/assets=app/assets `
        $PDFIUM_FLAG `
        --nofollow-import-to=tkinter `
        --nofollow-import-to=unittest `
        --nofollow-import-to=test `
        --nofollow-import-to=pip `
        --nofollow-import-to=setuptools `
        --windows-console-mode=disable `
        --remove-output `
        --assume-yes-for-downloads `
        --company-name="PrynX" `
        --product-name="PrynX Backend" `
        --file-version="1.0.0" `
        --product-version="1.0.0" `
        --file-description="PrynX PDF Processing Engine" `
        app\main.py

    $nuitkaExit = $LASTEXITCODE
    Pop-Location

    if ($nuitkaExit -ne 0) {
        Write-Host "ERROR: Nuitka compilation failed!" -ForegroundColor Red
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
$GS_SRC = "C:\Program Files\gs\gs10.04.0"
$GS_DEST = "$SIDECAR_DIR\gs"
if (Test-Path $GS_SRC) {
    Write-Host "  Copying Ghostscript..." -ForegroundColor DarkGray
    New-Item -ItemType Directory -Force -Path $GS_DEST | Out-Null
    Copy-Item -Recurse -Force "$GS_SRC\*" $GS_DEST
    Write-Host "  Ghostscript bundled." -ForegroundColor Green
} else {
    Write-Host "ERROR: Ghostscript not found at $GS_SRC." -ForegroundColor Red
    Write-Host "  Ghostscript is REQUIRED for CMYK separations / PDF-X export." -ForegroundColor Red
    Write-Host "  Install Ghostscript 10.04.0 or update GS_SRC path. Build aborted." -ForegroundColor Red
    exit 1
}

# Copy Tesseract
$TESS_SRC = "C:\Program Files\Tesseract-OCR"
$TESS_DEST = "$SIDECAR_DIR\tesseract"
if (Test-Path $TESS_SRC) {
    Write-Host "  Copying Tesseract-OCR..." -ForegroundColor DarkGray
    New-Item -ItemType Directory -Force -Path $TESS_DEST | Out-Null
    Copy-Item -Recurse -Force "$TESS_SRC\*" $TESS_DEST
    Write-Host "  Tesseract bundled." -ForegroundColor Green
} else {
    Write-Host "  WARNING: Local Tesseract not found at $TESS_SRC. It will not be bundled." -ForegroundColor Yellow
}

# ---- Step 3: Compute SHA-256 hash for integrity verification ----
Write-Host "`n[3/5] Computing sidecar integrity hash..." -ForegroundColor Yellow

$HASH = (Get-FileHash $SIDECAR_FINAL -Algorithm SHA256).Hash.ToLower()
Write-Host "  PRYNX_SIDECAR_HASH = $HASH" -ForegroundColor Green

# ---- Step 4: Build Tauri installer ----
if (-not $SkipTauri) {
    Write-Host "`n[4/5] Building frontend + computing integrity hash..." -ForegroundColor Yellow

    Push-Location "$ROOT\desktop"
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Frontend build failed!" -ForegroundColor Red
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
    npx @tauri-apps/cli build --config $tauriConfig
    $tauriExit = $LASTEXITCODE
    Pop-Location

    if ($tauriExit -ne 0) {
        Write-Host "ERROR: Tauri build failed!" -ForegroundColor Red
        exit 1
    }

    $installer = Get-ChildItem "$ROOT\desktop\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

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
        if (-not $Release) {
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
