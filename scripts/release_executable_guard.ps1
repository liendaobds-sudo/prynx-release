# SEC (audit 2026-09-04 SEC.24-R2): resolve executable phat hanh tu nguon OS
# co dinh, kiem chu ky va giu handle de chan PATH hijack/TOCTOU.
# File co UTF-8 BOM de Windows PowerShell 5.1 doc on dinh khi dot-source.

$payloadGuardPath = Join-Path $PSScriptRoot 'windows_payload_guard.ps1'
if (-not (Test-Path -LiteralPath 'Function:\Open-PrynXPayloadFileLease') -or
    -not (Test-Path -LiteralPath 'Function:\Open-PrynXPayloadDirectoryChainLease') -or
    -not (Test-Path -LiteralPath 'Function:\Close-PrynXPayloadLease')) {
    if (-not (Test-Path -LiteralPath $payloadGuardPath -PathType Leaf)) {
        throw "SEC: Thieu windows payload guard: $payloadGuardPath"
    }
    . $payloadGuardPath
}

function Open-PrynXReleaseSystemFileLease {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    # Binary Windows hop le thuong la hardlink toi WinSxS. Khong ap quy tac
    # link-count=1 cua payload ben thu ba; FileShare.Read van chan moi handle
    # ghi/xoa qua bat ky hardlink nao trong suot vong doi lease.
    $fullPath = Assert-PrynXNoReparsePointInPathComponents -Path $Path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "SEC: Khong tim thay $Purpose`: $fullPath"
    }
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "SEC: $Purpose la reparse point: $fullPath"
    }
    $streams = @(Get-Item -LiteralPath $fullPath -Stream * -ErrorAction Stop |
        Where-Object { $_.Stream -ne ':$DATA' })
    if ($streams.Count -gt 0) {
        throw "SEC: $Purpose co alternate data stream: $fullPath"
    }

    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $fullPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $null = Assert-PrynXNoReparsePointInPathComponents -Path $fullPath
        return [pscustomobject]@{
            Path = $fullPath
            Stream = $stream
            Size = [long]$stream.Length
        }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() }
        throw
    }
}

function Assert-PrynXReleaseExecutableSignature {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedOrganization,
        [Parameter(Mandatory = $true)][string]$ExpectedInternalName,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    # SEC (audit 2026-09-04 SEC.24-R2): nap dung module inbox theo PSHOME;
    # khong dua vao PSMODULEPATH/autoload co the bi caller lam sai lech.
    $securityModulePath = Join-Path $PSHOME `
        'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    if (-not (Test-Path -LiteralPath $securityModulePath -PathType Leaf)) {
        throw "SEC: Khong tim thay module Authenticode inbox: $securityModulePath"
    }
    Import-Module -Name $securityModulePath -Force -ErrorAction Stop
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
    $subject = if ($null -ne $signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Subject
    }
    else {
        ''
    }
    $organizationPattern = '(?:^|,\s*)O="?' +
        [regex]::Escape($ExpectedOrganization) + '"?(?:,|$)'
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $subject -notmatch $organizationPattern) {
        throw "SEC: $Purpose khong co chu ky Authenticode hop le cua $ExpectedOrganization."
    }

    # InternalName nam trong PE da ky, giup tu choi mot binary khac cua cung nha
    # phat hanh bi doi ten vao vi tri executable du kien.
    $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    if ([string]$versionInfo.InternalName -ine $ExpectedInternalName) {
        throw "SEC: Danh tinh PE cua $Purpose khong hop le."
    }
}

function Get-PrynXReleaseExecutableCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            'WindowsPowerShell', 'Cmd', 'GitHubCli', 'Node', 'Git',
            'Robocopy', 'Notepad'
        )]
        [string]$Kind
    )

    if ($Kind -in @('WindowsPowerShell', 'Cmd', 'Robocopy', 'Notepad')) {
        $systemDirectory = [Environment]::GetFolderPath(
            [Environment+SpecialFolder]::System
        )
        if ([string]::IsNullOrWhiteSpace($systemDirectory) -or
            -not [System.IO.Path]::IsPathRooted($systemDirectory)) {
            throw 'SEC: Windows khong tra ve thu muc System hop le.'
        }
        if ($Kind -eq 'WindowsPowerShell') {
            return ,(Join-Path $systemDirectory 'WindowsPowerShell\v1.0\powershell.exe')
        }
        if ($Kind -eq 'Robocopy') {
            return ,(Join-Path $systemDirectory 'robocopy.exe')
        }
        if ($Kind -eq 'Notepad') {
            return ,(Join-Path $systemDirectory 'notepad.exe')
        }
        return ,(Join-Path $systemDirectory 'cmd.exe')
    }

    $roots = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    ) | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and
        [System.IO.Path]::IsPathRooted($_)
    } | Select-Object -Unique
    if ($Kind -eq 'GitHubCli') {
        return @($roots | ForEach-Object { Join-Path $_ 'GitHub CLI\gh.exe' })
    }
    if ($Kind -eq 'Node') {
        return @($roots | ForEach-Object { Join-Path $_ 'nodejs\node.exe' })
    }
    if ($Kind -eq 'Git') {
        return @($roots | ForEach-Object { Join-Path $_ 'Git\cmd\git.exe' })
    }

    throw "SEC: Chua khai bao candidate cho executable $Kind."
}

function Open-PrynXTrustedReleaseExecutableLease {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            'WindowsPowerShell', 'Cmd', 'GitHubCli', 'Node', 'Git',
            'Robocopy', 'Notepad'
        )]
        [string]$Kind
    )

    $metadata = switch ($Kind) {
        'WindowsPowerShell' {
            @{
                Purpose = 'Windows PowerShell'
                Organization = 'Microsoft Corporation'
                InternalName = 'POWERSHELL'
                AllowsHardlinks = $true
                SignatureRequired = $true
            }
        }
        'Cmd' {
            @{
                Purpose = 'Windows Command Processor'
                Organization = 'Microsoft Corporation'
                InternalName = 'cmd'
                AllowsHardlinks = $true
                SignatureRequired = $true
            }
        }
        'GitHubCli' {
            @{
                Purpose = 'GitHub CLI'
                Organization = 'GitHub, Inc.'
                InternalName = 'gh'
                AllowsHardlinks = $false
                SignatureRequired = $true
            }
        }
        'Node' {
            @{
                Purpose = 'Node.js'
                Organization = 'OpenJS Foundation'
                InternalName = 'node'
                AllowsHardlinks = $false
                SignatureRequired = $true
            }
        }
        'Git' {
            @{
                Purpose = 'Git for Windows'
                Organization = 'Johannes Schindelin'
                InternalName = 'git'
                # Git for Windows cai cmd\git.exe va mingw64\bin\git.exe bang
                # hardlink hop le; Authenticode van rang buoc dung PE da ky.
                AllowsHardlinks = $true
                SignatureRequired = $true
            }
        }
        'Robocopy' {
            @{
                Purpose = 'Windows Robocopy'
                Organization = 'Microsoft Corporation'
                InternalName = 'robocopy'
                AllowsHardlinks = $true
                SignatureRequired = $true
            }
        }
        'Notepad' {
            @{
                Purpose = 'Windows Notepad'
                Organization = 'Microsoft Corporation'
                InternalName = 'Notepad'
                AllowsHardlinks = $true
                SignatureRequired = $true
            }
        }
    }

    foreach ($candidate in @(Get-PrynXReleaseExecutableCandidates -Kind $Kind)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }

        $directorySet = $null
        $fileLease = $null
        try {
            $candidate = Assert-PrynXNoReparsePointInPathComponents -Path $candidate
            $directorySet = Open-PrynXPayloadDirectoryChainLease `
                -DirectoryPath ([System.IO.Path]::GetDirectoryName($candidate)) `
                -Purpose "$($metadata.Purpose) ancestor"
            if ($metadata.AllowsHardlinks) {
                $fileLease = Open-PrynXReleaseSystemFileLease `
                    -Path $candidate `
                    -Purpose $metadata.Purpose
            }
            else {
                # Payload ben thu ba khong co hardlink hop le trong Program Files.
                $fileLease = Open-PrynXPayloadFileLease `
                    -Path $candidate `
                    -Purpose $metadata.Purpose
            }
            if ($metadata.SignatureRequired) {
                Assert-PrynXReleaseExecutableSignature `
                    -Path $fileLease.Path `
                    -ExpectedOrganization $metadata.Organization `
                    -ExpectedInternalName $metadata.InternalName `
                    -Purpose $metadata.Purpose
            }
            $null = Assert-PrynXNoReparsePointInPathComponents -Path $fileLease.Path

            $allLeases = New-Object System.Collections.Generic.List[object]
            $allLeases.Add($fileLease)
            foreach ($directoryLease in @($directorySet.Leases)) {
                $allLeases.Add($directoryLease)
            }
            return [pscustomobject]@{
                Kind = $Kind
                Path = $fileLease.Path
                File = $fileLease
                Directories = $directorySet
                Leases = $allLeases.ToArray()
            }
        }
        catch {
            Close-PrynXPayloadLease -Lease $fileLease
            Close-PrynXPayloadLease -Lease $directorySet
            throw
        }
    }

    if ($Kind -eq 'GitHubCli') {
        throw 'Khong tim thay GitHub CLI tin cay trong Program Files. Cai bang: winget install GitHub.cli'
    }
    throw "SEC: Khong tim thay executable he thong tin cay cho $Kind."
}

function Resolve-PrynXUpdaterSigningKeyPath {
    # SEC (audit 2026-09-04 §SEC.24-R6): khong tin USERPROFILE tu process cha;
    # Known Folder va reparse guard buoc khoa ky nam tren volume cuc bo.
    $userProfileDirectory = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::UserProfile
    )
    if ([string]::IsNullOrWhiteSpace($userProfileDirectory) -or
        -not [System.IO.Path]::IsPathRooted($userProfileDirectory)) {
        throw 'SEC: Windows khong tra ve UserProfile hop le cho khoa ky updater.'
    }
    return Assert-PrynXNoReparsePointInPathComponents -Path (
        Join-Path (Join-Path $userProfileDirectory '.tauri') 'prynx.key'
    )
}

function Get-PrynXGitAuthorityOverrideVariableNames {
    $environment = [Environment]::GetEnvironmentVariables(
        [EnvironmentVariableTarget]::Process
    )
    $names = New-Object System.Collections.Generic.HashSet[string] `
        ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($key in @($environment.Keys)) {
        $name = [string]$key
        if ($name -match '^(?i:GIT_|GH_)' -or $name -iin @(
                'GITHUB_TOKEN',
                'GITHUB_ENTERPRISE_TOKEN',
                'XDG_CONFIG_HOME'
            )) {
            $null = $names.Add($name)
        }
    }
    return @($names | Sort-Object)
}

function Clear-PrynXAmbientGitAuthorityOverrides {
    foreach ($name in @(Get-PrynXGitAuthorityOverrideVariableNames)) {
        [Environment]::SetEnvironmentVariable(
            [string]$name,
            $null,
            [EnvironmentVariableTarget]::Process
        )
    }
}

function Assert-PrynXGitEnvironmentAuthority {
    $unexpected = @(Get-PrynXGitAuthorityOverrideVariableNames)
    if ($unexpected.Count -gt 0) {
        $null = Clear-PrynXAmbientGitAuthorityOverrides
        throw "SEC: Git/GitHub environment override bi cam: $($unexpected -join ', ')."
    }
}

function Get-PrynXGitHubTransportOverrideVariableNames {
    $blockedNames = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($name in @(
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
        'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
        'REQUESTS_CA_BUNDLE', 'BROWSER'
    )) {
        $null = $blockedNames.Add($name)
    }
    $environment = [Environment]::GetEnvironmentVariables(
        [EnvironmentVariableTarget]::Process
    )
    $names = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($key in @($environment.Keys)) {
        $name = [string]$key
        if ($blockedNames.Contains($name)) { $null = $names.Add($name) }
    }
    return @($names | Sort-Object)
}

function Clear-PrynXAmbientGitHubTransportOverrides {
    foreach ($name in @(Get-PrynXGitHubTransportOverrideVariableNames)) {
        [Environment]::SetEnvironmentVariable(
            [string]$name,
            $null,
            [EnvironmentVariableTarget]::Process
        )
    }
}

function Assert-PrynXGitHubTransportEnvironmentAuthority {
    $unexpected = @(Get-PrynXGitHubTransportOverrideVariableNames)
    if ($unexpected.Count -gt 0) {
        $null = Clear-PrynXAmbientGitHubTransportOverrides
        throw "SEC: GitHub transport environment override bi cam: $($unexpected -join ', ')."
    }
}

function Test-PrynXExactArgumentList {
    param(
        [AllowEmptyCollection()][string[]]$Actual = @(),
        [AllowEmptyCollection()][string[]]$Expected = @()
    )

    if ($Actual.Count -ne $Expected.Count) { return $false }
    for ($index = 0; $index -lt $Actual.Count; $index++) {
        if ($Actual[$index] -cne $Expected[$index]) { return $false }
    }
    return $true
}

function Assert-PrynXGitReadOnlyGrammar {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('rev-parse', 'status', 'version')]
        [string]$Command,
        [AllowEmptyCollection()][string[]]$Arguments = @()
    )

    $allowed = $false
    switch ($Command) {
        'rev-parse' {
            $allowed = (
                (Test-PrynXExactArgumentList `
                    -Actual $Arguments -Expected @('--show-toplevel')) -or
                (Test-PrynXExactArgumentList `
                    -Actual $Arguments -Expected @('--absolute-git-dir')) -or
                (Test-PrynXExactArgumentList `
                    -Actual $Arguments `
                    -Expected @('--path-format=absolute', '--git-common-dir')) -or
                (Test-PrynXExactArgumentList `
                    -Actual $Arguments -Expected @('--is-inside-work-tree')) -or
                (Test-PrynXExactArgumentList `
                    -Actual $Arguments -Expected @('HEAD'))
            )
        }
        'status' {
            $allowed = Test-PrynXExactArgumentList `
                -Actual $Arguments `
                -Expected @('--porcelain=v1', '--untracked-files=all')
        }
        'version' {
            $allowed = $Arguments.Count -eq 0
        }
    }
    if (-not $allowed) {
        throw "SEC: Git command/argument khong nam trong read-only allowlist: $Command."
    }
}

function Assert-PrynXGitLocalConfigurationKeys {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Names
    )

    # SEC (audit 2026-09-04 §SEC.24-R6): local config la input khong tin cay.
    # Chan ca diem thuc thi va cac knob co the lam dirty gate bo sot source.
    $blockedPatterns = @(
        '^include\.',
        '^includeif\.',
        '^alias\.',
        '^filter\.',
        '^pager\.',
        '^credential(?:\.|$)',
        '^difftool\.',
        '^mergetool\.',
        '^merge\.[^.]+\.driver$',
        '^diff\.external$',
        '^diff\.[^.]+\.(?:command|textconv)$',
        '^interactive\.difffilter$',
        '^sequence\.editor$',
        '^gpg\.',
        '^feature\.',
        '^submodule\..*\.update$',
        '^extensions\.worktreeconfig$',
        '^index\.(?:skiphash|sparse)$',
        '^status\.showuntrackedfiles$',
        '^core\.(?:alternaterefscommand|askpass|attributesfile|checkstat|editor|excludesfile|fsmonitor|gitproxy|hookspath|ignorestat|pager|sparsecheckout|sparsecheckoutcone|splitindex|sshcommand|trustctime|untrackedcache|worktree)$'
    )
    foreach ($rawName in @($Names)) {
        $name = [string]$rawName
        if ([string]::IsNullOrWhiteSpace($name) -or $name -cne $name.Trim()) {
            throw 'SEC: Git local config tra ve key khong hop le.'
        }
        $normalized = $name.ToLowerInvariant()
        foreach ($pattern in $blockedPatterns) {
            if ($normalized -match $pattern) {
                throw "SEC: Git local config key bi cam trong release: $name"
            }
        }
    }
}

function Invoke-PrynXGitReadOnlyCommand {
    param(
        [Parameter(Mandatory = $true)][string]$GitPath,
        [Parameter(Mandatory = $true)][string]$ExpectedRoot,
        [Parameter(Mandatory = $true)]
        [ValidateSet('rev-parse', 'status', 'version')]
        [string]$Command,
        [string[]]$Arguments = @()
    )

    # SEC (audit 2026-09-04 §SEC.24-R6): Git chi duoc doc dung metadata
    # cua checkout da audit. Config/index va ancestor duoc lease lien tuc tu
    # luc audit authority den sau command de khong co khoang check/use.
    Assert-PrynXGitEnvironmentAuthority
    Assert-PrynXGitReadOnlyGrammar -Command $Command -Arguments $Arguments
    if (-not [System.IO.Path]::IsPathRooted($GitPath)) {
        throw 'SEC: Git authority phai la duong dan executable tuyet doi.'
    }
    $gitPathFull = Assert-PrynXNoReparsePointInPathComponents -Path $GitPath
    if (-not (Test-Path -LiteralPath $gitPathFull -PathType Leaf)) {
        throw "SEC: Git authority khong ton tai: $gitPathFull"
    }
    $expectedFull = Assert-PrynXNoReparsePointInPathComponents -Path $ExpectedRoot
    if (-not (Test-Path -LiteralPath $expectedFull -PathType Container)) {
        throw "SEC: Git root khong ton tai: $expectedFull"
    }
    $expectedGitDir = Assert-PrynXNoReparsePointInPathComponents -Path (
        Join-Path $expectedFull '.git'
    )
    if (-not (Test-Path -LiteralPath $expectedGitDir -PathType Container)) {
        throw "SEC: Git metadata phai la directory ROOT\.git: $expectedGitDir"
    }
    if (Test-Path -LiteralPath (Join-Path $expectedGitDir 'commondir')) {
        throw "SEC: Git common-dir tach roi khong duoc phep cho release: $expectedGitDir"
    }
    $worktreeConfigPath = Join-Path $expectedGitDir 'config.worktree'
    if (Test-Path -LiteralPath $worktreeConfigPath) {
        throw "SEC: Git config.worktree khong duoc phep cho release: $worktreeConfigPath"
    }

    $controlledNames = @(
        'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ATTR_NOSYSTEM'
    )
    $snapshot = @{}
    foreach ($name in $controlledNames) {
        $value = [Environment]::GetEnvironmentVariable(
            $name,
            [EnvironmentVariableTarget]::Process
        )
        $snapshot[$name] = @{
            Exists = $null -ne $value
            Value = if ($null -ne $value) { [string]$value } else { $null }
        }
    }

    $gitDirectoryLease = $null
    $gitInfoDirectoryLease = $null
    $configLease = $null
    $indexLease = $null
    $infoAttributesLease = $null
    $infoExcludeLease = $null
    try {
        [Environment]::SetEnvironmentVariable(
            'GIT_CONFIG_GLOBAL',
            'NUL',
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            'GIT_CONFIG_NOSYSTEM',
            '1',
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            'GIT_ATTR_NOSYSTEM',
            '1',
            [EnvironmentVariableTarget]::Process
        )

        $gitDirectoryLease = Open-PrynXPayloadDirectoryChainLease `
            -DirectoryPath $expectedGitDir `
            -Purpose 'Git metadata ancestor'
        $gitInfoDirectoryLease = Open-PrynXPayloadDirectoryChainLease `
            -DirectoryPath (Join-Path $expectedGitDir 'info') `
            -Purpose 'Git info ancestor'
        $configLease = Open-PrynXPayloadFileLease `
            -Path (Join-Path $expectedGitDir 'config') `
            -Purpose 'Git local config'
        $indexLease = Open-PrynXPayloadFileLease `
            -Path (Join-Path $expectedGitDir 'index') `
            -Purpose 'Git index'
        $sharedIndexFiles = @(Get-ChildItem `
            -LiteralPath $expectedGitDir `
            -Force `
            -ErrorAction Stop | Where-Object {
                $_.Name.StartsWith(
                    'sharedindex.',
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            })
        if ($sharedIndexFiles.Count -ne 0) {
            throw 'SEC: Split/shared Git index khong duoc phep trong release source.'
        }
        $infoAttributesLease = Open-PrynXPayloadFileLease `
            -Path (Join-Path $expectedGitDir 'info\attributes') `
            -ExpectedSize 0 `
            -Purpose 'Git info attributes'
        $infoExcludeLease = Open-PrynXPayloadFileLease `
            -Path (Join-Path $expectedGitDir 'info\exclude') `
            -ExpectedSize 0 `
            -Purpose 'Git info exclude'

        # SEC (audit 2026-09-04 §SEC.24-R6): Git for Windows 2.53 tu choi
        # pseudo-file NUL cho core.excludesFile. Tro hai global input ve chinh
        # cac file rong da
        # lease de giu fail-closed ma van cho phep status tren checkout hop le.
        $trustedAttributesConfig = 'core.attributesFile=' + $infoAttributesLease.Path
        $trustedExcludeConfig = 'core.excludesFile=' + $infoExcludeLease.Path

        $versionOutput = @(& $gitPathFull `
            --no-pager `
            -c core.fsmonitor=false `
            -c core.hooksPath=NUL `
            -c $trustedAttributesConfig `
            -c $trustedExcludeConfig `
            -c core.untrackedCache=false `
            -c extensions.worktreeConfig=false `
            --no-replace-objects `
            --no-optional-locks `
            --git-dir $expectedGitDir `
            --work-tree $expectedFull `
            -C $expectedFull `
            version 2>$null)
        $versionExit = $LASTEXITCODE
        if ($versionExit -ne 0 -or $versionOutput.Count -ne 1 -or
            ([string]$versionOutput[0]).Trim() -notmatch
                '^git version (?<major>[0-9]+)\.(?<minor>[0-9]+)\.(?<patch>[0-9]+)(?:\.windows\.[0-9]+)?$') {
            throw 'SEC: Khong xac minh duoc version Git for Windows.'
        }
        $gitVersion = [System.Version]::new(
            [int]$Matches.major,
            [int]$Matches.minor,
            [int]$Matches.patch
        )
        if ($gitVersion -lt [System.Version]::new(2, 36, 0)) {
            throw "SEC: Git $gitVersion qua cu; core.fsmonitor=false can Git >= 2.36.0."
        }

        $configOutput = @(& $gitPathFull `
            --no-pager `
            -c core.fsmonitor=false `
            -c core.hooksPath=NUL `
            -c $trustedAttributesConfig `
            -c $trustedExcludeConfig `
            -c core.untrackedCache=false `
            -c extensions.worktreeConfig=false `
            --no-replace-objects `
            --no-optional-locks `
            config --file $configLease.Path --no-includes --name-only --list 2>$null)
        $configExit = $LASTEXITCODE
        if ($configExit -ne 0) {
            throw 'SEC: Khong audit duoc Git local config da lease.'
        }
        Assert-PrynXGitLocalConfigurationKeys -Names $configOutput

        $indexFlagOutput = @(& $gitPathFull `
            --no-pager `
            -c core.fsmonitor=false `
            -c core.hooksPath=NUL `
            -c $trustedAttributesConfig `
            -c $trustedExcludeConfig `
            -c core.untrackedCache=false `
            -c extensions.worktreeConfig=false `
            --no-replace-objects `
            --no-optional-locks `
            --git-dir $expectedGitDir `
            --work-tree $expectedFull `
            -C $expectedFull `
            ls-files -v -- 2>$null)
        $indexFlagExit = $LASTEXITCODE
        if ($indexFlagExit -ne 0) {
            throw 'SEC: Khong audit duoc flags trong Git index da lease.'
        }
        foreach ($lineValue in @($indexFlagOutput)) {
            $line = [string]$lineValue
            if ($line.Length -lt 3 -or $line[0] -cne 'H' -or $line[1] -cne ' ') {
                throw 'SEC: Git index co skip-worktree/assume-unchanged hoac entry bat thuong.'
            }
        }

        $stageOutput = @(& $gitPathFull `
            --no-pager `
            -c core.fsmonitor=false `
            -c core.hooksPath=NUL `
            -c $trustedAttributesConfig `
            -c $trustedExcludeConfig `
            -c core.untrackedCache=false `
            -c extensions.worktreeConfig=false `
            --no-replace-objects `
            --no-optional-locks `
            --git-dir $expectedGitDir `
            --work-tree $expectedFull `
            -C $expectedFull `
            ls-files --stage -- 2>$null)
        $stageExit = $LASTEXITCODE
        if ($stageExit -ne 0 -or $stageOutput.Count -ne $indexFlagOutput.Count) {
            throw 'SEC: Git stage inventory khong khop index da lease.'
        }
        foreach ($lineValue in @($stageOutput)) {
            $line = [string]$lineValue
            $entry = [regex]::Match(
                $line,
                '^(?<mode>[0-7]{6}) (?<object>[0-9a-fA-F]{40}|[0-9a-fA-F]{64}) (?<stage>[0-3])\t.+$'
            )
            if (-not $entry.Success -or $entry.Groups['stage'].Value -cne '0') {
                throw 'SEC: Git index co stage entry khong hop le.'
            }
            if ($entry.Groups['mode'].Value -ceq '160000') {
                throw 'SEC: Gitlink/submodule khong duoc phep trong release source.'
            }
        }

        # Windows PowerShell 5.1 unroll mảng một phần tử khi gán kết quả của
        # biểu thức if; splat một chuỗi sau đó có thể tách từng ký tự. Ép kiểu
        # trước rồi chỉ nối riêng cho status để rev-parse giữ nguyên một argv.
        [string[]]$commandArguments = @($Arguments)
        if ($Command -ceq 'status') {
            $commandArguments += '--ignore-submodules=none'
        }
        $commandOutput = @(& $gitPathFull `
            --no-pager `
            -c core.fsmonitor=false `
            -c core.hooksPath=NUL `
            -c $trustedAttributesConfig `
            -c $trustedExcludeConfig `
            -c core.untrackedCache=false `
            -c extensions.worktreeConfig=false `
            --no-replace-objects `
            --no-optional-locks `
            --git-dir $expectedGitDir `
            --work-tree $expectedFull `
            -C $expectedFull `
            $Command @commandArguments 2>$null)
        $commandExit = $LASTEXITCODE
        return [pscustomobject]@{
            ExitCode = [int]$commandExit
            Output = [object[]]@($commandOutput)
            Root = $expectedFull
            GitDir = $expectedGitDir
            Version = $gitVersion.ToString()
        }
    }
    finally {
        Close-PrynXPayloadLease -Lease $infoExcludeLease
        Close-PrynXPayloadLease -Lease $infoAttributesLease
        Close-PrynXPayloadLease -Lease $indexLease
        Close-PrynXPayloadLease -Lease $configLease
        Close-PrynXPayloadLease -Lease $gitInfoDirectoryLease
        Close-PrynXPayloadLease -Lease $gitDirectoryLease
        foreach ($name in $controlledNames) {
            $value = if ($snapshot[$name].Exists) {
                [string]$snapshot[$name].Value
            } else {
                $null
            }
            [Environment]::SetEnvironmentVariable(
                $name,
                $value,
                [EnvironmentVariableTarget]::Process
            )
        }
    }
}

function Assert-PrynXGitRepositoryAuthority {
    param(
        [Parameter(Mandatory = $true)][string]$GitPath,
        [Parameter(Mandatory = $true)][string]$ExpectedRoot
    )

    $topLevelResult = Invoke-PrynXGitReadOnlyCommand `
        -GitPath $GitPath `
        -ExpectedRoot $ExpectedRoot `
        -Command 'rev-parse' `
        -Arguments @('--show-toplevel')
    if ($topLevelResult.ExitCode -ne 0 -or $topLevelResult.Output.Count -ne 1) {
        throw 'SEC: Khong xac minh duoc canonical Git top-level.'
    }
    $topLevelText = ([string]$topLevelResult.Output[0]).Trim()
    if ([string]::IsNullOrWhiteSpace($topLevelText) -or
        -not [System.IO.Path]::IsPathRooted($topLevelText)) {
        throw 'SEC: Git tra ve top-level khong hop le.'
    }
    $actualFull = Assert-PrynXNoReparsePointInPathComponents -Path $topLevelText
    if (-not [string]::Equals(
            $actualFull,
            [string]$topLevelResult.Root,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "SEC: Git top-level lech repo goc da audit: $actualFull"
    }

    $gitDirResult = Invoke-PrynXGitReadOnlyCommand `
        -GitPath $GitPath `
        -ExpectedRoot $ExpectedRoot `
        -Command 'rev-parse' `
        -Arguments @('--absolute-git-dir')
    if ($gitDirResult.ExitCode -ne 0 -or $gitDirResult.Output.Count -ne 1) {
        throw 'SEC: Khong xac minh duoc absolute Git metadata directory.'
    }
    $actualGitDir = Assert-PrynXNoReparsePointInPathComponents -Path (
        ([string]$gitDirResult.Output[0]).Trim()
    )
    if (-not (Test-Path -LiteralPath $actualGitDir -PathType Container) -or
        -not [string]::Equals(
            $actualGitDir,
            [string]$gitDirResult.GitDir,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "SEC: Git metadata lech ROOT\.git da audit: $actualGitDir"
    }

    $commonDirResult = Invoke-PrynXGitReadOnlyCommand `
        -GitPath $GitPath `
        -ExpectedRoot $ExpectedRoot `
        -Command 'rev-parse' `
        -Arguments @('--path-format=absolute', '--git-common-dir')
    if ($commonDirResult.ExitCode -ne 0 -or $commonDirResult.Output.Count -ne 1) {
        throw 'SEC: Khong xac minh duoc Git common directory.'
    }
    $actualCommonDir = Assert-PrynXNoReparsePointInPathComponents -Path (
        ([string]$commonDirResult.Output[0]).Trim()
    )
    if (-not (Test-Path -LiteralPath $actualCommonDir -PathType Container) -or
        -not [string]::Equals(
            $actualCommonDir,
            [string]$commonDirResult.GitDir,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "SEC: Git common-dir lech ROOT\.git da audit: $actualCommonDir"
    }
}

function Get-PrynXGitHubCliConfigurationDirectory {
    $appData = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::ApplicationData
    )
    if ([string]::IsNullOrWhiteSpace($appData) -or
        -not [System.IO.Path]::IsPathRooted($appData)) {
        throw 'SEC: Windows khong tra ve ApplicationData hop le cho GitHub CLI.'
    }
    $configDirectory = Assert-PrynXNoReparsePointInPathComponents -Path (
        Join-Path $appData 'GitHub CLI'
    )
    if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
        throw "SEC: Khong tim thay GitHub CLI config tin cay. Chay gh auth login: $configDirectory"
    }
    return $configDirectory
}

function Open-PrynXGitHubCliConfigurationLease {
    $configDirectory = Get-PrynXGitHubCliConfigurationDirectory
    $leases = New-Object System.Collections.Generic.List[object]
    try {
        $directorySet = Open-PrynXPayloadDirectoryChainLease `
            -DirectoryPath $configDirectory `
            -Purpose 'GitHub CLI config ancestor'
        foreach ($directoryLease in @($directorySet.Leases)) {
            $leases.Add($directoryLease)
        }
        $configLease = Open-PrynXPayloadFileLease `
            -Path (Join-Path $configDirectory 'config.yml') `
            -Purpose 'GitHub CLI config.yml'
        $leases.Add($configLease)
        $hostsLease = Open-PrynXPayloadFileLease `
            -Path (Join-Path $configDirectory 'hosts.yml') `
            -Purpose 'GitHub CLI hosts.yml'
        $leases.Add($hostsLease)
        return [pscustomobject]@{
            Directory = $configDirectory
            Config = $configLease
            Hosts = $hostsLease
            Leases = $leases.ToArray()
        }
    }
    catch {
        foreach ($lease in $leases) { Close-PrynXPayloadLease -Lease $lease }
        throw
    }
}

function Assert-PrynXGitHubCliCredentialStorageAuthority {
    param([Parameter(Mandatory = $true)]$HostsLease)

    # SEC (audit 2026-09-04 §SEC.24-R6): gh co the fallback ghi OAuth token
    # ro vao hosts.yml khi Credential Manager loi. Release chi chap nhan token
    # nam trong secure credential store; khong bao gio dua noi dung token vao loi.
    if ($null -eq $HostsLease -or
        $null -eq $HostsLease.PSObject.Properties['Stream'] -or
        $null -eq $HostsLease.Stream -or
        -not $HostsLease.Stream.CanRead -or
        -not $HostsLease.Stream.CanSeek) {
        throw 'SEC: GitHub CLI hosts.yml lease khong hop le.'
    }

    $reader = $null
    $content = $null
    try {
        $HostsLease.Stream.Position = 0
        $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
        $reader = [System.IO.StreamReader]::new(
            $HostsLease.Stream,
            $strictUtf8,
            $true,
            4096,
            $true
        )
        $content = $reader.ReadToEnd()
        $normalizedContent = $content.Replace("`r`n", "`n").Replace("`r", "`n")
        $credentialKeyPattern = (
            '(?mi)^[ ]*(?:"(?:oauth_token|token)"|' +
            '''(?:oauth_token|token)''|(?:oauth_token|token))[ ]*:'
        )
        if ($content.IndexOf([char]0) -ge 0 -or
            $normalizedContent -match $credentialKeyPattern) {
            throw 'SEC: GitHub CLI hosts.yml chua credential dang plaintext.'
        }

        # SEC (audit 2026-09-04 §SEC.24-R6): gh ghi YAML block-style. Cam
        # flow collection, explicit key/tag/anchor/block scalar va quoted-key
        # escape de oauth_token khong the bi che khoi bo quet raw truoc network.
        $forbiddenLineSyntax = (
            '(?m)^[ ]*(?:[%?&*!|>]|---(?:[ ]|\z)|\.\.\.(?:[ ]|\z)|-[ ])'
        )
        $escapedQuotedKey = '(?m)^[ ]*"(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*"[ ]*:'
        $forbiddenCharacters = [char[]]@(
            [char]0x0009,
            [char]0x0085,
            [char]0x2028,
            [char]0x2029,
            [char]0x005B,
            [char]0x005D,
            [char]0x007B,
            [char]0x007D
        )
        if ($normalizedContent.IndexOfAny($forbiddenCharacters) -ge 0 -or
            $normalizedContent -match $forbiddenLineSyntax -or
            $normalizedContent -match $escapedQuotedKey) {
            throw 'SEC: GitHub CLI hosts.yml dung YAML syntax khong canonical cho release.'
        }
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        $content = $null
        $normalizedContent = $null
        $HostsLease.Stream.Position = 0
    }
}

function Test-PrynXGitHubRepositoryArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    return $Value -cmatch (
        '^github\.com/' +
        '(?!\.{1,2}(?:/|\z))[A-Za-z0-9_.-]+/' +
        '(?!\.{1,2}(?:/|\z))[A-Za-z0-9_.-]+\z'
    )
}

function Test-PrynXGitHubApiRoute {
    param([Parameter(Mandatory = $true)][string]$Route)

    $segment = '(?!\.{1,2}(?:/|\z))[A-Za-z0-9_.-]+'
    $repository = "$segment/$segment"
    # SEC (audit 2026-09-04 §SEC.24-R6): chỉ nhận đúng hai dạng tag mà
    # publisher tạo. Không cho percent-escape tổng quát biến route thành
    # newline, path separator hoặc query/fragment sau một thay đổi call site.
    $rawReleaseTag = (
        'v[0-9]+\.[0-9]+\.[0-9]+' +
        '(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?' +
        '(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?'
    )
    $escapedReleaseTag = (
        'v[0-9]+\.[0-9]+\.[0-9]+' +
        '(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?' +
        '(?:%2B[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?'
    )
    $objectId = '(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})'
    foreach ($pattern in @(
            "^repos/${repository}/commits/[0-9A-Fa-f]{40}\z",
            "^repos/${repository}/git/ref/tags/$rawReleaseTag\z",
            "^repos/${repository}/git/tags/$objectId\z",
            "^repos/${repository}/releases/tags/$escapedReleaseTag\z",
            "^repos/${repository}/git/matching-refs/tags/$escapedReleaseTag\z"
        )) {
        if ($Route -cmatch $pattern) { return $true }
    }
    return $false
}

function Test-PrynXReleaseTagArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    return $Value -cmatch (
        '^v[0-9]+\.[0-9]+\.[0-9]+' +
        '(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?' +
        '(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?\z'
    )
}

function Test-PrynXReleaseAssetArguments {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][int[]]$Indexes
    )

    foreach ($index in $Indexes) {
        if ($index -lt 0 -or $index -ge $Arguments.Count -or
            [string]::IsNullOrWhiteSpace($Arguments[$index]) -or
            -not [System.IO.Path]::IsPathRooted($Arguments[$index])) {
            return $false
        }
    }
    return $true
}

function Assert-PrynXGitHubCliGrammar {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('api', 'auth', 'release')]
        [string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    switch ($Command) {
        'api' {
            if ($Arguments.Count -ne 3 -or
                $Arguments[0] -cne '--hostname' -or
                $Arguments[1] -cne 'github.com' -or
                -not (Test-PrynXGitHubApiRoute -Route $Arguments[2])) {
                throw 'SEC: gh api command/route khong nam trong exact allowlist.'
            }
        }
        'auth' {
            if (-not (Test-PrynXExactArgumentList `
                    -Actual $Arguments `
                    -Expected @('status', '--hostname', 'github.com'))) {
                throw 'SEC: gh auth chi duoc status --hostname github.com.'
            }
        }
        'release' {
            if ($Arguments.Count -eq 0) {
                throw 'SEC: gh release command khong nam trong exact allowlist.'
            }
            switch ($Arguments[0]) {
                'list' {
                    if ($Arguments.Count -ne 3 -or
                        $Arguments[1] -cne '--repo' -or
                        -not (Test-PrynXGitHubRepositoryArgument -Value $Arguments[2])) {
                        throw 'SEC: gh release list command khong nam trong exact allowlist.'
                    }
                }
                'upload' {
                    if ($Arguments.Count -ne 8 -or
                        -not (Test-PrynXReleaseTagArgument -Value $Arguments[1]) -or
                        $Arguments[2] -cne '--repo' -or
                        -not (Test-PrynXGitHubRepositoryArgument -Value $Arguments[3]) -or
                        $Arguments[4] -cne '--clobber' -or
                        -not (Test-PrynXReleaseAssetArguments `
                            -Arguments $Arguments `
                            -Indexes @(5, 6, 7))) {
                        throw 'SEC: gh release upload command khong nam trong exact allowlist.'
                    }
                }
                'create' {
                    $version = if ($Arguments.Count -gt 1 -and
                        (Test-PrynXReleaseTagArgument -Value $Arguments[1])) {
                        $Arguments[1].Substring(1)
                    }
                    else {
                        ''
                    }
                    if ($Arguments.Count -ne 13 -or
                        [string]::IsNullOrWhiteSpace($version) -or
                        $Arguments[2] -cne '--repo' -or
                        -not (Test-PrynXGitHubRepositoryArgument -Value $Arguments[3]) -or
                        $Arguments[4] -cne '--target' -or
                        $Arguments[5] -cnotmatch '^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})\z' -or
                        $Arguments[6] -cne '--title' -or
                        $Arguments[7] -cne "PrynX $version" -or
                        $Arguments[8] -cne '--notes' -or
                        -not (Test-PrynXReleaseAssetArguments `
                            -Arguments $Arguments `
                            -Indexes @(10, 11, 12))) {
                        throw 'SEC: gh release create command khong nam trong exact allowlist.'
                    }
                }
                default {
                    throw 'SEC: gh release command khong nam trong exact allowlist.'
                }
            }
        }
    }
}

function Assert-PrynXGitHubCliConfigurationOutput {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Lines
    )

    # SEC (audit 2026-09-04 §SEC.24-R6): `api_host` co the doi dich API ma
    # van gui credential cua canonical host. Dung exact-set tu CLI da pin de
    # moi config key moi phai duoc audit truoc khi release tiep tuc.
    $expectedNames = @(
        'git_protocol',
        'editor',
        'prompt',
        'prefer_editor_prompt',
        'pager',
        'http_unix_socket',
        'browser',
        'color_labels',
        'accessible_colors',
        'accessible_prompter',
        'spinner',
        'telemetry'
    )
    $values = [System.Collections.Generic.Dictionary[string,string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($rawLine in @($Lines)) {
        $line = [string]$rawLine
        $entry = [regex]::Match(
            $line,
            '^(?<name>[a-z][a-z0-9_]*)=(?<value>[^\r\n]*)\z',
            [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
        )
        if (-not $entry.Success) {
            throw 'SEC: GitHub CLI config inventory khong co canonical format.'
        }
        $name = $entry.Groups['name'].Value
        if ($name -ceq 'api_host') {
            throw 'SEC: GitHub CLI config api_host bi cam trong release authority.'
        }
        if ($expectedNames -cnotcontains $name -or $values.ContainsKey($name)) {
            throw "SEC: GitHub CLI config key khong nam trong exact allowlist: $name"
        }
        $values.Add($name, $entry.Groups['value'].Value)
    }

    $actualNames = @($values.Keys | Sort-Object)
    $difference = @(Compare-Object `
        -ReferenceObject @($expectedNames | Sort-Object) `
        -DifferenceObject $actualNames `
        -CaseSensitive)
    if ($difference.Count -ne 0) {
        throw 'SEC: GitHub CLI config inventory drifted from the audited exact set.'
    }
    foreach ($executionSetting in @('editor', 'pager', 'http_unix_socket', 'browser')) {
        if ($values[$executionSetting] -cne '') {
            throw "SEC: GitHub CLI config $executionSetting phai rong trong release authority."
        }
    }
}

function Invoke-PrynXGitHubCliCommand {
    param(
        [Parameter(Mandatory = $true)][string]$GitHubCliPath,
        [Parameter(Mandatory = $true)]
        [ValidateSet('api', 'auth', 'release')]
        [string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    # SEC (audit 2026-09-04 §SEC.24-R6): moi network call pin github.com,
    # dung exact grammar va lease config Known Folder qua ca check/use.
    Assert-PrynXGitEnvironmentAuthority
    Assert-PrynXGitHubTransportEnvironmentAuthority
    Assert-PrynXGitHubCliGrammar -Command $Command -Arguments $Arguments
    if (-not [System.IO.Path]::IsPathRooted($GitHubCliPath)) {
        throw 'SEC: GitHub CLI authority phai la executable tuyet doi ton tai.'
    }
    $gitHubCliFull = Assert-PrynXNoReparsePointInPathComponents -Path $GitHubCliPath
    if (-not (Test-Path -LiteralPath $gitHubCliFull -PathType Leaf)) {
        throw 'SEC: GitHub CLI authority phai la executable tuyet doi ton tai.'
    }

    $controlledNames = @(
        'GH_CONFIG_DIR',
        'GH_PROMPT_DISABLED',
        'GH_NO_UPDATE_NOTIFIER',
        'GH_NO_EXTENSION_UPDATE_NOTIFIER',
        'GH_FORCE_TTY',
        'GH_DEBUG',
        'DEBUG'
    )
    $snapshot = @{}
    foreach ($name in $controlledNames) {
        $value = [Environment]::GetEnvironmentVariable(
            $name,
            [EnvironmentVariableTarget]::Process
        )
        $snapshot[$name] = @{
            Exists = $null -ne $value
            Value = if ($null -ne $value) { [string]$value } else { $null }
        }
    }
    $configurationLease = $null
    $previousEap = $ErrorActionPreference
    try {
        $configurationLease = Open-PrynXGitHubCliConfigurationLease
        Assert-PrynXGitHubCliCredentialStorageAuthority `
            -HostsLease $configurationLease.Hosts
        $configDirectory = [string]$configurationLease.Directory
        [Environment]::SetEnvironmentVariable(
            'GH_CONFIG_DIR',
            $configDirectory,
            [EnvironmentVariableTarget]::Process
        )
        foreach ($name in @('GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'GH_NO_EXTENSION_UPDATE_NOTIFIER')) {
            [Environment]::SetEnvironmentVariable(
                $name,
                '1',
                [EnvironmentVariableTarget]::Process
            )
        }
        foreach ($name in @('GH_FORCE_TTY', 'GH_DEBUG', 'DEBUG')) {
            [Environment]::SetEnvironmentVariable(
                $name,
                $null,
                [EnvironmentVariableTarget]::Process
            )
        }

        $ErrorActionPreference = 'Continue'
        $configurationOutput = @(& $gitHubCliFull `
            config list --host github.com 2>&1)
        $configurationExit = $LASTEXITCODE
        if ($configurationExit -ne 0) {
            throw 'SEC: Khong audit duoc GitHub CLI config cho github.com.'
        }
        Assert-PrynXGitHubCliConfigurationOutput -Lines $configurationOutput

        $commandOutput = @(& $gitHubCliFull $Command @Arguments 2>&1)
        $commandExit = $LASTEXITCODE
        return [pscustomobject]@{
            ExitCode = [int]$commandExit
            Output = [object[]]@($commandOutput)
        }
    }
    finally {
        $ErrorActionPreference = $previousEap
        Close-PrynXPayloadLease -Lease $configurationLease
        foreach ($name in $controlledNames) {
            $value = if ($snapshot[$name].Exists) {
                [string]$snapshot[$name].Value
            } else {
                $null
            }
            [Environment]::SetEnvironmentVariable(
                $name,
                $value,
                [EnvironmentVariableTarget]::Process
            )
        }
    }
}

function Assert-PrynXJsonPropertySet {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$ExpectedNames,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    if ($null -eq $Value) {
        throw "SEC: $Purpose bi thieu."
    }
    $actualNames = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    $difference = @(Compare-Object `
        -ReferenceObject @($ExpectedNames | Sort-Object) `
        -DifferenceObject @($actualNames | Sort-Object) `
        -CaseSensitive)
    if ($difference.Count -ne 0) {
        throw "SEC: $Purpose co tap thuoc tinh khong hop le."
    }
}

function Read-PrynXJsonFromPayloadLease {
    param(
        [Parameter(Mandatory = $true)]$Lease,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    $reader = $null
    try {
        $Lease.Stream.Position = 0
        $utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
        $reader = New-Object System.IO.StreamReader(
            $Lease.Stream,
            $utf8Strict,
            $true,
            4096,
            $true
        )
        $jsonText = $reader.ReadToEnd()
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        $Lease.Stream.Position = 0
    }
    try {
        return ($jsonText | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        throw "SEC: JSON khong hop le trong $Purpose`: $($_.Exception.Message)"
    }
}

function Read-PrynXRustToolchainLock {
    param([Parameter(Mandatory = $true)][string]$Path)

    # SEC (audit 2026-09-04 SEC.24-R4): lock da review trong source la authority;
    # khong suy provenance tu rustup proxy hay metadata nam trong profile user.
    $lockLease = Open-PrynXPayloadFileLease `
        -Path $Path `
        -Purpose 'Rust toolchain lock'
    try {
        $document = Read-PrynXJsonFromPayloadLease `
            -Lease $lockLease `
            -Purpose 'Rust toolchain lock'
        Assert-PrynXJsonPropertySet `
            -Value $document `
            -ExpectedNames @(
                'schema_version', 'component_id', 'toolchain_id', 'release',
                'host', 'dist_date', 'identity', 'provenance', 'root_count',
                'file_count', 'payload_roots'
            ) `
            -Purpose 'Rust toolchain lock'

        $release = [string]$document.release
        $toolchainHost = [string]$document.host
        $toolchainId = [string]$document.toolchain_id
        $distDate = [string]$document.dist_date
        if ([int]$document.schema_version -ne 1 -or
            [string]$document.component_id -ne 'prynx-rust-toolchain' -or
            $release -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or
            $toolchainHost -ne 'x86_64-pc-windows-msvc' -or
            $toolchainId -ne "$release-$toolchainHost" -or
            $toolchainId -notmatch '^[0-9]+\.[0-9]+\.[0-9]+-x86_64-pc-windows-msvc$' -or
            $distDate -notmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') {
            throw 'SEC: Rust toolchain lock co schema/identity khong hop le.'
        }

        Assert-PrynXJsonPropertySet `
            -Value $document.identity `
            -ExpectedNames @('rustc', 'cargo') `
            -Purpose 'Rust toolchain identity'
        Assert-PrynXJsonPropertySet `
            -Value $document.identity.rustc `
            -ExpectedNames @('commit_hash', 'llvm_version') `
            -Purpose 'Rustc identity'
        Assert-PrynXJsonPropertySet `
            -Value $document.identity.cargo `
            -ExpectedNames @('release', 'commit_hash') `
            -Purpose 'Cargo identity'
        $rustcCommit = [string]$document.identity.rustc.commit_hash
        $llvmVersion = [string]$document.identity.rustc.llvm_version
        $cargoRelease = [string]$document.identity.cargo.release
        $cargoCommit = [string]$document.identity.cargo.commit_hash
        if ($rustcCommit -notmatch '^[0-9a-f]{40}$' -or
            $llvmVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or
            $cargoRelease -ne $release -or
            $cargoCommit -notmatch '^[0-9a-f]{40}$') {
            throw 'SEC: Rust/Cargo identity trong lock khong hop le.'
        }

        Assert-PrynXJsonPropertySet `
            -Value $document.provenance `
            -ExpectedNames @('channel_manifest', 'archives') `
            -Purpose 'Rust toolchain provenance'
        $channelManifest = $document.provenance.channel_manifest
        Assert-PrynXJsonPropertySet `
            -Value $channelManifest `
            -ExpectedNames @('url', 'signature_url', 'size', 'sha256') `
            -Purpose 'Rust channel manifest provenance'
        [long]$channelSize = 0
        $channelUrl = [string]$channelManifest.url
        $expectedChannelUrl = "https://static.rust-lang.org/dist/$distDate/channel-rust-$release.toml"
        if ($channelUrl -cne $expectedChannelUrl -or
            [string]$channelManifest.signature_url -cne "$expectedChannelUrl.asc" -or
            $null -eq $channelManifest.size -or
            -not [long]::TryParse([string]$channelManifest.size, [ref]$channelSize) -or
            $channelSize -le 0 -or
            [string]$channelManifest.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw 'SEC: Rust channel manifest provenance khong hop le.'
        }

        $expectedArchiveComponents = @('cargo', 'clippy', 'rust-std', 'rustc', 'rustfmt')
        $archiveMap = @{}
        foreach ($archive in @($document.provenance.archives)) {
            Assert-PrynXJsonPropertySet `
                -Value $archive `
                -ExpectedNames @('component', 'url', 'sha256') `
                -Purpose 'Rust component archive provenance'
            $component = [string]$archive.component
            if ($component -notin $expectedArchiveComponents -or
                $archiveMap.ContainsKey($component)) {
                throw 'SEC: Rust toolchain lock co component archive thua/trung.'
            }
            $expectedArchiveUrl = "https://static.rust-lang.org/dist/$distDate/$component-$release-$toolchainHost.tar.xz"
            if ([string]$archive.url -cne $expectedArchiveUrl -or
                [string]$archive.sha256 -notmatch '^[0-9a-f]{64}$') {
                throw "SEC: Provenance archive Rust khong hop le cho $component."
            }
            $archiveMap[$component] = $archive
        }
        if ($archiveMap.Count -ne $expectedArchiveComponents.Count) {
            throw 'SEC: Rust toolchain lock thieu component archive bat buoc.'
        }

        $expectedRootCounts = @{
            'bin' = 23
            'lib/rustlib/x86_64-pc-windows-msvc/bin' = 12
            'lib/rustlib/x86_64-pc-windows-msvc/lib' = 45
            'libexec' = 2
        }
        [int]$declaredRootCount = 0
        [int]$declaredFileCount = 0
        if ($null -eq $document.root_count -or
            -not [int]::TryParse([string]$document.root_count, [ref]$declaredRootCount) -or
            $declaredRootCount -ne $expectedRootCounts.Count -or
            $null -eq $document.file_count -or
            -not [int]::TryParse([string]$document.file_count, [ref]$declaredFileCount) -or
            $declaredFileCount -ne 82) {
            throw 'SEC: Rust toolchain lock co root_count/file_count khong hop le.'
        }

        $rootMap = @{}
        $normalizedRoots = New-Object System.Collections.Generic.List[object]
        [int]$actualFileCount = 0
        foreach ($rootEntry in @($document.payload_roots)) {
            Assert-PrynXJsonPropertySet `
                -Value $rootEntry `
                -ExpectedNames @('path', 'exact_set', 'file_count', 'files') `
                -Purpose 'Rust payload root'
            $rootPath = [string]$rootEntry.path
            if (-not $expectedRootCounts.ContainsKey($rootPath) -or
                $rootMap.ContainsKey($rootPath) -or
                $rootEntry.exact_set -ne $true) {
                throw 'SEC: Rust toolchain lock co payload root khong hop le.'
            }
            [int]$rootFileCount = 0
            if ($null -eq $rootEntry.file_count -or
                -not [int]::TryParse([string]$rootEntry.file_count, [ref]$rootFileCount) -or
                $rootFileCount -ne [int]$expectedRootCounts[$rootPath]) {
                throw "SEC: Rust payload root file_count khong hop le: $rootPath"
            }

            $fileMap = @{}
            $entries = New-Object System.Collections.Generic.List[object]
            foreach ($fileEntry in @($rootEntry.files)) {
                Assert-PrynXJsonPropertySet `
                    -Value $fileEntry `
                    -ExpectedNames @('path', 'size', 'sha256') `
                    -Purpose "Rust payload file trong $rootPath"
                $relativePath = [string]$fileEntry.path
                $hash = [string]$fileEntry.sha256
                [long]$size = 0
                if (-not (Test-PrynXPayloadRelativePath -RelativePath $relativePath) -or
                    $fileMap.ContainsKey($relativePath) -or
                    $hash -notmatch '^[0-9a-f]{64}$' -or
                    $null -eq $fileEntry.size -or
                    -not [long]::TryParse([string]$fileEntry.size, [ref]$size) -or
                    $size -le 0) {
                    throw "SEC: Rust payload file khong hop le trong $rootPath."
                }
                $normalized = [pscustomobject]@{
                    Path = $relativePath
                    Hash = $hash
                    Size = $size
                }
                $fileMap[$relativePath] = $normalized
                $entries.Add($normalized)
            }
            if ($entries.Count -ne $rootFileCount) {
                throw "SEC: Rust payload root files khong khop file_count: $rootPath"
            }
            $normalizedRoot = [pscustomobject]@{
                Path = $rootPath
                Entries = $entries.ToArray()
                EntryMap = $fileMap
            }
            $rootMap[$rootPath] = $normalizedRoot
            $normalizedRoots.Add($normalizedRoot)
            $actualFileCount += $entries.Count
        }
        if ($rootMap.Count -ne $expectedRootCounts.Count -or
            $actualFileCount -ne $declaredFileCount) {
            throw 'SEC: Rust toolchain lock khong phu dung 4 root/82 file.'
        }

        $binMap = $rootMap['bin'].EntryMap
        foreach ($requiredBinary in @('cargo.exe', 'rustc.exe', 'rustdoc.exe')) {
            if (-not $binMap.ContainsKey($requiredBinary)) {
                throw "SEC: Rust toolchain lock thieu binary bat buoc: $requiredBinary"
            }
        }
        $driverDlls = @($binMap.Keys | Where-Object {
                $_ -match '^rustc_driver-[0-9a-f]{16}\.dll$'
            })
        $runtimeDlls = @($binMap.Keys | Where-Object {
                $_ -match '^std-[0-9a-f]{16}\.dll$'
            })
        $hostLibMap = $rootMap['lib/rustlib/x86_64-pc-windows-msvc/lib'].EntryMap
        $stdRlibs = @($hostLibMap.Keys | Where-Object {
                $_ -match '^libstd-[0-9a-f]{16}\.rlib$'
            })
        $stdMetadata = @($hostLibMap.Keys | Where-Object {
                $_ -match '^libstd-[0-9a-f]{16}\.rmeta$'
            })
        if ($driverDlls.Count -ne 1 -or $runtimeDlls.Count -ne 1 -or
            $stdRlibs.Count -ne 1 -or $stdMetadata.Count -ne 1) {
            throw 'SEC: Rust toolchain lock thieu/du driver hoac host standard library.'
        }

        return [pscustomobject]@{
            Path = $lockLease.Path
            LockSha256 = $lockLease.Sha256
            LockLease = $lockLease
            ToolchainId = $toolchainId
            Release = $release
            Host = $toolchainHost
            RustcCommit = $rustcCommit
            CargoCommit = $cargoCommit
            LlvmVersion = $llvmVersion
            PayloadRoots = $normalizedRoots.ToArray()
            Document = $document
        }
    }
    catch {
        Close-PrynXPayloadLease -Lease $lockLease
        throw
    }
}

function Open-PrynXTrustedRustToolchainLease {
    param([Parameter(Mandatory = $true)][string]$LockPath)

    $lock = $null
    $leases = New-Object System.Collections.Generic.List[object]
    try {
        $lock = Read-PrynXRustToolchainLock -Path $LockPath
        $leases.Add($lock.LockLease)

        $userProfile = [Environment]::GetFolderPath(
            [Environment+SpecialFolder]::UserProfile
        )
        if ([string]::IsNullOrWhiteSpace($userProfile) -or
            -not [System.IO.Path]::IsPathRooted($userProfile)) {
            throw 'SEC: Windows khong tra ve UserProfile hop le cho Rust toolchain.'
        }
        $cargoHome = Assert-PrynXNoReparsePointInPathComponents -Path (
            Join-Path $userProfile '.cargo'
        )
        # Khong doc RUSTUP_HOME/RUSTUP_TOOLCHAIN va khong chay rustup proxy.
        $toolchainRoot = Join-Path $userProfile ".rustup\toolchains\$($lock.ToolchainId)"
        $toolchainRoot = Assert-PrynXNoReparsePointInPathComponents -Path $toolchainRoot
        if (-not (Test-Path -LiteralPath $toolchainRoot -PathType Container)) {
            throw "SEC: Khong tim thay Rust toolchain da pin: $toolchainRoot"
        }

        foreach ($payloadRoot in @($lock.PayloadRoots)) {
            $relativeNative = ([string]$payloadRoot.Path).Replace(
                '/',
                [System.IO.Path]::DirectorySeparatorChar
            )
            $rootPath = Join-Path $toolchainRoot $relativeNative
            $leaseSet = Open-PrynXPayloadLeaseSet `
                -Root $rootPath `
                -Entries $payloadRoot.Entries `
                -Purpose "Rust toolchain/$($payloadRoot.Path)"
            foreach ($payloadLease in @($leaseSet.Leases)) {
                $leases.Add($payloadLease)
            }
        }

        $cargoPath = Join-Path $toolchainRoot 'bin\cargo.exe'
        $rustcPath = Join-Path $toolchainRoot 'bin\rustc.exe'
        $rustdocPath = Join-Path $toolchainRoot 'bin\rustdoc.exe'
        return [pscustomobject]@{
            Root = $toolchainRoot
            CargoPath = $cargoPath
            RustcPath = $rustcPath
            RustdocPath = $rustdocPath
            CargoHome = $cargoHome
            ToolchainId = $lock.ToolchainId
            Release = $lock.Release
            Host = $lock.Host
            RustcCommit = $lock.RustcCommit
            CargoCommit = $lock.CargoCommit
            LockSha256 = $lock.LockSha256
            PayloadRoots = $lock.PayloadRoots
            Leases = $leases.ToArray()
            LlvmVersion = $lock.LlvmVersion
        }
    }
    catch {
        foreach ($lease in $leases) {
            Close-PrynXPayloadLease -Lease $lease
        }
        if ($null -ne $lock -and $leases.Count -eq 0) {
            Close-PrynXPayloadLease -Lease $lock.LockLease
        }
        throw
    }
}

function Assert-PrynXRustToolchainExactSet {
    param([Parameter(Mandatory = $true)]$Lease)

    if ($null -eq $Lease -or
        [string]::IsNullOrWhiteSpace([string]$Lease.Root) -or
        @($Lease.PayloadRoots).Count -ne 4) {
        throw 'SEC: Rust toolchain lease khong hop le.'
    }
    $rootFull = Assert-PrynXNoReparsePointInPathComponents -Path ([string]$Lease.Root)
    foreach ($payloadRoot in @($Lease.PayloadRoots)) {
        $relativeNative = ([string]$payloadRoot.Path).Replace(
            '/',
            [System.IO.Path]::DirectorySeparatorChar
        )
        Assert-PrynXPayloadRootExactSet `
            -Root (Join-Path $rootFull $relativeNative) `
            -Entries $payloadRoot.Entries
    }
}

function Assert-PrynXRustToolchainIdentity {
    param([Parameter(Mandatory = $true)]$Lease)

    # Chi goi ham nay sau clean-source gate: Open/lease o tren khong thuc thi byte
    # compiler cho toi khi lock tracked duoc Git chap nhan.
    Assert-PrynXRustToolchainExactSet -Lease $Lease
    $rustcOutput = @(& $Lease.RustcPath -vV 2>&1)
    $rustcExit = $LASTEXITCODE
    $rustcText = $rustcOutput -join "`n"
    if ($rustcExit -ne 0) {
        throw "SEC: Rustc da pin khong khoi dong duoc (exit=$rustcExit)."
    }
    $rustcRelease = [regex]::Match($rustcText, '(?m)^release:\s*(\S+)\s*$')
    $rustcCommit = [regex]::Match($rustcText, '(?m)^commit-hash:\s*([0-9a-f]{40})\s*$')
    $rustcHost = [regex]::Match($rustcText, '(?m)^host:\s*(\S+)\s*$')
    $rustcLlvm = [regex]::Match($rustcText, '(?m)^LLVM version:\s*(\S+)\s*$')
    if (-not $rustcRelease.Success -or $rustcRelease.Groups[1].Value -ne $Lease.Release -or
        -not $rustcCommit.Success -or $rustcCommit.Groups[1].Value -ne $Lease.RustcCommit -or
        -not $rustcHost.Success -or $rustcHost.Groups[1].Value -ne $Lease.Host -or
        -not $rustcLlvm.Success -or $rustcLlvm.Groups[1].Value -ne $Lease.LlvmVersion) {
        throw 'SEC: Rustc runtime identity lech khoi Rust toolchain lock.'
    }

    $cargoOutput = @(& $Lease.CargoPath -Vv 2>&1)
    $cargoExit = $LASTEXITCODE
    $cargoText = $cargoOutput -join "`n"
    if ($cargoExit -ne 0) {
        throw "SEC: Cargo da pin khong khoi dong duoc (exit=$cargoExit)."
    }
    $cargoRelease = [regex]::Match($cargoText, '(?m)^release:\s*(\S+)\s*$')
    $cargoCommit = [regex]::Match($cargoText, '(?m)^commit-hash:\s*([0-9a-f]{40})\s*$')
    $cargoHost = [regex]::Match($cargoText, '(?m)^host:\s*(\S+)\s*$')
    if (-not $cargoRelease.Success -or $cargoRelease.Groups[1].Value -ne $Lease.Release -or
        -not $cargoCommit.Success -or $cargoCommit.Groups[1].Value -ne $Lease.CargoCommit -or
        -not $cargoHost.Success -or $cargoHost.Groups[1].Value -ne $Lease.Host) {
        throw 'SEC: Cargo runtime identity lech khoi Rust toolchain lock.'
    }

    $sysrootOutput = @(& $Lease.RustcPath --print sysroot 2>&1)
    $sysrootExit = $LASTEXITCODE
    if ($sysrootExit -ne 0 -or $sysrootOutput.Count -ne 1) {
        throw 'SEC: Khong xac dinh duoc sysroot cua Rustc da pin.'
    }
    $actualSysroot = [System.IO.Path]::GetFullPath(
        ([string]$sysrootOutput[0]).Trim()
    ).TrimEnd([char[]]@('\', '/'))
    $expectedSysroot = [System.IO.Path]::GetFullPath(
        [string]$Lease.Root
    ).TrimEnd([char[]]@('\', '/'))
    if (-not [string]::Equals(
        $actualSysroot,
        $expectedSysroot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'SEC: Rustc da pin tra ve sysroot ngoai toolchain lease.'
    }
    Assert-PrynXRustToolchainExactSet -Lease $Lease
}

function Get-PrynXRustToolOverridePolicyNames {
    return @(
        'CARGO', 'RUSTC', 'RUSTDOC', 'CARGO_HOME',
        'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER',
        'CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTC_WRAPPER',
        'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTDOC',
        'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS',
        'RUSTDOCFLAGS', 'CARGO_ENCODED_RUSTDOCFLAGS',
        'CARGO_BUILD_RUSTDOCFLAGS', 'RUSTC_BOOTSTRAP',
        'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'CARGO_TARGET_DIR',
        'CARGO_BUILD_TARGET_DIR', 'CARGO_NET_GIT_FETCH_WITH_CLI',
        'CARGO_PROFILE_RELEASE_LTO', 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS',
        'CARGO_PROFILE_RELEASE_STRIP'
    )
}

function Get-PrynXRustToolOverrideVariableNames {
    $environment = [Environment]::GetEnvironmentVariables(
        [EnvironmentVariableTarget]::Process
    )
    $names = New-Object System.Collections.Generic.HashSet[string] `
        ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @(Get-PrynXRustToolOverridePolicyNames)) {
        if ($environment.Contains($name)) {
            $null = $names.Add($name)
        }
    }
    foreach ($key in @($environment.Keys)) {
        $name = [string]$key
        if ($name -match '^CARGO_TARGET_[A-Z0-9_]+_(LINKER|RUNNER|RUSTFLAGS)$' -or
            $name -match '^CARGO_PROFILE_') {
            $null = $names.Add($name)
        }
    }
    return @($names | Sort-Object)
}

function Clear-PrynXAmbientRustToolOverrides {
    $names = New-Object System.Collections.Generic.HashSet[string] `
        ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @(Get-PrynXRustToolOverridePolicyNames)) {
        $null = $names.Add($name)
    }
    foreach ($name in @(Get-PrynXRustToolOverrideVariableNames)) {
        $null = $names.Add($name)
    }
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable(
            [string]$name,
            $null,
            [EnvironmentVariableTarget]::Process
        )
    }
    # Windows PowerShell 5.1/.NET Framework xoa bien khi set chuoi rong. Vi vay
    # wrapper phai absent sau clean; Cargo config duoc gate rieng ben duoi.
}

function Assert-PrynXRustToolEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$CargoPath,
        [Parameter(Mandatory = $true)][string]$RustcPath,
        [Parameter(Mandatory = $true)][string]$RustdocPath,
        [Parameter(Mandatory = $true)][string]$CargoHome
    )

    $expectedPaths = @{
        CARGO = $CargoPath
        RUSTC = $RustcPath
        RUSTDOC = $RustdocPath
        CARGO_HOME = $CargoHome
    }
    foreach ($entry in $expectedPaths.GetEnumerator()) {
        $actual = [Environment]::GetEnvironmentVariable(
            [string]$entry.Key,
            [EnvironmentVariableTarget]::Process
        )
        if ([string]::IsNullOrWhiteSpace($actual) -or
            -not [string]::Equals(
                [System.IO.Path]::GetFullPath($actual),
                [System.IO.Path]::GetFullPath([string]$entry.Value),
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw "SEC: Bien $($entry.Key) khong tro dung Rust toolchain da lease."
        }
    }
    foreach ($wrapperName in @('RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER')) {
        $wrapperValue = [Environment]::GetEnvironmentVariable(
            $wrapperName,
            [EnvironmentVariableTarget]::Process
        )
        if ($null -ne $wrapperValue -and $wrapperValue.Length -ne 0) {
            throw "SEC: $wrapperName khong duoc tro den Cargo wrapper."
        }
    }

    $allowedControlledValues = @{
        RUSTFLAGS = @('', '-C target-cpu=x86-64-v2')
        CARGO_PROFILE_RELEASE_LTO = @('', 'thin')
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS = @('', '1')
        CARGO_PROFILE_RELEASE_STRIP = @('', 'symbols')
    }
    foreach ($entry in $allowedControlledValues.GetEnumerator()) {
        $value = [Environment]::GetEnvironmentVariable(
            [string]$entry.Key,
            [EnvironmentVariableTarget]::Process
        )
        if ($null -ne $value -and $entry.Value -notcontains [string]$value) {
            throw "SEC: Bien $($entry.Key) lech khoi gia tri Rust build da audit."
        }
    }

    $allowedNames = @(
        'CARGO', 'RUSTC', 'RUSTDOC', 'CARGO_HOME', 'RUSTC_WRAPPER',
        'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS',
        'CARGO_PROFILE_RELEASE_LTO', 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS',
        'CARGO_PROFILE_RELEASE_STRIP'
    )
    $unexpected = @(Get-PrynXRustToolOverrideVariableNames | Where-Object {
            $_ -notin $allowedNames
        })
    if ($unexpected.Count -gt 0) {
        throw "SEC: Con Rust/Cargo override khong duoc phep: $($unexpected -join ', ')."
    }
}

function Assert-PrynXCargoConfigurationAuthority {
    param(
        [Parameter(Mandatory = $true)][string]$CargoHome,
        [Parameter(Mandatory = $true)][string[]]$WorkingDirectories
    )

    $configurationDirectories = New-Object System.Collections.Generic.HashSet[string] `
        ([System.StringComparer]::OrdinalIgnoreCase)
    $cargoHomeFull = Assert-PrynXNoReparsePointInPathComponents -Path $CargoHome
    $null = $configurationDirectories.Add($cargoHomeFull)

    if ($WorkingDirectories.Count -eq 0) {
        throw 'SEC: Phai khai bao working directory de gate Cargo config.'
    }
    foreach ($workingDirectory in $WorkingDirectories) {
        if ([string]::IsNullOrWhiteSpace($workingDirectory) -or
            -not [System.IO.Path]::IsPathRooted($workingDirectory)) {
            throw "SEC: Cargo working directory khong hop le: $workingDirectory"
        }
        $current = Assert-PrynXNoReparsePointInPathComponents -Path $workingDirectory
        if (-not (Test-Path -LiteralPath $current -PathType Container)) {
            throw "SEC: Cargo working directory khong ton tai: $current"
        }
        $current = [System.IO.Path]::GetFullPath($current)
        while (-not [string]::IsNullOrWhiteSpace($current)) {
            $null = $configurationDirectories.Add((Join-Path $current '.cargo'))
            $parent = [System.IO.Directory]::GetParent($current)
            if ($null -eq $parent -or [string]::Equals(
                    $parent.FullName,
                    $current,
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                break
            }
            $current = $parent.FullName
        }
    }

    # SEC (audit 2026-09-04): Cargo merge config tu CARGO_HOME va moi ancestor.
    # Check sat consumer; create-child race sau check van la residual cua lo nay.
    foreach ($configurationDirectory in $configurationDirectories) {
        foreach ($fileName in @('config', 'config.toml')) {
            $candidate = Assert-PrynXNoReparsePointInPathComponents -Path (
                Join-Path $configurationDirectory $fileName
            )
            if (Test-Path -LiteralPath $candidate) {
                throw "SEC: Cargo config khong duoc phep trong release build: $candidate"
            }
        }
    }
}

function Close-PrynXReleaseExecutableLease {
    param($Lease)

    Close-PrynXPayloadLease -Lease $Lease
}

function Open-PrynXTrustedReleaseFileSetLease {
    param(
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [Parameter(Mandatory = $true)][string[]]$RelativePaths,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    $rootFull = Assert-PrynXNoReparsePointInPathComponents -Path $AllowedRoot
    if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
        throw "SEC: Khong tim thay root $Purpose`: $rootFull"
    }
    $rootPrefix = $rootFull.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    $leases = New-Object System.Collections.Generic.List[object]
    $files = @{}
    try {
        foreach ($relativePath in $RelativePaths) {
            if ([string]::IsNullOrWhiteSpace($relativePath) -or
                [System.IO.Path]::IsPathRooted($relativePath) -or
                $relativePath -match '(^|[\\/])\.\.([\\/]|$)') {
                throw "SEC: Relative path khong hop le trong $Purpose."
            }
            $candidate = [System.IO.Path]::GetFullPath((Join-Path $rootFull $relativePath))
            if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "SEC: File $Purpose thoat khoi root da duyet."
            }
            $directorySet = Open-PrynXPayloadDirectoryChainLease `
                -DirectoryPath ([System.IO.Path]::GetDirectoryName($candidate)) `
                -Purpose "$Purpose ancestor"
            foreach ($directoryLease in @($directorySet.Leases)) {
                $leases.Add($directoryLease)
            }
            $fileLease = Open-PrynXPayloadFileLease `
                -Path $candidate `
                -Purpose "$Purpose/$relativePath"
            $leases.Add($fileLease)
            $files[$relativePath] = $fileLease
        }
        return [pscustomobject]@{
            Root = $rootFull
            Files = $files
            Leases = $leases.ToArray()
        }
    }
    catch {
        foreach ($lease in $leases) { Close-PrynXPayloadLease -Lease $lease }
        throw
    }
}
