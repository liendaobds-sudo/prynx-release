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
$CONF_PATH = "$ROOT\desktop\src-tauri\tauri.conf.json"

# SEC (audit 2026-09-04 §SEC.24-R6): bootstrap chi dung .NET thuan de chup va
# xoa secret/cac bien dinh tuyen truoc dot-source guard co the chay Add-Type/csc.
$ambientSupabaseSecretNames = @(
    'PRYNX_SUPABASE_SECRET_KEY',
    'PRYNX_SUPABASE_SERVICE_KEY'
) | Where-Object {
    -not [string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable(
            $_,
            [EnvironmentVariableTarget]::Process
        )
    )
}
$releaseSigningPassword = if (-not [string]::IsNullOrEmpty($KeyPassword)) {
    [string]$KeyPassword
} else {
    [string]$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
$bootstrapEnvironment = [Environment]::GetEnvironmentVariables(
    [EnvironmentVariableTarget]::Process
)
$ambientGitAuthorityOverrides = @(
    foreach ($bootstrapKey in @($bootstrapEnvironment.Keys)) {
        $bootstrapName = [string]$bootstrapKey
        if ($bootstrapName -match '^(?i:GIT_|GH_)' -or $bootstrapName -iin @(
                'GITHUB_TOKEN',
                'GITHUB_ENTERPRISE_TOKEN',
                'XDG_CONFIG_HOME'
            )) {
            $bootstrapName
        }
    }
) | Sort-Object -Unique
foreach ($bootstrapName in @(
        'PRYNX_SUPABASE_SECRET_KEY',
        'PRYNX_SUPABASE_SERVICE_KEY',
        'TAURI_SIGNING_PRIVATE_KEY',
        'PRYNX_TAURI_SIGNING_KEY_FILE',
        'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'
    ) + @($ambientGitAuthorityOverrides)) {
    [Environment]::SetEnvironmentVariable(
        [string]$bootstrapName,
        $null,
        [EnvironmentVariableTarget]::Process
    )
}
$bootstrapEnvironment = $null
$KeyPassword = ""

. "$ROOT\scripts\release_executable_guard.ps1"
$KEY_FILE = Resolve-PrynXUpdaterSigningKeyPath

# Secret Supabase phai nam trong kho DPAPI va chi duoc build_production giai ma
# dung tai buoc REST. Tu choi env sau khi da xoa truoc moi process con.
if ($ambientSupabaseSecretNames.Count -gt 0) {
    throw "Khong truyen Supabase secret qua environment cho publisher. Hay dung kho DPAPI cua PrynX."
}

# SEC (audit 2026-09-04 SEC.24-R5): khong cho Git/GitHub CLI ke thua repo
# hoac hostname do process cha chi dinh. Xoa truoc khi fail de child khong thay.
$null = Clear-PrynXAmbientGitAuthorityOverrides
if ($ambientGitAuthorityOverrides.Count -gt 0) {
    throw "SEC: Publisher tu choi ambient Git/GitHub override: $($ambientGitAuthorityOverrides -join ', ')."
}
Assert-PrynXGitEnvironmentAuthority

$Version = $Version.Trim()
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?\z') {
    throw "-Version phai la SemVer hop le (vd 1.0.0-beta.13), nhan duoc: $Version"
}

if ($SkipPreflightQA) {
    throw "-SkipPreflightQA khong duoc phep khi phat hanh."
}

function Assert-CommittedReleaseVersion {
    param([Parameter(Mandatory = $true)][string]$ExpectedVersion)

    Assert-PrynXGitRepositoryAuthority `
        -GitPath $script:PrynXGit `
        -ExpectedRoot $ROOT
    $dirtyResult = Invoke-PrynXGitReadOnlyCommand `
        -GitPath $script:PrynXGit `
        -ExpectedRoot $ROOT `
        -Command 'status' `
        -Arguments @('--porcelain=v1', '--untracked-files=all')
    $dirty = @($dirtyResult.Output)
    if ($dirtyResult.ExitCode -ne 0) { throw "Khong kiem tra duoc trang thai Git." }
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

# SEC (audit 2026-09-04 SEC.24-R2): giu Git authority lease tu truoc
# preflight dau tien den khi publish/cleanup xong; khong resolve lai qua PATH.
$gitLease = $null
try {
    $gitLease = Open-PrynXTrustedReleaseExecutableLease -Kind "Git"
    $script:PrynXGit = $gitLease.Path

Assert-CommittedReleaseVersion -ExpectedVersion $Version

# ---- NGUON CHAN LY DUY NHAT cho repo phat hanh ----
# App khach da nung cung endpoint updater trong tauri.conf.json; bao mat/cap nhat chi chay
# neu PHAT HANH dung repo do. Vi vay suy repo tu chinh endpoint, thay vi go tay (de nham
# -> client poll repo cu -> khong bao gio nhan update, ke ca ban va bao mat khan cap).
function Get-EndpointRepo {
    param([string]$ConfPath)
    $configFull = Assert-PrynXNoReparsePointInPathComponents -Path $ConfPath
    if (-not (Test-Path -LiteralPath $configFull -PathType Leaf)) {
        throw "Khong thay tauri.conf.json: $ConfPath"
    }
    $conf = Get-Content -LiteralPath $configFull -Raw | ConvertFrom-Json
    $endpoints = @($conf.plugins.updater.endpoints)
    if ($endpoints.Count -ne 1) {
        throw "tauri.conf.json phai co dung mot plugins.updater.endpoints."
    }
    $endpoint = [string]$endpoints[0]
    if (-not [string]::Equals(
            $endpoint,
            $endpoint.Trim(),
            [System.StringComparison]::Ordinal
        )) {
        throw "Endpoint updater khong duoc co whitespace bao quanh: $endpoint"
    }
    # SEC (audit 2026-09-04 §SEC.24-R5): gate raw syntax truoc System.Uri
    # de delimiter rong (`@`, `:`, `?`, `#`) khong bi normalize mat.
    $endpointSyntaxMatch = [regex]::Match(
        $endpoint,
        '^(?i:https://github\.com)/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/releases/latest/download/latest\.json$',
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    if (-not $endpointSyntaxMatch.Success) {
        throw "Endpoint updater khong dung canonical GitHub release URI: $endpoint"
    }
    $uri = $null
    if ([string]::IsNullOrWhiteSpace($endpoint) -or
        -not [System.Uri]::TryCreate(
            $endpoint,
            [System.UriKind]::Absolute,
            [ref]$uri
        )) {
        throw "Endpoint updater khong phai absolute URI hop le: $endpoint"
    }
    if (-not [string]::Equals(
            $uri.Scheme,
            'https',
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [string]::Equals(
            $uri.DnsSafeHost,
            'github.com',
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not $uri.IsDefaultPort -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "Endpoint updater phai dung HTTPS tren github.com va khong co authority/query/fragment phu: $endpoint"
    }
    $owner = $endpointSyntaxMatch.Groups[1].Value
    $repo = $endpointSyntaxMatch.Groups[2].Value
    if ($owner -in @('.', '..') -or $repo -in @('.', '..')) {
        throw "Endpoint updater co owner/repo khong hop le: $endpoint"
    }
    return $owner + '/' + $repo
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

function Assert-ReleaseSecretScanEvidenceV2 {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$SetupSha256
    )

    # SEC (audit 2026-09-04 SEC.20/23-L3): v1 chi co installed tree nen khong
    # du de upload. V2 phai bind installer manifest, setup dang lease va hai
    # digest rieng cua installed tree/Nuitka extraction.
    $evidence = Get-ReleaseManifestField `
        -Path $ManifestPath `
        -Name 'RELEASE_SECRET_SCAN_V2'
    $manifestInstallerSha256 = Get-ReleaseManifestField `
        -Path $ManifestPath `
        -Name 'INSTALLER_SHA256'
    return Assert-PrynXReleaseSecretScanEvidenceV2 `
        -Evidence $evidence `
        -ManifestInstallerSha256 $manifestInstallerSha256 `
        -SetupSha256 $SetupSha256
}

function Assert-ManifestSourceState {
    param([Parameter(Mandatory = $true)][string]$ManifestPath)

    Assert-PrynXGitRepositoryAuthority `
        -GitPath $script:PrynXGit `
        -ExpectedRoot $ROOT
    # BUILD (audit 2026-08-04 BLD.01): uploader chi chap nhan dung commit sach
    # da duoc build chot tu dau; khong doc mot HEAD moi roi gan nham cho artifact.
    $manifestCommit = Get-ReleaseManifestField -Path $ManifestPath -Name "GIT_COMMIT"
    if ($manifestCommit -notmatch '^[0-9a-fA-F]{40,64}$') {
        throw "Manifest GIT_COMMIT khong hop le."
    }
    if ((Get-ReleaseManifestField -Path $ManifestPath -Name "GIT_DIRTY") -ne "no") {
        throw "Manifest khong chung minh source sach; KHONG upload."
    }
    $dirtyResult = Invoke-PrynXGitReadOnlyCommand `
        -GitPath $script:PrynXGit `
        -ExpectedRoot $ROOT `
        -Command 'status' `
        -Arguments @('--porcelain=v1', '--untracked-files=all')
    $dirty = @($dirtyResult.Output)
    if ($dirtyResult.ExitCode -ne 0 -or $dirty.Count -gt 0) {
        throw "Worktree thay doi sau build/verifier; KHONG upload."
    }
    $headResult = Invoke-PrynXGitReadOnlyCommand `
        -GitPath $script:PrynXGit `
        -ExpectedRoot $ROOT `
        -Command 'rev-parse' `
        -Arguments @('HEAD')
    $head = @($headResult.Output)
    if ($headResult.ExitCode -ne 0 -or $head.Count -ne 1 -or $head[0].Trim() -ne $manifestCommit) {
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
    $apiResult = Invoke-PrynXGitHubCliCommand `
        -GitHubCliPath $script:PrynXGitHubCli `
        -Command 'api' `
        -Arguments @('--hostname', 'github.com', "repos/$Repo/commits/$Commit")
    $raw = @($apiResult.Output)
    if ($apiResult.ExitCode -ne 0) {
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

    $apiResult = Invoke-PrynXGitHubCliCommand `
        -GitHubCliPath $script:PrynXGitHubCli `
        -Command 'api' `
        -Arguments @('--hostname', 'github.com', "repos/$Repo/git/ref/tags/$Tag")
    $raw = @($apiResult.Output)
    if ($apiResult.ExitCode -ne 0) {
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

        $apiResult = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $script:PrynXGitHubCli `
            -Command 'api' `
            -Arguments @('--hostname', 'github.com', "repos/$Repo/git/tags/$objectSha")
        $tagRaw = @($apiResult.Output)
        if ($apiResult.ExitCode -ne 0) {
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

function Test-GitHubReleaseExists {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Tag
    )

    $encodedTag = [System.Uri]::EscapeDataString($Tag)
    # Wrapper ha EAP va capture stderr de phan loai 404 co chu dich.
    $apiResult = Invoke-PrynXGitHubCliCommand `
        -GitHubCliPath $script:PrynXGitHubCli `
        -Command 'api' `
        -Arguments @('--hostname', 'github.com', "repos/$Repo/releases/tags/$encodedTag")
    $raw = @($apiResult.Output)
    $apiExit = $apiResult.ExitCode
    if ($apiExit -eq 0) {
        try {
            $release = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw "GitHub release $Tag tra ve JSON khong hop le; KHONG tiep tuc."
        }
        if ([string]$release.tag_name -ne $Tag) {
            throw "GitHub tra ve release tag $($release.tag_name), khong khop $Tag; KHONG tiep tuc."
        }
        return $true
    }

    # Chi HTTP 404 moi co nghia release chua ton tai. Loi mang/quyen/API phai fail-closed.
    $failure = $raw -join "`n"
    if ($failure -match '(?i)\bHTTP\s+404\b') { return $false }
    throw "Khong kiem tra duoc release $Tag tren GitHub repo $Repo; KHONG tiep tuc."
}

function Test-GitHubTagExists {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Tag
    )

    # matching-refs tra mang rong voi HTTP 200 khi tag chua co, nen khong can bien
    # moi loi gh thanh "khong ton tai". Loc lai exact ref de tranh trung prefix.
    $encodedTag = [System.Uri]::EscapeDataString($Tag)
    $apiResult = Invoke-PrynXGitHubCliCommand `
        -GitHubCliPath $script:PrynXGitHubCli `
        -Command 'api' `
        -Arguments @('--hostname', 'github.com', "repos/$Repo/git/matching-refs/tags/$encodedTag")
    $raw = @($apiResult.Output)
    if ($apiResult.ExitCode -ne 0) {
        throw "Khong kiem tra duoc tag $Tag tren GitHub repo $Repo; KHONG tiep tuc."
    }
    try {
        $refs = @(($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        throw "Danh sach tag $Tag tu GitHub khong hop le; KHONG tiep tuc."
    }
    $exactRefs = @($refs | Where-Object { [string]$_.ref -eq "refs/tags/$Tag" })
    if ($exactRefs.Count -gt 1) {
        throw "GitHub tra ve nhieu ref trung tag $Tag; KHONG tiep tuc."
    }
    return ($exactRefs.Count -eq 1)
}

function Assert-GitHubReleaseTagState {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Tag,
        [Parameter(Mandatory = $true)][string]$ExpectedCommit
    )

    $releaseExists = Test-GitHubReleaseExists -Repo $Repo -Tag $Tag
    $tagExists = Test-GitHubTagExists -Repo $Repo -Tag $Tag
    if ($releaseExists) {
        if (-not $tagExists) {
            throw "Release $Tag da ton tai nhung tag GitHub bi thieu; KHONG clobber."
        }
        Assert-GitHubTagTargetsCommit -Repo $Repo -Tag $Tag -ExpectedCommit $ExpectedCommit
    }
    elseif ($tagExists) {
        throw "Tag $Tag da ton tai nhung chua co release; KHONG tu suy de ghi de. Hay xu ly tag nay truoc."
    }
    return $releaseExists
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
$githubCliLease = $null
try {
if (-not (Test-Path -LiteralPath $KEY_FILE -PathType Leaf)) {
    throw "Khong thay khoa ky updater: $KEY_FILE"
}
$githubCliLease = Open-PrynXTrustedReleaseExecutableLease -Kind "GitHubCli"
$script:PrynXGitHubCli = $githubCliLease.Path
# Kiem tra gh da dang nhap
Assert-PrynXGitEnvironmentAuthority
$authResult = Invoke-PrynXGitHubCliCommand `
    -GitHubCliPath $script:PrynXGitHubCli `
    -Command 'auth' `
    -Arguments @('status', '--hostname', 'github.com')
if ($authResult.ExitCode -ne 0) { throw "gh chua dang nhap. Chay: gh auth login --hostname github.com" }

# BUILD (audit 2026-08-13 BR.02): nhung loi remote da biet phai dung truoc
# Nuitka/Tauri/runtime verifier. Van kiem lai cung cac bat bien ngay truoc upload.
Assert-PrynXGitRepositoryAuthority `
    -GitPath $script:PrynXGit `
    -ExpectedRoot $ROOT
$sourceHeadResult = Invoke-PrynXGitReadOnlyCommand `
    -GitPath $script:PrynXGit `
    -ExpectedRoot $ROOT `
    -Command 'rev-parse' `
    -Arguments @('HEAD')
$sourceHeadLines = @($sourceHeadResult.Output)
if ($sourceHeadResult.ExitCode -ne 0 -or $sourceHeadLines.Count -ne 1 -or
    $sourceHeadLines[0].Trim() -notmatch '^[0-9a-fA-F]{40}$') {
    throw "Khong doc duoc source commit hien tai de preflight GitHub."
}
$sourceHead = $sourceHeadLines[0].Trim().ToLowerInvariant()
$tag = "v$Version"
Assert-GitHubCommitAvailable -Repo $sourceRepo -Commit $sourceHead
Assert-GitHubCommitAvailable -Repo $ReleaseRepo -Commit $releaseTargetCommit
$preflightReleaseExists = Assert-GitHubReleaseTagState -Repo $ReleaseRepo -Tag $tag `
    -ExpectedCommit $releaseTargetCommit
if ($preflightReleaseExists) {
    Write-Host "  [OK] GitHub preflight: source/target/release $tag hop le." -ForegroundColor Green
}
else {
    Write-Host "  [OK] GitHub preflight: source/target hop le; $tag san sang tao moi." -ForegroundColor Green
}

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
if (-not (Test-Path -LiteralPath $sigFile -PathType Leaf)) { throw "Khong tim thay file chu ky: $sigFile (Tauri signer chua chay hoac ky that bai?)" }
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
$cleanUserVerifier = "$ROOT\scripts\verify_artifact_clean_user.ps1"
if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { throw "Thieu installed-artifact verifier: $verifier" }
if (-not (Test-Path -LiteralPath $cleanUserVerifier -PathType Leaf)) { throw "Thieu clean-user verifier: $cleanUserVerifier" }
Write-Host "  [..] Cai tam va chay runtime smoke truoc khi cho phep upload..." -ForegroundColor Yellow
$existingPrynXRegistryPaths = @(
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\PrynX",
    "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\PrynX",
    "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\PrynX",
    "Registry::HKEY_CURRENT_USER\Software\prynx\PrynX",
    "Registry::HKEY_LOCAL_MACHINE\Software\prynx\PrynX",
    "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\prynx\PrynX"
)
$needsCleanUserSmoke = @($existingPrynXRegistryPaths | Where-Object {
    Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue
}).Count -gt 0
$verifierPowerShellLease = $null
try {
    # SEC (audit 2026-09-04 SEC.24-R2): ca nhanh UAC va nhanh hien tai deu
    # chay dung Windows PowerShell da lease, khong resolve qua PATH.
    $verifierPowerShellLease = Open-PrynXTrustedReleaseExecutableLease -Kind "WindowsPowerShell"
    $verifierPowerShellPath = $verifierPowerShellLease.Path
    if ($needsCleanUserSmoke) {
        # BUILD (audit 2026-08-12 REL.CLEANUSER.AUTO): may phat hanh thuong da cai
        # PrynX; UAC dung de smoke tren profile tam sach, khong ghi de ban dang dung.
        Write-Host "  [..] May da cai PrynX; chuyen sang profile Windows tam sach..." -ForegroundColor Yellow
        $cleanUserArgs = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $cleanUserVerifier + '"'),
            "-Installer", ('"' + $publishedSetupPath + '"'),
            "-Manifest", ('"' + $manifestPath + '"'),
            "-ExpectedVersion", $Version
        )
        $cleanUserProcess = Start-Process -FilePath $verifierPowerShellPath -ArgumentList $cleanUserArgs `
            -Verb RunAs -Wait -PassThru
        if ($cleanUserProcess.ExitCode -ne 0) {
            throw "Clean-user installed-artifact verifier that bai; KHONG upload GitHub."
        }
    } else {
        & $verifierPowerShellPath -NoProfile -ExecutionPolicy Bypass -File $verifier `
            -Installer $stagedSetupPath -Manifest $manifestPath -ExpectedVersion $Version
        if ($LASTEXITCODE -ne 0) { throw "Installed-artifact verifier that bai; KHONG upload GitHub." }
    }
}
finally {
    Close-PrynXReleaseExecutableLease -Lease $verifierPowerShellLease
}

$runtimeVerified = Get-ReleaseManifestField -Path $manifestPath -Name "RUNTIME_VERIFIED"
$installedExeHash = Get-ReleaseManifestField -Path $manifestPath -Name "EXE_SHA256"
$dielineLocked = Get-ReleaseManifestField -Path $manifestPath -Name "DIELINE_LOCKED"
$runtimeFreeProGate = Get-ReleaseManifestField -Path $manifestPath -Name "RUNTIME_FREE_PRO_GATE"
$releaseSecretScanEvidenceV2 = Assert-ReleaseSecretScanEvidenceV2 `
    -ManifestPath $manifestPath `
    -SetupSha256 $setupHash
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
# BUILD (audit 2026-08-13 BR.02): recheck de chan HEAD/tag/release doi trong luc build.
$releaseExists = Assert-GitHubReleaseTagState -Repo $ReleaseRepo -Tag $tag `
    -ExpectedCommit $releaseTargetCommit
if ($releaseExists -ne $preflightReleaseExists) {
    throw "Trang thai release $tag da thay doi trong luc build; KHONG tu chuyen tao moi/ghi de. Hay chay lai preflight."
}

if ($releaseExists) {
    Write-Host "  [..] Release $tag da ton tai -> ghi de asset (clobber)..." -ForegroundColor Yellow
    Assert-ManifestSourceState -ManifestPath $manifestPath
    Assert-StagedReleaseAssets -SetupPath $stagedSetupPath -SetupSha256 $manifestInstallerHash `
        -SignaturePath $stagedSigPath -SignatureSha256 $stagedSignatureHash `
        -LatestPath $stagedLatestPath -LatestSha256 $stagedLatestHash
    $publishLease = $null
    try {
        $publishLease = Open-PrynXReleasePublishLeaseSet `
            -StageRoot $releaseStageDir `
            -SetupPath $stagedSetupPath `
            -SetupSha256 $manifestInstallerHash `
            -SignaturePath $stagedSigPath `
            -SignatureSha256 $stagedSignatureHash `
            -LatestPath $stagedLatestPath `
            -LatestSha256 $stagedLatestHash `
            -ManifestPath $manifestPath
        Assert-ManifestSourceState -ManifestPath $publishLease.Manifest.Path
        $null = Assert-ReleaseSecretScanEvidenceV2 `
            -ManifestPath $publishLease.Manifest.Path `
            -SetupSha256 $publishLease.Setup.Sha256
        Assert-GitHubTagTargetsCommit `
            -Repo $ReleaseRepo `
            -Tag $tag `
            -ExpectedCommit $releaseTargetCommit
        Assert-PrynXGitEnvironmentAuthority
        $uploadResult = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $script:PrynXGitHubCli `
            -Command 'release' `
            -Arguments @(
                'upload',
                $tag,
                '--repo',
                "github.com/$ReleaseRepo",
                '--clobber',
                [string]$publishLease.Setup.Path,
                [string]$publishLease.Signature.Path,
                [string]$publishLease.Latest.Path
            )
        if ($uploadResult.ExitCode -ne 0) { throw "gh release upload (clobber) that bai." }
    } finally {
        Close-PrynXPayloadLease -Lease $publishLease
    }
}
else {
    Write-Host "  [..] Release $tag chua ton tai -> tao moi..." -ForegroundColor Yellow
    Assert-ManifestSourceState -ManifestPath $manifestPath
    Assert-StagedReleaseAssets -SetupPath $stagedSetupPath -SetupSha256 $manifestInstallerHash `
        -SignaturePath $stagedSigPath -SignatureSha256 $stagedSignatureHash `
        -LatestPath $stagedLatestPath -LatestSha256 $stagedLatestHash
    $publishLease = $null
    try {
        $publishLease = Open-PrynXReleasePublishLeaseSet `
            -StageRoot $releaseStageDir `
            -SetupPath $stagedSetupPath `
            -SetupSha256 $manifestInstallerHash `
            -SignaturePath $stagedSigPath `
            -SignatureSha256 $stagedSignatureHash `
            -LatestPath $stagedLatestPath `
            -LatestSha256 $stagedLatestHash `
            -ManifestPath $manifestPath
        Assert-ManifestSourceState -ManifestPath $publishLease.Manifest.Path
        $null = Assert-ReleaseSecretScanEvidenceV2 `
            -ManifestPath $publishLease.Manifest.Path `
            -SetupSha256 $publishLease.Setup.Sha256
        $releaseAppeared = Assert-GitHubReleaseTagState `
            -Repo $ReleaseRepo `
            -Tag $tag `
            -ExpectedCommit $releaseTargetCommit
        if ($releaseAppeared) {
            throw "Release $tag appeared before create; KHONG overwrite."
        }
        Assert-PrynXGitEnvironmentAuthority
        $createResult = Invoke-PrynXGitHubCliCommand `
            -GitHubCliPath $script:PrynXGitHubCli `
            -Command 'release' `
            -Arguments @(
                'create',
                $tag,
                '--repo',
                "github.com/$ReleaseRepo",
                '--target',
                $releaseTargetCommit,
                '--title',
                "PrynX $Version",
                '--notes',
                $Notes,
                [string]$publishLease.Setup.Path,
                [string]$publishLease.Signature.Path,
                [string]$publishLease.Latest.Path
            )
        if ($createResult.ExitCode -ne 0) { throw "gh release create that bai." }
    } finally {
        Close-PrynXPayloadLease -Lease $publishLease
    }
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
} finally {
    Close-PrynXReleaseExecutableLease -Lease $githubCliLease
    $script:PrynXGitHubCli = $null
}
} finally {
    Close-PrynXReleaseExecutableLease -Lease $gitLease
    $script:PrynXGit = $null
}
