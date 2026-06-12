# ============================================================
#  PrynX - Release + Auto-Update Publisher (one shot)
#  build (sidecar+frontend+tauri, KY updater) -> latest.json
#  -> upload len GitHub Releases (public repo) qua gh CLI.
#  ASCII-only (Windows PowerShell parse .ps1 theo ANSI khi khong BOM).
#
#  Vi du:
#    .\release_update.ps1 -Version 1.0.1 -ReleaseRepo "liendaobds-sudo/pdfcompare-releases"
# ============================================================
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$ReleaseRepo,   # vd: owner/pdfcompare-releases (PUBLIC)
    [string]$KeyPassword = "",                            # mat khau cua ~/.tauri/prynx.key (de trong neu khong dat)
    [string]$Notes = "",
    [switch]$SkipNuitka                                   # Bo qua bien dich backend (dung lai sidecar cu khi backend khong doi)
)
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$KEY_FILE = "$env:USERPROFILE\.tauri\prynx.key"

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
$conf = Get-Content $confPath -Raw
$conf = [regex]::Replace($conf, '("version"\s*:\s*")[^"]*(")', "`${1}$Version`${2}", 1)
[System.IO.File]::WriteAllText($confPath, $conf.TrimStart([char]0xFEFF), $utf8NoBom)
Write-Host "  [OK] Da dat version=$Version trong tauri.conf.json." -ForegroundColor Green

$pkgPath = "$ROOT\desktop\package.json"
$pkg = Get-Content $pkgPath -Raw
$pkg = [regex]::Replace($pkg, '("version"\s*:\s*")[^"]*(")', "`${1}$Version`${2}", 1)
[System.IO.File]::WriteAllText($pkgPath, $pkg.TrimStart([char]0xFEFF), $utf8NoBom)

# ---- 3. Build day du + ky updater ----
if ($SkipNuitka) {
    Write-Host "  [..] Build (BO QUA Nuitka, dung lai sidecar cu) + frontend + tauri + KY updater..." -ForegroundColor Yellow
    $sidecar = "$ROOT\desktop\src-tauri\binaries\pdf-inspector-backend-x86_64-pc-windows-msvc.exe"
    if (-not (Test-Path $sidecar)) {
        throw "Bat -SkipNuitka nhung khong thay sidecar cu: $sidecar . Hay build day du it nhat 1 lan truoc."
    }
    & "$ROOT\build_production.ps1" -Release -SkipNuitka
} else {
    Write-Host "  [..] Build (Nuitka + frontend + tauri + KY updater) - co the lau..." -ForegroundColor Yellow
    & "$ROOT\build_production.ps1" -Release
}
if ($LASTEXITCODE -ne 0) { throw "Build that bai." }

# ---- 4. Tim installer NSIS + file chu ky .sig ----
$nsisDir = "$ROOT\desktop\src-tauri\target\release\bundle\nsis"
$setup = Get-ChildItem "$nsisDir\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
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
$latest | ConvertTo-Json -Depth 6 | Set-Content $latestPath -Encoding utf8
Write-Host "  [OK] Da tao latest.json (url -> $downloadUrl)" -ForegroundColor Green

# ---- 6. Publish len GitHub Releases ----
Write-Host "  [..] Tao release $tag tren $ReleaseRepo va upload..." -ForegroundColor Yellow
# Xoa release cu cung tag neu co (tranh trung), bo qua loi neu chua ton tai
& gh release delete $tag --repo $ReleaseRepo --yes *> $null
& gh release create $tag --repo $ReleaseRepo --title "PrynX $Version" --notes $Notes `
    "$($setup.FullName)" "$sigFile" "$latestPath"
if ($LASTEXITCODE -ne 0) { throw "gh release create that bai." }

Write-Host ""
Write-Host "  === PHAT HANH XONG. App khach se tu thay ban $Version. ===" -ForegroundColor Green
Write-Host "  Nho: endpoint trong tauri.conf.json phai tro toi:" -ForegroundColor DarkGray
Write-Host "       https://github.com/$ReleaseRepo/releases/latest/download/latest.json" -ForegroundColor DarkGray
Write-Host ""
