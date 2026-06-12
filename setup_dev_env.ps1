<# 
.SYNOPSIS
    PrynX Development Environment Setup Script
.DESCRIPTION
    Tu dong kiem tra, tai va cai dat tat ca tools can thiet.
.NOTES
    Chay voi quyen Administrator (can cho cai dat phan mem)
#>

param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Continue"

# -- Helpers --
function Write-Step { param($msg) Write-Host ("`n=== $msg ===") -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Skip { param($msg) Write-Host "  [SKIP] $msg" -ForegroundColor DarkGray }
function Write-Warn { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red }

function Test-Cmd { param($cmd) return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Install-WithWinget {
    param($PackageId, $Name)
    if (Test-Cmd "winget") {
        Write-Host "  Dang cai $Name qua winget..." -ForegroundColor Yellow
        winget install --id $PackageId --accept-source-agreements --accept-package-agreements --silent
        return $true
    }
    return $false
}

function Refresh-Path {
    $env:PATH = [Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH", "User")
}

# -- Check Admin --
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warn "Khong chay voi quyen Administrator. Mot so cai dat co the that bai."
    Write-Warn "Nhan Enter de tiep tuc hoac Ctrl+C de huy."
    Read-Host
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "  PrynX - Dev Environment Setup" -ForegroundColor Magenta
Write-Host "  Project: $projectRoot" -ForegroundColor Magenta
Write-Host ""

$issues = @()

# ============================================================
# 1. RUST
# ============================================================
Write-Step "1/7 - Rust Toolchain"

if (Test-Cmd "rustc") {
    $rustVer = rustc --version
    Write-OK "Rust: $rustVer"
} else {
    if ($SkipInstall) {
        Write-Err "Rust chua cai. Tai tu: https://rustup.rs"
        $issues += "Rust"
    } else {
        Write-Host "  Dang tai va cai Rust..." -ForegroundColor Yellow
        $rustupUrl = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
        $rustupExe = Join-Path $env:TEMP "rustup-init.exe"
        Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupExe -UseBasicParsing
        Start-Process -FilePath $rustupExe -ArgumentList "-y","--default-toolchain","stable" -Wait -NoNewWindow
        $cargoPath = Join-Path $env:USERPROFILE ".cargo\bin"
        $env:PATH = "$cargoPath;$env:PATH"
        if (Test-Cmd "rustc") {
            Write-OK "Rust cai thanh cong: $(rustc --version)"
        } else {
            Write-Err "Cai Rust that bai. Hay cai thu cong: https://rustup.rs"
            $issues += "Rust"
        }
    }
}

# ============================================================
# 2. NODE.JS
# ============================================================
Write-Step "2/7 - Node.js"

if (Test-Cmd "node") {
    $nodeVer = node --version
    Write-OK "Node.js: $nodeVer"
} else {
    if ($SkipInstall) {
        Write-Err "Node.js chua cai. Tai tu: https://nodejs.org"
        $issues += "Node.js"
    } else {
        $installed = Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS"
        if (-not $installed) {
            Write-Host "  Dang tai Node.js..." -ForegroundColor Yellow
            $nodeUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
            $nodeMsi = Join-Path $env:TEMP "node-setup.msi"
            Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
            Start-Process msiexec.exe -ArgumentList "/i","`"$nodeMsi`"","/qn" -Wait
        }
        Refresh-Path
        if (Test-Cmd "node") {
            Write-OK "Node.js cai thanh cong: $(node --version)"
        } else {
            Write-Err "Cai Node.js that bai. Hay cai thu cong: https://nodejs.org"
            $issues += "Node.js"
        }
    }
}

# ============================================================
# 3. PYTHON
# ============================================================
Write-Step "3/7 - Python 3.11"

$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    if (Test-Cmd $cmd) {
        $ver = & $cmd --version 2>&1
        if ("$ver" -match "3\.\d+") {
            $pythonCmd = $cmd
            break
        }
    }
}

if ($pythonCmd) {
    $pyVer = & $pythonCmd --version
    Write-OK "Python: $pyVer (command: $pythonCmd)"
} else {
    if ($SkipInstall) {
        Write-Err "Python 3 chua cai. Tai tu: https://python.org"
        $issues += "Python"
    } else {
        $installed = Install-WithWinget "Python.Python.3.11" "Python 3.11"
        if (-not $installed) {
            Write-Host "  Dang tai Python 3.11..." -ForegroundColor Yellow
            $pyUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
            $pyExe = Join-Path $env:TEMP "python-setup.exe"
            Invoke-WebRequest -Uri $pyUrl -OutFile $pyExe -UseBasicParsing
            Start-Process -FilePath $pyExe -ArgumentList "/quiet","InstallAllUsers=1","PrependPath=1" -Wait
        }
        Refresh-Path
        if (Test-Cmd "python") {
            $pythonCmd = "python"
            Write-OK "Python cai thanh cong: $(python --version)"
        } else {
            Write-Err "Cai Python that bai. Hay cai thu cong: https://python.org"
            $issues += "Python"
        }
    }
}

# ============================================================
# 4. GHOSTSCRIPT
# ============================================================
Write-Step "4/7 - Ghostscript"

$gsFound = $false
foreach ($gsName in @("gswin64c", "gswin32c", "gs")) {
    if (Test-Cmd $gsName) {
        $gsVer = & $gsName --version 2>&1
        Write-OK "Ghostscript: $gsVer (command: $gsName)"
        $gsFound = $true
        break
    }
}

if (-not $gsFound) {
    $gsPaths = @(
        "C:\Program Files\gs\*\bin\gswin64c.exe",
        "C:\Program Files (x86)\gs\*\bin\gswin32c.exe"
    )
    foreach ($pattern in $gsPaths) {
        $found = Get-Item $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            Write-OK "Ghostscript: $($found.FullName) (khong trong PATH)"
            Write-Warn "Nen them vao PATH: $($found.DirectoryName)"
            $gsFound = $true
            break
        }
    }
}

if (-not $gsFound) {
    if ($SkipInstall) {
        Write-Err "Ghostscript chua cai. Tai tu: https://ghostscript.com"
        $issues += "Ghostscript"
    } else {
        $installed = Install-WithWinget "ArtifexSoftware.GhostScript" "Ghostscript"
        if ($installed) {
            Write-OK "Ghostscript cai thanh cong"
        } else {
            Write-Warn "Khong the tu dong cai Ghostscript. Tai thu cong: https://ghostscript.com"
            $issues += "Ghostscript (manual)"
        }
    }
}

# ============================================================
# 5. VS BUILD TOOLS
# ============================================================
Write-Step "5/7 - Visual Studio Build Tools"

$vsWherePath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWherePath) {
    $vsInstall = & $vsWherePath -latest -property installationPath 2>$null
    if ($vsInstall) {
        Write-OK "VS Build Tools: $vsInstall"
    } else {
        Write-Warn "vswhere tim thay nhung khong co installation"
    }
} elseif (Test-Cmd "cl") {
    Write-OK "MSVC compiler (cl.exe) co trong PATH"
} else {
    if ($SkipInstall) {
        Write-Err "VS Build Tools chua cai."
        $issues += "VS Build Tools"
    } else {
        $installed = Install-WithWinget "Microsoft.VisualStudio.2022.BuildTools" "VS Build Tools 2022"
        if ($installed) {
            Write-OK "VS Build Tools cai thanh cong"
        } else {
            Write-Warn "Cai thu cong: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
            Write-Warn "Chon 'Desktop development with C++'"
            $issues += "VS Build Tools (manual)"
        }
    }
}

# ============================================================
# 6. PYTHON BACKEND SETUP
# ============================================================
Write-Step "6/7 - Backend Python Dependencies"

$backendDir = Join-Path $projectRoot "backend"
$venvDir = Join-Path $backendDir "venv"
$reqFile = Join-Path $backendDir "requirements.txt"

if ($pythonCmd) {
    if (-not (Test-Path $venvDir)) {
        Write-Host "  Tao Python venv..." -ForegroundColor Yellow
        & $pythonCmd -m venv $venvDir
    }

    $venvPython = Join-Path $venvDir "Scripts\python.exe"
    $venvPip = Join-Path $venvDir "Scripts\pip.exe"

    if (Test-Path $venvPython) {
        Write-Host "  Dang cai Python packages (co the mat vai phut)..." -ForegroundColor Yellow
        & $venvPip install -r $reqFile --quiet 2>&1 | Out-Null
        $pkgCount = (& $venvPip list --format=columns 2>$null | Measure-Object).Count - 2
        Write-OK "Backend: $pkgCount packages trong venv"
    } else {
        Write-Err "Khong tao duoc venv"
        $issues += "Python venv"
    }
} else {
    Write-Skip "Bo qua (Python chua cai)"
}

# ============================================================
# 7. DESKTOP NODE DEPENDENCIES
# ============================================================
Write-Step "7/7 - Desktop Node Dependencies"

$desktopDir = Join-Path $projectRoot "desktop"
$nodeModules = Join-Path $desktopDir "node_modules"

if (Test-Cmd "npm") {
    if (-not (Test-Path $nodeModules)) {
        Write-Host "  Dang chay npm install (co the mat vai phut)..." -ForegroundColor Yellow
        Push-Location $desktopDir
        npm install --silent 2>&1 | Out-Null
        Pop-Location
    }
    
    if (Test-Path $nodeModules) {
        $pkgCount = (Get-ChildItem $nodeModules -Directory).Count
        Write-OK "Desktop: $pkgCount packages trong node_modules"
    } else {
        Write-Err "npm install that bai"
        $issues += "npm install"
    }
} else {
    Write-Skip "Bo qua (Node.js chua cai)"
}

# ============================================================
# ENV FILES CHECK
# ============================================================
Write-Step "Kiem tra file .env"

$envExample = Join-Path $projectRoot ".env.example"
$envFile = Join-Path $projectRoot ".env"
$desktopEnv = Join-Path $desktopDir ".env"

if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
    Copy-Item $envExample $envFile
    Write-OK "Tao .env tu .env.example"
} elseif (Test-Path $envFile) {
    Write-OK ".env da ton tai"
}

if (-not (Test-Path $desktopEnv)) {
    Write-Warn "desktop/.env CHUA TAO - can Supabase keys:"
    Write-Host "  VITE_SUPABASE_URL=<your-url>" -ForegroundColor DarkGray
    Write-Host "  VITE_SUPABASE_ANON_KEY=<your-key>" -ForegroundColor DarkGray
} else {
    Write-OK "desktop/.env da ton tai"
}

# ============================================================
# SUMMARY
# ============================================================
Write-Host ""
Write-Host "  ========== KET QUA ==========" -ForegroundColor Magenta

if ($issues.Count -eq 0) {
    Write-Host ""
    Write-Host "  TAT CA HOAN TAT! San sang dev." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Chay dev:" -ForegroundColor White
    Write-Host "    .\run_dev.bat" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Hoac thu cong:" -ForegroundColor White
    Write-Host "    Terminal 1: cd backend && venv\Scripts\activate && uvicorn app.main:app --reload" -ForegroundColor DarkGray
    Write-Host "    Terminal 2: cd desktop && npm run dev" -ForegroundColor DarkGray
} else {
    Write-Host ""
    Write-Host "  CAN XU LY:" -ForegroundColor Yellow
    foreach ($issue in $issues) {
        Write-Host "    - $issue" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "  Cai dat cac tool tren roi chay lai script nay."
}

Write-Host ""
Read-Host "Nhan Enter de dong"
