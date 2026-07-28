<#
.SYNOPSIS
    Cai silent artifact vua build, do hash cua app exe DA CAI roi dien vao manifest.

.DESCRIPTION
    GS-SUNSET (audit 2026-07-27 lan 2, muc A.2): manifest phat hanh co truong
    EXE_SHA256 lam NEO DOI CHIEU - khi nghi may khach chay binary bi va, so hash
    trong %APPDATA%\PrynX\logs (dong "[INTEGRITY][SELF] ... sha256=") voi gia tri
    nay. Nhung Tauri va metadata theo loai bundle, nen binary DA CAI khac binary
    o target\release: khong the dien neo do bang hash cua build target.

    build_production.ps1 vi vay ghi EXE_SHA256 = NOT_VERIFIED_INSTALL_PAYLOAD va
    de script nay dien bang chung that. Truoc khi co script nay, gia tri do phai
    dien BANG TAY - nghia la moi ban build sau deu mat neo.

    Script chay ba viec, theo dung thu tu de mot buoc that bai khong de lai rac:
      1. Cai silent vao mot thu muc trong Temp (khong dung duong dan cai that).
      2. Do hash app exe da cai + kiem payload (Ghostscript, NOTICE).
      3. Cap nhat manifest, roi go cai va don thu muc tam.

.PARAMETER Installer
    Duong dan file setup .exe. Mac dinh: file moi nhat trong Ban_Phat_Hanh.

.PARAMETER Manifest
    Duong dan release-manifest.txt can cap nhat. Mac dinh: canh installer.

.PARAMETER ExpectNoGhostscript
    Bat buoc payload da cai KHONG chua Ghostscript. Dung cho artifact -NoGhostscript.

.PARAMETER KeepInstall
    Giu lai thu muc da cai de kiem tay tiep (khong go cai, khong xoa).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\verify_installed_artifact.ps1 -ExpectNoGhostscript
#>
[CmdletBinding()]
param(
    [string]$Installer,
    [string]$Manifest,
    [switch]$ExpectNoGhostscript,
    [switch]$KeepInstall
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$PUBLISH_DIR = Join-Path $ROOT "Ban_Phat_Hanh"

function Write-Step($text) { Write-Host "`n[$text]" -ForegroundColor Cyan }
function Write-OK($text) { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Bad($text) { Write-Host "  FAIL $text" -ForegroundColor Red }

# -- 1. Xac dinh artifact -----------------------------------------------------
if (-not $Installer) {
    $candidate = Get-ChildItem -LiteralPath $PUBLISH_DIR -Filter "*-setup.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) {
        throw "Khong tim thay installer trong $PUBLISH_DIR. Truyen -Installer."
    }
    $Installer = $candidate.FullName
}
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "Khong thay installer: $Installer"
}
if (-not $Manifest) {
    $Manifest = Join-Path (Split-Path -Parent $Installer) "release-manifest.txt"
}

Write-Step "1/4 Artifact"
Write-Host "  Installer: $Installer" -ForegroundColor DarkGray
Write-Host "  Manifest : $Manifest" -ForegroundColor DarkGray
$installerHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLower()
Write-OK "SHA-256 installer: $installerHash"

if (Test-Path -LiteralPath $Manifest -PathType Leaf) {
    $declared = (Select-String -LiteralPath $Manifest -Pattern "^INSTALLER_SHA256\s*=\s*(\S+)" |
        Select-Object -First 1).Matches.Groups[1].Value
    if ($declared -and $declared.ToLower() -ne $installerHash) {
        throw "Manifest khai INSTALLER_SHA256 = $declared, khac hash thuc te. Manifest khong thuoc artifact nay."
    }
    if ($declared) { Write-OK "Khop INSTALLER_SHA256 trong manifest" }
}

# -- 2. Cai silent vao Temp ---------------------------------------------------
# Duong dan phai nam trong Temp: script nay chay voi quyen ghi/xoa de quy, nen
# mot duong dan lech ra ngoai Temp la rui ro khong can thiet.
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$installDir = Join-Path $tempRoot ("PrynXVerify-" + [guid]::NewGuid().ToString("N"))
if (-not ([System.IO.Path]::GetFullPath($installDir)).StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Duong dan cai kiem thu escaped Temp: $installDir"
}

Write-Step "2/4 Cai silent"
Write-Host "  Dich: $installDir" -ForegroundColor DarkGray
# NSIS: /S = silent, /D= phai la tham so CUOI va KHONG duoc dat trong ngoac kep.
$proc = Start-Process -FilePath $Installer -ArgumentList "/S", "/D=$installDir" -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    throw "Installer tra ma loi $($proc.ExitCode)"
}
Write-OK "Installer tra ma 0"

$failures = @()
try {
    # Ten main binary lay tu CAU HINH, khong go cung.
    # Audit lan 3 muc 3.3: ban dau script tim "PrynX.exe" - do la productName cua
    # Tauri, con file that mang ten crate. NSIS sinh MAINBINARYNAME "pdf-inspector",
    # nen script cai xong roi nem "khong thay PrynX.exe" va khong bao gio dien duoc
    # EXE_SHA256. Doc tu Cargo.toml de khong lech khi doi ten crate.
    $mainBinary = $null
    $cargoToml = Join-Path $ROOT "desktop\src-tauri\Cargo.toml"
    if (Test-Path -LiteralPath $cargoToml) {
        $m = Select-String -LiteralPath $cargoToml -Pattern '^\s*name\s*=\s*"([^"]+)"' |
            Select-Object -First 1
        if ($m) { $mainBinary = $m.Matches.Groups[1].Value + ".exe" }
    }
    $candidates = @()
    if ($mainBinary) { $candidates += $mainBinary }
    # Du phong: ten theo productName, cho truong hop bundler doi hanh vi.
    $candidates += "PrynX.exe"

    $appExe = $null
    foreach ($nameCandidate in $candidates) {
        $appExe = Get-ChildItem -LiteralPath $installDir -Filter $nameCandidate -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($appExe) { break }
    }
    if (-not $appExe) {
        throw "Khong thay main binary ($($candidates -join ', ')) trong cay da cai: $installDir"
    }
    $installedHash = (Get-FileHash -LiteralPath $appExe.FullName -Algorithm SHA256).Hash.ToLower()

    # -- 3. Kiem payload -----------------------------------------------------
    Write-Step "3/4 Kiem payload da cai"
    Write-OK "App exe: $($appExe.FullName)"
    Write-OK "SHA-256 app exe da cai: $installedHash"

    $gsBinaries = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^gswin(32|64)c?\.exe$' -or $_.Name -match '^gsdll\d*\.dll$' })
    # KHONG dung -SimpleMatch o day: voi -SimpleMatch thi dau "|" la ky tu thuong,
    # nen pattern tro thanh mot chuoi khong bao gio khop. Audit lan 3 muc 3.3 do duoc:
    # ba dong "Ghostscript", "Artifex", "AGPL-3.0" cho 0 match voi -SimpleMatch va 3
    # match voi regex - tuc chot NOTICE truoc day luon bao "sach" du con AGPL.
    $noticeHits = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter "*NOTICE*" -ErrorAction SilentlyContinue |
        Select-String -Pattern "Ghostscript|Artifex|AGPL" -List)

    if ($ExpectNoGhostscript) {
        if ($gsBinaries.Count -gt 0) {
            $failures += "Payload van co Ghostscript: " + (($gsBinaries | Select-Object -First 5).Name -join ", ")
        } else {
            Write-OK "Khong co gswin*.exe / gsdll*.dll trong payload"
        }
        if ($noticeHits.Count -gt 0) {
            $failures += "NOTICE van nhac Ghostscript/Artifex/AGPL: " + ($noticeHits[0].Path)
        } else {
            Write-OK "NOTICE khong nhac Ghostscript/Artifex/AGPL"
        }
        $marker = Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter "NO_GHOSTSCRIPT.txt" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $marker) {
            # Marker la loi khai cua artifact: backend doc no de KHONG muon Ghostscript
            # cua may khach (xem backend/app/core/gs_availability.py).
            $failures += "Thieu marker binaries\gs\NO_GHOSTSCRIPT.txt - backend se lai tu do GS he thong"
        } else {
            Write-OK "Co marker no-GS: $($marker.FullName)"
        }
    } else {
        Write-Host "  (bo qua kiem Ghostscript - khong truyen -ExpectNoGhostscript)" -ForegroundColor DarkGray
    }

    # -- 4. Cap nhat manifest ------------------------------------------------
    Write-Step "4/4 Cap nhat manifest"
    if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
        $failures += "Khong thay manifest de cap nhat: $Manifest"
    } elseif ($failures.Count -gt 0) {
        # Khong dien neo cho mot payload vua truot kiem: mot manifest "da xac minh"
        # ma noi dung sai con te hon manifest de trong.
        Write-Bad "Bo qua cap nhat manifest vi payload chua dat"
    } else {
        $lines = Get-Content -LiteralPath $Manifest
        $updated = $false
        $lines = $lines | ForEach-Object {
            if ($_ -match "^EXE_SHA256\s*=") {
                $updated = $true
                "EXE_SHA256     = $installedHash"
            } else { $_ }
        }
        if (-not $updated) {
            $lines += "EXE_SHA256     = $installedHash"
        }
        if (-not ($lines | Where-Object { $_ -match "^INSTALL_VERIFIED_AT_UTC" })) {
            $lines += "INSTALL_VERIFIED_AT_UTC = $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
        }
        Set-Content -LiteralPath $Manifest -Value $lines -Encoding ASCII
        Write-OK "Da dien EXE_SHA256 tu payload da cai"
    }
} finally {
    if ($KeepInstall) {
        Write-Host "`n  Giu lai cay da cai: $installDir" -ForegroundColor Yellow
    } else {
        $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter "uninstall.exe" -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($uninstaller) {
            Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $installDir) {
            Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host ""
if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Bad $f }
    Write-Host "KET LUAN: artifact CHUA dat kiem sau cai." -ForegroundColor Red
    exit 1
}
Write-Host "KET LUAN: artifact dat kiem sau cai; manifest da co neu doi chieu runtime." -ForegroundColor Green
exit 0
