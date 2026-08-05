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
    [switch]$SkipPreflightQA                              # KHAN CAP: bo qua pytest Preflight truoc build
)
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$KEY_FILE = "$env:USERPROFILE\.tauri\prynx.key"
$CONF_PATH = "$ROOT\desktop\src-tauri\tauri.conf.json"

# Secret Supabase phải nằm trong kho DPAPI và chỉ được build_production giải mã
# đúng tại bước REST. Từ chối env để git/gh/process publisher không kế thừa key.
if (-not [string]::IsNullOrWhiteSpace($env:PRYNX_SUPABASE_SECRET_KEY) -or
    -not [string]::IsNullOrWhiteSpace($env:PRYNX_SUPABASE_SERVICE_KEY)) {
    Remove-Item Env:PRYNX_SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:PRYNX_SUPABASE_SERVICE_KEY -ErrorAction SilentlyContinue
    throw "Khong truyen Supabase secret qua environment cho publisher. Hay dung kho DPAPI cua PrynX."
}

# SEC (audit 2026-08-04 §REL.SIGNING): GUI có thể truyền mật khẩu qua env.
# Chụp rồi xóa trước mọi git/gh; build_production sẽ tiếp tục cô lập khóa chỉ
# quanh đúng tiến trình Tauri và xóa trước khi publisher chạy verifier/upload.
$releaseSigningPassword = if (-not [string]::IsNullOrEmpty($KeyPassword)) {
    [string]$KeyPassword
} else {
    [string]$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:PRYNX_TAURI_SIGNING_KEY_FILE -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
$KeyPassword = ""

$Version = $Version.Trim()
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$') {
    throw "-Version phai la SemVer hop le (vd 1.0.0-beta.13), nhan duoc: $Version"
}

if ($SkipPreflightQA) {
    throw "-SkipPreflightQA khong duoc phep khi phat hanh."
}

function Assert-CommittedReleaseVersion {
    param([Parameter(Mandatory = $true)][string]$ExpectedVersion)

    $dirty = @(& git -C $ROOT status --porcelain=v1 --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "Khong kiem tra duoc trang thai Git." }
    if ($dirty.Count -gt 0) {
        throw "Phat hanh chi duoc chay tu worktree sach da commit; tim thay $($dirty.Count) thay doi."
    }

    $tauriVersion = [string](Get-Content -LiteralPath $CONF_PATH -Raw | ConvertFrom-Json).version
    $packageVersion = [string](Get-Content -LiteralPath "$ROOT\desktop\package.json" -Raw | ConvertFrom-Json).version
    $packageLockText = Get-Content -LiteralPath "$ROOT\desktop\package-lock.json" -Raw
    $packageLockMatches = [regex]::Matches(
        $packageLockText,
        '"name"\s*:\s*"prynx"\s*,\s*"version"\s*:\s*"([^"]+)"'
    )
    $cargoText = Get-Content -LiteralPath "$ROOT\desktop\src-tauri\Cargo.toml" -Raw
    $cargoMatch = [regex]::Match($cargoText, '(?m)^version\s*=\s*"([^"]+)"')
    $cargoLockText = Get-Content -LiteralPath "$ROOT\desktop\src-tauri\Cargo.lock" -Raw
    $cargoLockMatch = [regex]::Match(
        $cargoLockText,
        '(?ms)\[\[package\]\]\s*name = "pdf-inspector"\s*version = "([^"]+)"'
    )
    $publisherConfig = Get-Content -LiteralPath "$ROOT\publisher.config.json" -Raw | ConvertFrom-Json
    $publisherVersion = [string]$publisherConfig.Version
    if ($packageLockMatches.Count -lt 1 -or -not $cargoMatch.Success -or -not $cargoLockMatch.Success) {
        throw "Khong doc duoc day du version da commit trong npm/Cargo lockfiles."
    }
    $versions = @(
        $tauriVersion,
        $packageVersion,
        $cargoMatch.Groups[1].Value,
        $cargoLockMatch.Groups[1].Value,
        $publisherVersion
    )
    $versions += @($packageLockMatches | ForEach-Object { $_.Groups[1].Value })
    if (@($versions | Where-Object { $_ -ne $ExpectedVersion }).Count -gt 0) {
        throw "Version trong source/lockfile chua dong bo voi $ExpectedVersion. Hay sua va commit truoc khi phat hanh."
    }
    Write-Host "  [OK] Version $ExpectedVersion da dong bo va worktree sach." -ForegroundColor Green
}

Assert-CommittedReleaseVersion -ExpectedVersion $Version

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

function Get-ReleaseManifestField {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $hits = @(Select-String -LiteralPath $Path -Pattern ("^" + [regex]::Escape($Name) + "\s*=\s*(.*)$"))
    if ($hits.Count -ne 1) {
        throw "Manifest phai co dung mot truong $Name; tim thay $($hits.Count)."
    }
    return $hits[0].Matches[0].Groups[1].Value.Trim()
}

function Assert-ManifestSourceState {
    param([Parameter(Mandatory = $true)][string]$ManifestPath)

    # BUILD (audit 2026-08-04 BLD.01): uploader chi chap nhan dung commit sach
    # da duoc build chot tu dau; khong doc mot HEAD moi roi gan nham cho artifact.
    $manifestCommit = Get-ReleaseManifestField -Path $ManifestPath -Name "GIT_COMMIT"
    if ($manifestCommit -notmatch '^[0-9a-fA-F]{40,64}$') {
        throw "Manifest GIT_COMMIT khong hop le."
    }
    if ((Get-ReleaseManifestField -Path $ManifestPath -Name "GIT_DIRTY") -ne "no") {
        throw "Manifest khong chung minh source sach; KHONG upload."
    }
    $dirty = @(& git -C $ROOT status --porcelain=v1 --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) {
        throw "Worktree thay doi sau build/verifier; KHONG upload."
    }
    $head = @(& git -C $ROOT rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $head[0].Trim() -ne $manifestCommit) {
        throw "Commit hien tai khong khop GIT_COMMIT cua artifact; KHONG upload."
    }
}

function Assert-GitHubCommitAvailable {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Commit
    )

    # BUILD (audit 2026-08-04 re-audit BLD): tag/release chi duoc tao cho commit
    # artifact da chot va commit do phai thuc su co tren repo dich.
    $raw = @(& gh api "repos/$Repo/commits/$Commit" 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "Commit artifact $Commit chua ton tai tren GitHub repo $Repo; KHONG upload."
    }
    try {
        $remoteCommit = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "Khong doc duoc commit $Commit tu GitHub repo $Repo; KHONG upload."
    }
    if ([string]$remoteCommit.sha -ne $Commit) {
        throw "GitHub tra ve commit $($remoteCommit.sha), khong khop artifact $Commit; KHONG upload."
    }
}

function Get-GitHubTagTargetCommit {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Tag
    )

    $raw = @(& gh api "repos/$Repo/git/ref/tags/$Tag" 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "Khong resolve duoc tag $Tag tren GitHub repo $Repo; KHONG upload."
    }
    try {
        $ref = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
        $object = $ref.object
    }
    catch {
        throw "GitHub tag $Tag tra ve JSON khong hop le; KHONG upload."
    }

    # Annotated tag co the tro qua mot tag object khac; dereference co gioi han
    # cho toi khi gap commit. Lightweight tag di thang vao nhanh commit.
    for ($depth = 0; $depth -lt 8; $depth++) {
        $objectType = [string]$object.type
        $objectSha = [string]$object.sha
        if ($objectSha -notmatch '^[0-9a-fA-F]{40,64}$') {
            throw "Tag $Tag co object SHA khong hop le; KHONG upload."
        }
        if ($objectType -eq "commit") { return $objectSha }
        if ($objectType -ne "tag") {
            throw "Tag $Tag tro toi object $objectType thay vi commit; KHONG upload."
        }

        $tagRaw = @(& gh api "repos/$Repo/git/tags/$objectSha" 2>$null)
        if ($LASTEXITCODE -ne 0) {
            throw "Khong dereference duoc annotated tag $Tag; KHONG upload."
        }
        try {
            $tagObject = ($tagRaw -join "`n") | ConvertFrom-Json -ErrorAction Stop
            $object = $tagObject.object
        }
        catch {
            throw "Annotated tag $Tag tra ve JSON khong hop le; KHONG upload."
        }
    }
    throw "Tag $Tag co chuoi dereference qua sau; KHONG upload."
}

function Assert-GitHubTagTargetsCommit {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Tag,
        [Parameter(Mandatory = $true)][string]$ExpectedCommit
    )

    $tagCommit = Get-GitHubTagTargetCommit -Repo $Repo -Tag $Tag
    if ($tagCommit -ne $ExpectedCommit) {
        throw "Tag $Tag dang tro toi $tagCommit, khong phai commit artifact $ExpectedCommit; KHONG clobber."
    }
}

function Assert-ReleaseManifestAttestation {
    param([Parameter(Mandatory = $true)][string]$ManifestPath)

    $required = @{
        BUILD_MODE = "public-release"
        BUILD_PROVENANCE = "git-clean-commit"
        SIDECAR_PROVENANCE = "compiled-this-run"
        PYTHON_ABI = "3.11"
        FRONTEND_FEATURE_GATE = "enabled"
        BACKEND_FEATURE_GATE = "enabled"
    }
    foreach ($name in $required.Keys) {
        $actual = Get-ReleaseManifestField -Path $ManifestPath -Name $name
        if ($actual -ne $required[$name]) {
            throw "Manifest $name=$actual, can $($required[$name]); KHONG upload."
        }
    }
}

function Assert-StagedReleaseAssets {
    param(
        [Parameter(Mandatory = $true)][string]$SetupPath,
        [Parameter(Mandatory = $true)][string]$SetupSha256,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][string]$SignatureSha256,
        [Parameter(Mandatory = $true)][string]$LatestPath,
        [Parameter(Mandatory = $true)][string]$LatestSha256
    )

    foreach ($path in @($SetupPath, $SignaturePath, $LatestPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Staged release asset bien mat: $path" }
    }
    if ((Get-FileHash -LiteralPath $SetupPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $SetupSha256 -or
        (Get-FileHash -LiteralPath $SignaturePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $SignatureSha256 -or
        (Get-FileHash -LiteralPath $LatestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $LatestSha256) {
        throw "Staged release asset thay doi sau runtime verification; KHONG upload."
    }
}

$endpointRepo = Get-EndpointRepo -ConfPath $CONF_PATH
$publisherConfig = Get-Content -LiteralPath "$ROOT\publisher.config.json" -Raw | ConvertFrom-Json
$publisherRepo = [string]$publisherConfig.Repo
$sourceRepo = [string]$publisherConfig.SourceRepo
$releaseTargetCommit = [string]$publisherConfig.ReleaseTargetCommit
if ($publisherRepo -ne $endpointRepo) {
    throw "publisher.config.json Repo=$publisherRepo, khac updater endpoint $endpointRepo."
}
if ($sourceRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $sourceRepo -eq $publisherRepo) {
    throw "publisher.config.json SourceRepo phai la repo source private va khac repo release public."
}
if ($releaseTargetCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw "publisher.config.json ReleaseTargetCommit phai la commit SHA-1 day du cua repo release public."
}
$releaseTargetCommit = $releaseTargetCommit.ToLowerInvariant()
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

# ---- 1. Chot duong dan khoa; build chi doc noi dung ngay truoc Tauri ----
Write-Host "  [OK] Da tim thay file khoa ky updater." -ForegroundColor Green

# ---- 2. Version da duoc dong bo/commit truoc khi vao script ----
# Script chi xac minh; tuyet doi khong sua source/lockfile trong phien phat hanh.

# ---- 3. Build day du + ky updater ----
# Dung splatting: chi them switch khi that su bat. Truoc day dung
# $(if($SkipPreflightQA){'-SkipPreflightQA'}) -> khi KHONG bat, bieu thuc tra $null
# va bi truyen nhu POSITIONAL arg -> roi vao param non-switch dau tien (NuitkaJobs)
# -> $null ep int = 0 -> ValidateRange(1,8) tu choi -> build chet truoc khi chay.
$buildArgs = @{ Release = $true }
if ($SkipPreflightQA) { $buildArgs.SkipPreflightQA = $true }
$buildExit = $null
try {
    # Chỉ truyền đường dẫn không bí mật. build_production chụp/xóa ngay đầu,
    # rồi đọc nội dung khóa just-in-time đúng lúc gọi Tauri.
    $env:PRYNX_TAURI_SIGNING_KEY_FILE = $KEY_FILE
    if (-not [string]::IsNullOrEmpty($releaseSigningPassword)) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $releaseSigningPassword
    }
    Write-Host "  [..] Build (Nuitka + frontend + tauri + KY updater) - co the lau..." -ForegroundColor Yellow
    & "$ROOT\build_production.ps1" @buildArgs
    $buildExit = $LASTEXITCODE
} finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:PRYNX_TAURI_SIGNING_KEY_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    $releaseSigningPassword = $null
}
if ($buildExit -ne 0) { throw "Build that bai." }

# ---- 4. Tim dung installer vua build + file chu ky .sig ----
$nsisDir = "$ROOT\desktop\src-tauri\target\release\bundle\nsis"
$manifestPath = "$ROOT\Ban_Phat_Hanh\release-manifest.txt"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Build khong tao release manifest: $manifestPath"
}
$manifestVersion = Get-ReleaseManifestField -Path $manifestPath -Name "APP_VERSION"
if ($manifestVersion -ne $Version) {
    throw "Manifest APP_VERSION=$manifestVersion, khac release version $Version."
}
Assert-ReleaseManifestAttestation -ManifestPath $manifestPath
Assert-ManifestSourceState -ManifestPath $manifestPath
$setupName = Get-ReleaseManifestField -Path $manifestPath -Name "INSTALLER"
if ([System.IO.Path]::GetFileName($setupName) -ne $setupName) {
    throw "Manifest INSTALLER khong phai ten file an toan: $setupName"
}
$setupPath = Join-Path $nsisDir $setupName
$publishedSetupPath = Join-Path "$ROOT\Ban_Phat_Hanh" $setupName
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw "Khong tim thay installer vua build: $setupPath" }
if (-not (Test-Path -LiteralPath $publishedSetupPath -PathType Leaf)) { throw "Khong tim thay ban copy de verify: $publishedSetupPath" }
$setup = Get-Item -LiteralPath $setupPath
$manifestInstallerHash = (Get-ReleaseManifestField -Path $manifestPath -Name "INSTALLER_SHA256").ToLowerInvariant()
$setupHash = (Get-FileHash -LiteralPath $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$publishedSetupHash = (Get-FileHash -LiteralPath $publishedSetupPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($setupHash -ne $manifestInstallerHash -or $publishedSetupHash -ne $manifestInstallerHash) {
    throw "Installer bundle/publish khong khop INSTALLER_SHA256 trong manifest."
}
$sigFile = "$($setup.FullName).sig"
if (-not (Test-Path -LiteralPath $sigFile -PathType Leaf)) { throw "Khong tim thay file chu ky: $sigFile (createUpdaterArtifacts chua bat? hoac ky that bai?)" }
if ((Get-Item -LiteralPath $sigFile).LastWriteTimeUtc -lt $setup.LastWriteTimeUtc) {
    throw "File chu ky cu hon installer vua build; tu choi dung chu ky stale: $sigFile"
}
$signature = (Get-Content $sigFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($signature)) { throw "File chu ky updater rong: $sigFile" }
Write-Host "  [OK] Installer: $($setup.Name)" -ForegroundColor Green

$stageParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$releaseStageDir = Join-Path $stageParent ("PrynXReleaseStage-" + [guid]::NewGuid().ToString("N"))
if (-not ([System.IO.Path]::GetFullPath($releaseStageDir)).StartsWith($stageParent + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release staging escaped Temp: $releaseStageDir"
}
try {
New-Item -ItemType Directory -Force -Path $releaseStageDir | Out-Null
$stagedSetupPath = Join-Path $releaseStageDir $setup.Name
$stagedSigPath = Join-Path $releaseStageDir ((Split-Path -Leaf $sigFile))
Copy-Item -LiteralPath $setup.FullName -Destination $stagedSetupPath -ErrorAction Stop
Copy-Item -LiteralPath $sigFile -Destination $stagedSigPath -ErrorAction Stop
$signature = (Get-Content -LiteralPath $stagedSigPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($signature)) { throw "Staged updater signature rong." }
$stagedSignatureHash = (Get-FileHash -LiteralPath $stagedSigPath -Algorithm SHA256).Hash.ToLowerInvariant()

# ---- 5. Bat buoc nghiem thu artifact da cai truoc upload ----
# BUILD (audit 2026-08-03 REL.10): uploader khong duoc tin moi ma thoat build.
$verifier = "$ROOT\scripts\verify_installed_artifact.ps1"
if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { throw "Thieu installed-artifact verifier: $verifier" }
Write-Host "  [..] Cai tam va chay runtime smoke truoc khi cho phep upload..." -ForegroundColor Yellow
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifier `
    -Installer $stagedSetupPath -Manifest $manifestPath -ExpectedVersion $Version -ExpectNoGhostscript
if ($LASTEXITCODE -ne 0) { throw "Installed-artifact verifier that bai; KHONG upload GitHub." }

$runtimeVerified = Get-ReleaseManifestField -Path $manifestPath -Name "RUNTIME_VERIFIED"
$installedExeHash = Get-ReleaseManifestField -Path $manifestPath -Name "EXE_SHA256"
$dielineLocked = Get-ReleaseManifestField -Path $manifestPath -Name "DIELINE_LOCKED"
$runtimeFreeProGate = Get-ReleaseManifestField -Path $manifestPath -Name "RUNTIME_FREE_PRO_GATE"
if ($runtimeVerified -ne "yes" -or $installedExeHash -eq "NOT_VERIFIED_INSTALL_PAYLOAD") {
    throw "Manifest chua co bang chung runtime day du; KHONG upload GitHub."
}
if ($dielineLocked -ne "yes") {
    throw "DIELINE_LOCKED khong phai yes; KHONG upload release."
}
if ($runtimeFreeProGate -ne "enabled+free-denied-prepress.preflight") {
    throw "Artifact chua chung minh Free bi tu choi capability Pro; KHONG upload."
}
Write-Host "  [OK] Runtime verifier dat; manifest da dong bang chung." -ForegroundColor Green

# ---- 6. Tao latest.json ----
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
$stagedLatestPath = Join-Path $releaseStageDir "latest.json"
Copy-Item -LiteralPath $latestPath -Destination $stagedLatestPath -ErrorAction Stop
$stagedLatestHash = (Get-FileHash -LiteralPath $stagedLatestPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "  [OK] Da tao latest.json (url -> $downloadUrl)" -ForegroundColor Green

# ---- 7. Publish len GitHub Releases ----
Write-Host "  [..] Tao/cap nhat release $tag tren $ReleaseRepo va upload..." -ForegroundColor Yellow
Assert-ManifestSourceState -ManifestPath $manifestPath
$manifestCommit = Get-ReleaseManifestField -Path $manifestPath -Name "GIT_COMMIT"
# SEC (audit 2026-08-06 REL.PUBLISH): manifestCommit la source private. Kiem tra
# no tren SourceRepo; KHONG day object source sang repo updater public de thoa SHA.
Assert-GitHubCommitAvailable -Repo $sourceRepo -Commit $manifestCommit
# Repo updater public chi chua asset. Tag release luon neo vao commit README da
# pin, va commit pin phai ton tai truoc khi tao/cap nhat release.
Assert-GitHubCommitAvailable -Repo $ReleaseRepo -Commit $releaseTargetCommit
# AN TOAN: KHONG xoa release cu truoc (tranh khoang trong neu create loi -> client mat 'latest').
# Tam tat Stop de gh.exe stderr ("release not found") khong abort script.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$null = & gh release view $tag --repo $ReleaseRepo 2>&1
$releaseExists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEAP

if ($releaseExists) {
    Write-Host "  [..] Release $tag da ton tai -> ghi de asset (clobber)..." -ForegroundColor Yellow
    Assert-ManifestSourceState -ManifestPath $manifestPath
    Assert-StagedReleaseAssets -SetupPath $stagedSetupPath -SetupSha256 $manifestInstallerHash `
        -SignaturePath $stagedSigPath -SignatureSha256 $stagedSignatureHash `
        -LatestPath $stagedLatestPath -LatestSha256 $stagedLatestHash
    Assert-GitHubTagTargetsCommit -Repo $ReleaseRepo -Tag $tag -ExpectedCommit $releaseTargetCommit
    & gh release upload $tag --repo $ReleaseRepo --clobber `
        "$stagedSetupPath" "$stagedSigPath" "$stagedLatestPath"
    if ($LASTEXITCODE -ne 0) { throw "gh release upload (clobber) that bai." }
}
else {
    Write-Host "  [..] Release $tag chua ton tai -> tao moi..." -ForegroundColor Yellow
    Assert-ManifestSourceState -ManifestPath $manifestPath
    Assert-StagedReleaseAssets -SetupPath $stagedSetupPath -SetupSha256 $manifestInstallerHash `
        -SignaturePath $stagedSigPath -SignatureSha256 $stagedSignatureHash `
        -LatestPath $stagedLatestPath -LatestSha256 $stagedLatestHash
    & gh release create $tag --repo $ReleaseRepo --target $releaseTargetCommit --title "PrynX $Version" --notes $Notes `
        "$stagedSetupPath" "$stagedSigPath" "$stagedLatestPath"
    if ($LASTEXITCODE -ne 0) { throw "gh release create that bai." }
}

Write-Host ""
Write-Host "  === PHAT HANH XONG. App khach se tu thay ban $Version. ===" -ForegroundColor Green
Write-Host "  Nho: endpoint trong tauri.conf.json phai tro toi:" -ForegroundColor DarkGray
Write-Host "       https://github.com/$ReleaseRepo/releases/latest/download/latest.json" -ForegroundColor DarkGray
Write-Host ""
} finally {
    if (Test-Path -LiteralPath $releaseStageDir) {
        $resolvedStage = [System.IO.Path]::GetFullPath($releaseStageDir)
        if (-not $resolvedStage.StartsWith($stageParent + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Tu choi cleanup release staging ngoai Temp: $resolvedStage"
        }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
