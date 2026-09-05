#requires -version 5

$ErrorActionPreference = "Stop"
$helper = Join-Path $PSScriptRoot "release_signing_key_guard.ps1"
. $helper

function Assert-ThrowsLike {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Pattern
    )
    try {
        & $Action
    } catch {
        if ($_.Exception.Message -notmatch $Pattern) {
            throw "Sai ly do tu choi. Mong '$Pattern', nhan: $($_.Exception.Message)"
        }
        return
    }
    throw "Mong thao tac bi tu choi boi: $Pattern"
}

function Assert-OperationBlocked {
    param([Parameter(Mandatory = $true)][scriptblock]$Action)

    try {
        & $Action
    } catch {
        return
    }
    throw "Mong Windows chan mutation/swap trong luc lease dang mo."
}

function Set-OwnerOnlyAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]
        [System.Security.Principal.SecurityIdentifier]$Sid,
        [switch]$Directory
    )

    if ($Directory) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $Sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
    } else {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $Sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($Sid)
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function New-ProtectedKeyFixture {
    param(
        [Parameter(Mandatory = $true)][string]$DirectoryPath,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)]
        [System.Security.Principal.SecurityIdentifier]$Sid
    )

    [void](New-Item -ItemType Directory -Path $DirectoryPath -Force)
    Set-OwnerOnlyAcl -Path $DirectoryPath -Sid $Sid -Directory
    $path = Join-Path $DirectoryPath $FileName
    [System.IO.File]::WriteAllText($path, "NOT-A-REAL-KEY")
    Set-OwnerOnlyAcl -Path $path -Sid $Sid
    return $path
}

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $tempBase `
    ("prynx-signing-key-guard-" + [guid]::NewGuid().ToString("N"))
$fakeRepo = Join-Path $testRoot "repo"
$keyDir = Join-Path $testRoot "keys"
$keyPath = Join-Path $keyDir "test.key"
$createdJunctions = New-Object System.Collections.Generic.List[string]
$testFailureMessage = $null

try {
    [void](New-Item -ItemType Directory -Path $fakeRepo -Force)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $keyPath = New-ProtectedKeyFixture `
        -DirectoryPath $keyDir `
        -FileName "test.key" `
        -Sid $sid

    $acceptedPath = Assert-PrynXUpdaterSigningKey `
        -Path $keyPath -RepositoryRoot $fakeRepo -HasPassword $true
    if (-not [string]::Equals(
        $acceptedPath,
        [System.IO.Path]::GetFullPath($keyPath),
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Guard tra sai canonical key path."
    }

    Assert-ThrowsLike -Pattern "passphrase" -Action {
        Assert-PrynXUpdaterSigningKey `
            -Path $keyPath -RepositoryRoot $fakeRepo -HasPassword $false
    }
    Assert-ThrowsLike -Pattern "source repository" -Action {
        Assert-PrynXUpdaterSigningKey `
            -Path $keyPath -RepositoryRoot $testRoot -HasPassword $true
    }

    # File/thu muc temp mac dinh giu ACL ke thua; policy cu van phai fail-closed.
    $looseDir = Join-Path $testRoot "loose"
    [void](New-Item -ItemType Directory -Path $looseDir -Force)
    $looseKey = Join-Path $looseDir "loose.key"
    [System.IO.File]::WriteAllText($looseKey, "NOT-A-REAL-KEY")
    Assert-ThrowsLike -Pattern "ke thua" -Action {
        Assert-PrynXUpdaterSigningKey `
            -Path $looseKey -RepositoryRoot $fakeRepo -HasPassword $true
    }
    # Guard da mo file/directory handle truoc ACL check; nhanh reject van phai
    # dong het handle, neu khong rename nay se bi Windows chan.
    $looseDirMoved = "$looseDir-moved"
    [System.IO.Directory]::Move($looseDir, $looseDirMoved)
    [System.IO.Directory]::Move($looseDirMoved, $looseDir)

    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $ownerRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($ownerRule)
    [void](Assert-PrynXUpdaterSigningKeyAcl -Acl $acl -CurrentSid ([string]$sid.Value))
    $foreignRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-11')),
        [System.Security.AccessControl.FileSystemRights]::Read,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($foreignRule)
    Assert-ThrowsLike -Pattern "principal" -Action {
        Assert-PrynXUpdaterSigningKeyAcl `
            -Acl $acl -CurrentSid ([string]$sid.Value)
    }

    # Handle lease phai chan ca ghi truc tiep va replace/swap; sau Dispose hai
    # thao tac phai hoat dong lai de chung minh test khong fail vi ACL.
    $replacementPath = Join-Path $testRoot "replacement.key"
    $swappedOriginalPath = Join-Path $testRoot "swapped-original.key"
    [System.IO.File]::WriteAllText($replacementPath, "REPLACEMENT")
    $keyLease = Open-PrynXUpdaterSigningKeyLease `
        -Path $keyPath -RepositoryRoot $fakeRepo -HasPassword $true
    try {
        # Signer mo mot read handle rieng theo path; lease khong duoc chan read
        # hop le trong khi van phai chan write/delete/replace.
        $signerReader = [System.IO.File]::Open(
            $keyPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        try {
            if ($signerReader.Length -le 0) {
                throw "Signer reader nhan file key rong ngoai du kien."
            }
        } finally {
            $signerReader.Dispose()
        }
        Assert-OperationBlocked -Action {
            [System.IO.File]::WriteAllText($keyPath, "MUTATED")
        }
        Assert-OperationBlocked -Action {
            [System.IO.File]::Move($keyPath, $swappedOriginalPath)
        }
    } finally {
        Close-PrynXPayloadLease -Lease $keyLease
    }
    [System.IO.File]::WriteAllText($keyPath, "ALLOWED-AFTER-DISPOSE")
    [System.IO.File]::Move($keyPath, $swappedOriginalPath)
    [System.IO.File]::Move($replacementPath, $keyPath)
    if (Test-Path -LiteralPath $replacementPath) {
        throw "Swap van bi chan sau khi lease da Dispose."
    }

    # Composite lease phai pin moi directory component, khong chi file va
    # immediate parent. Rename ancestor bi chan trong lease va duoc phep lai
    # sau Close de chung minh cleanup khong dua vao process exit.
    $leaseAncestor = Join-Path $testRoot "lease-ancestor"
    $leaseKeyDir = Join-Path $leaseAncestor "level-one\level-two"
    $leaseKey = New-ProtectedKeyFixture `
        -DirectoryPath $leaseKeyDir `
        -FileName "ancestor-lease.key" `
        -Sid $sid
    $ancestorLease = Open-PrynXUpdaterSigningKeyLease `
        -Path $leaseKey -RepositoryRoot $fakeRepo -HasPassword $true
    $expectedAncestors = @(Get-PrynXUpdaterSigningAncestorPaths -FilePath $leaseKey)
    try {
        $actualAncestors = @($ancestorLease.DirectoryLeases | ForEach-Object { $_.Path })
        if ($actualAncestors.Count -ne $expectedAncestors.Count) {
            throw "Composite lease khong giu du moi directory component."
        }
        for ($index = 0; $index -lt $expectedAncestors.Count; $index++) {
            if (-not [string]::Equals(
                [string]$actualAncestors[$index],
                [string]$expectedAncestors[$index],
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                throw "Composite lease giu sai directory component."
            }
            if ($ancestorLease.DirectoryLeases[$index].Stream.IsClosed -or
                $ancestorLease.DirectoryLeases[$index].Stream.IsInvalid) {
                throw "Directory handle bi dong som truoc signer."
            }
        }
        Assert-OperationBlocked -Action {
            [System.IO.Directory]::Move($leaseAncestor, "$leaseAncestor-moved")
        }
    } finally {
        Close-PrynXPayloadLease -Lease $ancestorLease
    }
    [System.IO.Directory]::Move($leaseAncestor, "$leaseAncestor-moved")
    [System.IO.Directory]::Move("$leaseAncestor-moved", $leaseAncestor)

    # Hardlink that tren NTFS phai bi bat bang NumberOfLinks cua file handle.
    $hardlinkDir = Join-Path $testRoot "hardlink"
    $hardlinkKey = New-ProtectedKeyFixture `
        -DirectoryPath $hardlinkDir `
        -FileName "hardlink.key" `
        -Sid $sid
    $hardlinkAlias = Join-Path $hardlinkDir "hardlink-alias.key"
    [void](New-Item -ItemType HardLink -Path $hardlinkAlias -Target $hardlinkKey -ErrorAction Stop)
    Assert-ThrowsLike -Pattern "Hardlink|link-count" -Action {
        $unexpectedLease = Open-PrynXUpdaterSigningKeyLease `
            -Path $hardlinkKey -RepositoryRoot $fakeRepo -HasPassword $true
        try {} finally { Close-PrynXPayloadLease -Lease $unexpectedLease }
    }

    # Named ADS khong nam trong byte stream chinh nhung van la residue bi cam.
    $adsDir = Join-Path $testRoot "ads"
    $adsKey = New-ProtectedKeyFixture `
        -DirectoryPath $adsDir `
        -FileName "ads.key" `
        -Sid $sid
    Set-Content -LiteralPath $adsKey -Stream "prynx-test" -Value "ADS" -ErrorAction Stop
    Assert-ThrowsLike -Pattern "Alternate data stream" -Action {
        $unexpectedLease = Open-PrynXUpdaterSigningKeyLease `
            -Path $adsKey -RepositoryRoot $fakeRepo -HasPassword $true
        try {} finally { Close-PrynXPayloadLease -Lease $unexpectedLease }
    }

    # Kiem ca parent reparse truc tiep va mot ancestor reparse o tang cao hon.
    # Windows policy co the cam tao junction; khi do ghi SKIP ro thay vi gia pass.
    $reparseSupported = $true
    try {
        $realParent = Join-Path $testRoot "real-parent"
        $parentKey = New-ProtectedKeyFixture `
            -DirectoryPath $realParent `
            -FileName "parent.key" `
            -Sid $sid
        $parentAlias = Join-Path $testRoot "parent-alias"
        [void](New-Item -ItemType Junction -Path $parentAlias -Target $realParent -ErrorAction Stop)
        $createdJunctions.Add($parentAlias)

        $realAncestor = Join-Path $testRoot "real-ancestor"
        $nestedKeyDir = Join-Path $realAncestor "nested\keys"
        $ancestorKey = New-ProtectedKeyFixture `
            -DirectoryPath $nestedKeyDir `
            -FileName "ancestor.key" `
            -Sid $sid
        $ancestorAlias = Join-Path $testRoot "ancestor-alias"
        [void](New-Item -ItemType Junction -Path $ancestorAlias -Target $realAncestor -ErrorAction Stop)
        $createdJunctions.Add($ancestorAlias)
    } catch {
        $reparseSupported = $false
        Write-Host "SKIP: OS/policy khong cho tao junction reparse fixture: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    if ($reparseSupported) {
        Assert-ThrowsLike -Pattern "reparse point" -Action {
            $unexpectedLease = Open-PrynXUpdaterSigningKeyLease `
                -Path (Join-Path $parentAlias (Split-Path -Leaf $parentKey)) `
                -RepositoryRoot $fakeRepo `
                -HasPassword $true
            try {} finally { Close-PrynXPayloadLease -Lease $unexpectedLease }
        }
        Assert-ThrowsLike -Pattern "reparse point" -Action {
            $unexpectedLease = Open-PrynXUpdaterSigningKeyLease `
                -Path (Join-Path $ancestorAlias "nested\keys\$(Split-Path -Leaf $ancestorKey)") `
                -RepositoryRoot $fakeRepo `
                -HasPassword $true
            try {} finally { Close-PrynXPayloadLease -Lease $unexpectedLease }
        }
    }

    $buildScript = [System.IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot -Parent) "build_production.ps1"))
    if ($buildScript -match '--password=') {
        throw "Build script van cho phep khoa updater khong passphrase."
    }
    if ($buildScript -notmatch 'Assert-ReleaseSigningAuthority') {
        throw "Build script chua goi signing authority preflight."
    }
    if ($buildScript -notmatch 'Assert-ReleaseSigningAuthority -AcquireLease') {
        throw "Build script chua mo identity lease ngay truoc signer."
    }
    $leaseAt = $buildScript.IndexOf('Assert-ReleaseSigningAuthority -AcquireLease')
    $signerAt = $buildScript.IndexOf('npx @tauriSignerArgs', $leaseAt)
    $closeAt = $buildScript.IndexOf(
        'Close-PrynXPayloadLease -Lease $script:TauriSigningKeyLease',
        $signerAt
    )
    if ($leaseAt -lt 0 -or $signerAt -le $leaseAt -or $closeAt -le $signerAt) {
        throw "Identity lease khong bao tron dung lenh signer."
    }
    if ($buildScript -notmatch '\$tauriSignerArgs \+= @\("-f", \[string\]\$script:TauriSigningKeyLease\.Path\)') {
        throw "Signer khong dung dung path cua key handle dang giu."
    }
    if ([regex]::Matches(
        $buildScript,
        'Close-PrynXPayloadLease -Lease \$script:TauriSigningKeyLease'
    ).Count -lt 2) {
        throw "Build chua co ca signer-finally va outer-finally cleanup cho key lease."
    }
    if ($buildScript -notmatch '\$script:CapturedTauriSigningPrivateKeyPassword = \$null\s+Restore-BuildOwnedEnvironment') {
        throw "Build script chua xoa password da capture trong outer finally."
    }

    # Contract thu tu nay dong cua so TOCTOU parent-swap: phai pin moi
    # ancestor truoc khi mo/kiem file key ma signer se resolve bang path.
    $guardScript = [System.IO.File]::ReadAllText($helper)
    $openGuardAt = $guardScript.IndexOf('function Open-PrynXUpdaterSigningKeyLease')
    $directoryLeaseAt = $guardScript.IndexOf(
        'Open-PrynXUpdaterSigningDirectoryLease -Path $directoryPath',
        $openGuardAt
    )
    $fileLeaseAt = $guardScript.IndexOf(
        'Open-PrynXPayloadFileLease',
        $openGuardAt
    )
    if ($openGuardAt -lt 0 -or $directoryLeaseAt -le $openGuardAt -or
        $fileLeaseAt -le $directoryLeaseAt) {
        throw "Guard chua pin chuoi directory truoc khi mo file key."
    }

    $outerFinallyAt = $buildScript.LastIndexOf('} finally {')
    $restoreAt = $buildScript.IndexOf('Restore-BuildOwnedEnvironment', $outerFinallyAt)
    foreach ($secretEnvironmentName in @(
        'TAURI_SIGNING_PRIVATE_KEY',
        'PRYNX_TAURI_SIGNING_KEY_FILE',
        'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'
    )) {
        $clearAt = $buildScript.IndexOf(
            "Remove-Item Env:$secretEnvironmentName",
            $outerFinallyAt
        )
        if ($outerFinallyAt -lt 0 -or $clearAt -le $outerFinallyAt -or
            $restoreAt -le $clearAt) {
            throw "Outer finally chua xoa $secretEnvironmentName truoc restore."
        }
    }

} catch {
    $testFailureMessage = $_.Exception.Message
} finally {
    $junctionCleanupFailed = $false
    foreach ($junction in $createdJunctions) {
        if (Test-Path -LiteralPath $junction) {
            try {
                # Directory.Delete tren junction xoa chinh link, khong recurse
                # vao target. Target deu nam trong testRoot va duoc don sau.
                [System.IO.Directory]::Delete($junction, $false)
            } catch {
                $junctionCleanupFailed = $true
                if ($null -eq $testFailureMessage) {
                    $testFailureMessage = "Khong xoa duoc junction fixture: $($_.Exception.Message)"
                }
            }
        }
    }
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    $safeTempPrefix = $tempBase.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if ($resolvedTestRoot.StartsWith($safeTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTestRoot) -match '^prynx-signing-key-guard-[0-9a-f]{32}$' -and
        (Test-Path -LiteralPath $resolvedTestRoot -PathType Container) -and
        -not $junctionCleanupFailed) {
        try {
            Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction Stop
        } catch {
            if ($null -eq $testFailureMessage) {
                $testFailureMessage = "Khong don duoc fixture da canonicalize: $($_.Exception.Message)"
            }
        }
    }
}

if ($null -ne $testFailureMessage) {
    Write-Host "FAIL: release signing key guard: $testFailureMessage" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: release signing key guard" -ForegroundColor Green
exit 0
