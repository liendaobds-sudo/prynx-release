# ============================================================
#  PrynX - Release + Auto-Update Publisher (one shot)
#  build (sidecar+frontend+tauri, KY updater) -> latest.json
#  -> upload len GitHub Releases (public repo) qua gh CLI.
#  ASCII-only (Windows PowerShell parse .ps1 theo ANSI khi khong BOM).
#
#  Vi du:
#    .\release_update.ps1 -Version 1.0.1
#    (Repo phat hanh TU DONG suy tu endpoint updater trong tauri.conf.json -- khong con go tay,
#     tranh phat hanh nham repo khien client khong nhan duoc update.)
# ============================================================
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ReleaseRepo = "",                            # (TUY CHON) override; mac dinh SUY TU endpoint updater. Neu dat ma KHAC endpoint -> dung.
    [string]$KeyPassword = "",                            # mat khau cua ~/.tauri/prynx.key (de trong neu khong dat)
    [string]$Notes = "",
    [switch]$SkipNuitka,                                  # Bo qua bien dich backend (dung lai sidecar cu khi backend khong doi)
    [switch]$SkipPreflightQA                              # KHAN CAP: bo qua pytest Preflight truoc build
)
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$KEY_FILE = "$env:USERPROFILE\.tauri\prynx.key"
$CONF_PATH = "$ROOT\desktop\src-tauri\tauri.conf.json"

$Version = $Version.Trim()
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$') {
    throw "-Version phai la SemVer hop le (vd 1.0.0-beta.13), nhan duoc: $Version"
}

# Release Free/Pro phai luon bien dich lai sidecar. Tai su dung binary cu co the
# bo sot feature gate moi va tao mot ban cai ma UI khoa nhung backend van mo.
if ($SkipNuitka) {
    throw "-SkipNuitka khong duoc phep khi phat hanh. Hay build lai sidecar de dam bao quyen Free/Pro dong bo."
}

# ---- NGUON CHAN LY DUY NHAT cho repo phat hanh ----
# App khach da nung cung endpoint updater trong tauri.conf.json; bao mat/cap nhat chi chay
# neu PHAT HANH dung repo do. Vi vay suy repo tu chinh endpoint, thay vi go tay (de nham
# -> client poll repo cu -> khong bao gio nhan update, ke ca ban va bao mat khan cap).
function Get-EndpointRepo {
    param([string]$ConfPath)
    if (-not (Test-Path $ConfPath)) { throw "Khong thay tauri.conf.json: $ConfPath" }
    $conf = Get-Content $ConfPath -Raw | ConvertFrom-Json
    $endpoints = $conf.plugins.updater.endpoints
    if (-not $endpoints -or $endpoints.Count -lt 1) { throw "tauri.conf.json: thieu plugins.updater.endpoints" }
    $ep = [string]$endpoints[0]
    if ($ep -notmatch 'github\.com/([^/]+/[^/]+)/releases') {
        throw "Endpoint updater khong phai GitHub releases hop le: $ep"
    }
    return $Matches[1]
}

$endpointRepo = Get-EndpointRepo -ConfPath $CONF_PATH
if ([string]::IsNullOrWhiteSpace($ReleaseRepo)) {
    $ReleaseRepo = $endpointRepo
    Write-Host "  [OK] Repo phat hanh suy tu endpoint: $ReleaseRepo" -ForegroundColor Green
}
elseif ($ReleaseRepo -ne $endpointRepo) {
    throw ("Repo phat hanh '$ReleaseRepo' KHAC repo trong endpoint updater '$endpointRepo'.`n" +
           "App khach CHI nhan update tu '$endpointRepo'. Bo tham so -ReleaseRepo (de tu suy), " +
           "hoac sua endpoint trong tauri.conf.json cho khop.")
}

Write-Host ""
Write-Host "  === PrynX Release v$Version -> $ReleaseRepo ===" -ForegroundColor Cyan
Write-Host ""

# ---- 0. Kiem tra dieu kien ----
if (-not (Test-Path $KEY_FILE)) { throw "Khong thay khoa ky updater: $KEY_FILE" }
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) { throw "Chua co GitHub CLI (gh). Cai: winget install GitHub.cli  roi 'gh auth login'." }
# Kiem tra gh da dang nhap
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw "gh chua dang nhap. Chay: gh auth login" }

# ---- 1. Dat bien moi truong ky updater ----
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $KEY_FILE -Raw)
# Chi ghi de password neu duoc truyen vao; neu khong, giu env da co (do GUI dat truoc).
if (-not [string]::IsNullOrEmpty($KeyPassword)) {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KeyPassword
}
Write-Host "  [OK] Da nap khoa ky updater." -ForegroundColor Green

# ---- 2. Bump version trong tauri.conf.json + package.json ----
# LƯU Ý: ghi UTF-8 KHONG BOM. Set-Content -Encoding utf8 (PS5) them BOM -> package.json
# hong JSON.parse cua node/vite. Dung UTF8Encoding($false).
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$confPath = "$ROOT\desktop\src-tauri\tauri.conf.json"
$conf = [System.IO.File]::ReadAllText($confPath, [System.Text.Encoding]::UTF8)
$conf = [regex]::Replace($conf, '("version"\s*:\s*")[^"]*(")', "`${1}$Version`${2}", 1)
[System.IO.File]::WriteAllText($confPath, $conf.TrimStart([char]0xFEFF), $utf8NoBom)
Write-Host "  [OK] Da dat version=$Version trong tauri.conf.json." -ForegroundColor Green

$pkgPath = "$ROOT\desktop\package.json"
$pkg = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
$pkg = [regex]::Replace($pkg, '("version"\s*:\s*")[^"]*(")', "`${1}$Version`${2}", 1)
[System.IO.File]::WriteAllText($pkgPath, $pkg.TrimStart([char]0xFEFF), $utf8NoBom)

$pkgLockPath = "$ROOT\desktop\package-lock.json"
$pkgLock = [System.IO.File]::ReadAllText($pkgLockPath, [System.Text.Encoding]::UTF8)
$pkgLock = [regex]::Replace(
    $pkgLock,
    '("name"\s*:\s*"prynx"\s*,\s*"version"\s*:\s*")[^"]*(")',
    ('${1}' + $Version + '${2}')
)
[System.IO.File]::WriteAllText($pkgLockPath, $pkgLock.TrimStart([char]0xFEFF), $utf8NoBom)

# Cargo.toml: dong bo version cho file properties cua PrynX.exe (Windows resource).
# Cargo chap nhan SemVer prerelease truc tiep (1.0.0-beta.9). Replace lan-dau CHI trung
# [package] version (dong dau), KHONG dung version cua tauri-build dependency ben duoi.
$cargoPath = "$ROOT\desktop\src-tauri\Cargo.toml"
$cargo = [System.IO.File]::ReadAllText($cargoPath, [System.Text.Encoding]::UTF8)
$cargo = [regex]::Replace($cargo, '(?m)^(version\s*=\s*")[^"]*(")', "`${1}$Version`${2}", 1)
[System.IO.File]::WriteAllText($cargoPath, $cargo.TrimStart([char]0xFEFF), $utf8NoBom)

$cargoLockPath = "$ROOT\desktop\src-tauri\Cargo.lock"
$cargoLock = [System.IO.File]::ReadAllText($cargoLockPath, [System.Text.Encoding]::UTF8)
$cargoLock = [regex]::Replace(
    $cargoLock,
    '(?ms)(\[\[package\]\]\s*name = "pdf-inspector"\s*version = ")[^"]*(")',
    ('${1}' + $Version + '${2}')
)
[System.IO.File]::WriteAllText($cargoLockPath, $cargoLock.TrimStart([char]0xFEFF), $utf8NoBom)
Write-Host "  [OK] Da dat version=$Version trong npm + Cargo (gom ca lockfiles)." -ForegroundColor Green

# ---- 3. Build day du + ky updater ----
if ($SkipNuitka) {
    Write-Host "  [..] Build (BO QUA Nuitka, dung lai sidecar cu) + frontend + tauri + KY updater..." -ForegroundColor Yellow
    $sidecar = "$ROOT\desktop\src-tauri\binaries\pdf-inspector-backend-x86_64-pc-windows-msvc.exe"
    if (-not (Test-Path $sidecar)) {
        throw "Bat -SkipNuitka nhung khong thay sidecar cu: $sidecar . Hay build day du it nhat 1 lan truoc."
    }
    & "$ROOT\build_production.ps1" -Release -SkipNuitka $(if ($SkipPreflightQA) { '-SkipPreflightQA' })
} else {
    Write-Host "  [..] Build (Nuitka + frontend + tauri + KY updater) - co the lau..." -ForegroundColor Yellow
    & "$ROOT\build_production.ps1" -Release $(if ($SkipPreflightQA) { '-SkipPreflightQA' })
}
if ($LASTEXITCODE -ne 0) { throw "Build that bai." }

# ---- 4. Tim installer NSIS + file chu ky .sig ----
$nsisDir = "$ROOT\desktop\src-tauri\target\release\bundle\nsis"
$setup = Get-ChildItem "$nsisDir\*$Version*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setup) { throw "Khong tim thay *-setup.exe trong $nsisDir" }
$sigFile = "$($setup.FullName).sig"
if (-not (Test-Path $sigFile)) { throw "Khong tim thay file chu ky: $sigFile (createUpdaterArtifacts chua bat? hoac ky that bai?)" }
$signature = (Get-Content $sigFile -Raw).Trim()
Write-Host "  [OK] Installer: $($setup.Name)" -ForegroundColor Green

# ---- 5. Tao latest.json ----
$tag = "v$Version"
$downloadUrl = "https://github.com/$ReleaseRepo/releases/download/$tag/$($setup.Name)"
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
if ([string]::IsNullOrWhiteSpace($Notes)) { $Notes = "PrynX $Version" }
$latest = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = $pubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $signature
            url       = $downloadUrl
        }
    }
}
$latestPath = "$nsisDir\latest.json"
# CRITICAL: PowerShell -Encoding utf8 = UTF-8 WITH BOM. Tauri updater (serde_json)
# KHONG chap nhan BOM → parse fail → client KHONG thay update. Dung .NET ghi KHONG BOM.
$jsonText = $latest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($latestPath, $jsonText, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] Da tao latest.json (url -> $downloadUrl)" -ForegroundColor Green

# ---- 6. Publish len GitHub Releases ----
Write-Host "  [..] Tao/cap nhat release $tag tren $ReleaseRepo va upload..." -ForegroundColor Yellow
# AN TOAN: KHONG xoa release cu truoc (tranh khoang trong neu create loi -> client mat 'latest').
# Tam tat Stop de gh.exe stderr ("release not found") khong abort script.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$null = & gh release view $tag --repo $ReleaseRepo 2>&1
$releaseExists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEAP

if ($releaseExists) {
    Write-Host "  [..] Release $tag da ton tai -> ghi de asset (clobber)..." -ForegroundColor Yellow
    & gh release upload $tag --repo $ReleaseRepo --clobber `
        "$($setup.FullName)" "$sigFile" "$latestPath"
    if ($LASTEXITCODE -ne 0) { throw "gh release upload (clobber) that bai." }
}
else {
    Write-Host "  [..] Release $tag chua ton tai -> tao moi..." -ForegroundColor Yellow
    & gh release create $tag --repo $ReleaseRepo --title "PrynX $Version" --notes $Notes `
        "$($setup.FullName)" "$sigFile" "$latestPath"
    if ($LASTEXITCODE -ne 0) { throw "gh release create that bai." }
}

Write-Host ""
Write-Host "  === PHAT HANH XONG. App khach se tu thay ban $Version. ===" -ForegroundColor Green
Write-Host "  Nho: endpoint trong tauri.conf.json phai tro toi:" -ForegroundColor DarkGray
Write-Host "       https://github.com/$ReleaseRepo/releases/latest/download/latest.json" -ForegroundColor DarkGray
Write-Host ""
