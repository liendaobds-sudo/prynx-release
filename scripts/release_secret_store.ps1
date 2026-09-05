#requires -version 5

# SEC (audit 2026-08-03 §REL.SECRET): kho bí mật phát hành dùng DPAPI CurrentUser.
# File CLIXML chỉ giải mã được bởi đúng tài khoản Windows đã lưu nó; khóa không còn
# nằm dạng plaintext trong repo, script launcher hoặc lịch sử lệnh.

$script:PrynXReleaseSecretSchema = 1
$script:PrynXReleaseProjectRef = "ryvyuxjgdcvoxujqmggm"
$script:PrynXReleaseSupabaseUrl = "https://ryvyuxjgdcvoxujqmggm.supabase.co"

function Assert-PrynXReleasePrivateStorePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    $policyPath = $resolved.Replace('/', '\')
    if ($policyPath.StartsWith(
            '\\',
            [System.StringComparison]::Ordinal
        ) -or $policyPath.StartsWith(
            '\??\',
            [System.StringComparison]::Ordinal
        )) {
        # Đường dẫn verbatim/device có thể trỏ vào repo nhưng né phép so sánh
        # chuỗi bên dưới; UNC cũng không phù hợp cho kho DPAPI của máy build.
        throw "Kho phat hanh khong chap nhan duong dan UNC/device: $resolved"
    }
    $repoRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot "..")
    ).Replace('/', '\').TrimEnd([char[]]@('\', '/'))
    $repoPrefix = $repoRoot + [System.IO.Path]::DirectorySeparatorChar
    if ([string]::Equals(
            $policyPath,
            $repoRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or $policyPath.StartsWith(
            $repoPrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Kho phat hanh khong duoc nam trong repo/staging/output: $resolved"
    }

    # SEC (audit 2026-09-03 §SEC.20-S1): GetFullPath chi chuan hoa chuoi,
    # khong giai quyet junction/symlink. Kiem tung thanh phan dang ton tai de
    # mot duong dan ben ngoai khong the vong nguoc vao repo/output qua reparse.
    # Thanh phan chua ton tai se duoc kiem lai ngay sau khi Save tao thu muc cha.
    $pathRoot = [System.IO.Path]::GetPathRoot($resolved)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "Duong dan kho phat hanh khong co volume/root hop le: $resolved"
    }
    $current = $pathRoot
    if (-not (Test-Path -LiteralPath $current -PathType Container -ErrorAction Stop)) {
        throw "Volume/root cua kho phat hanh khong ton tai: $current"
    }
    $rootItem = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Duong dan kho phat hanh chua reparse point: $current"
    }
    foreach ($component in @($resolved.Substring($pathRoot.Length).Split(
                [char[]]@('\', '/'),
                [System.StringSplitOptions]::RemoveEmptyEntries
            ))) {
        $current = Join-Path $current $component
        if (-not (Test-Path -LiteralPath $current -ErrorAction Stop)) {
            break
        }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Duong dan kho phat hanh chua reparse point: $current"
        }
    }
    return $resolved
}

function Resolve-PrynXReleaseSecretStorePath {
    param([string]$StorePath = "")

    if ([string]::IsNullOrWhiteSpace($StorePath)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw "Khong tim thay LOCALAPPDATA de luu khoa phat hanh."
        }
        $StorePath = Join-Path $env:LOCALAPPDATA "PrynX\ReleaseSecrets\secrets.clixml"
    }
    # Cam TOAN BO repo, khong chi cac thu muc resource/output da biet. Mot file
    # secret dat o docs/ hay repo root van co the bi git-add/copy nham ve sau.
    return Assert-PrynXReleasePrivateStorePath -Path $StorePath
}

function Set-PrynXPrivatePathAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$IsDirectory
    )

    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $sid) { throw "Khong xac dinh duoc tai khoan Windows hien tai." }

    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $accessType = [System.Security.AccessControl.AccessControlType]::Allow
    if ($IsDirectory) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            $rights,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            $accessType
        )
        $acl.SetAccessRuleProtection($true, $false)
        [void]$acl.AddAccessRule($rule)
        [System.IO.Directory]::SetAccessControl($Path, $acl)
    } else {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $accessType)
        $acl.SetAccessRuleProtection($true, $false)
        [void]$acl.AddAccessRule($rule)
        [System.IO.File]::SetAccessControl($Path, $acl)
    }
}

function ConvertFrom-PrynXSecureString {
    param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

    $bstr = [IntPtr]::Zero
    try {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

function Save-PrynXReleaseSecrets {
    param(
        [Parameter(Mandatory = $true)][Security.SecureString]$SupabaseSecret,
        [string]$StorePath = ""
    )

    $plain = $null
    try {
        $plain = ConvertFrom-PrynXSecureString -SecureValue $SupabaseSecret
        if ($plain -notmatch '^sb_secret_[A-Za-z0-9_-]{20,}$') {
            throw "Chi chap nhan Supabase secret key moi (bat dau bang sb_secret_)."
        }
    } finally {
        $plain = $null
    }

    $resolvedPath = Resolve-PrynXReleaseSecretStorePath -StorePath $StorePath
    $parent = Split-Path -Parent $resolvedPath
    [void](New-Item -ItemType Directory -Path $parent -Force)
    # Thu muc co the chua ton tai o lan resolve dau. Kiem lai sau khi tao de moi
    # thanh phan thuc te deu phai la directory/file thuong, khong phai reparse.
    $resolvedPath = Assert-PrynXReleasePrivateStorePath -Path $resolvedPath
    Set-PrynXPrivatePathAcl -Path $parent -IsDirectory $true

    $payload = [pscustomobject]@{
        SchemaVersion  = $script:PrynXReleaseSecretSchema
        ProjectRef     = $script:PrynXReleaseProjectRef
        SupabaseUrl    = $script:PrynXReleaseSupabaseUrl
        SupabaseSecret = $SupabaseSecret
    }
    $tempPath = Join-Path $parent ("secrets-" + [guid]::NewGuid().ToString("N") + ".tmp")
    try {
        $payload | Export-Clixml -LiteralPath $tempPath -Depth 3 -Force
        Move-Item -LiteralPath $tempPath -Destination $resolvedPath -Force
        $resolvedPath = Assert-PrynXReleasePrivateStorePath -Path $resolvedPath
        Set-PrynXPrivatePathAcl -Path $resolvedPath -IsDirectory $false
    } finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
    return $resolvedPath
}

function Get-PrynXReleaseSupabaseSecret {
    param([string]$StorePath = "")

    $resolvedPath = Resolve-PrynXReleaseSecretStorePath -StorePath $StorePath
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Chua co kho khoa phat hanh an toan. Hay chay scripts\setup_release_secrets.ps1."
    }

    $payload = Import-Clixml -LiteralPath $resolvedPath
    if ([int]$payload.SchemaVersion -ne $script:PrynXReleaseSecretSchema -or
        [string]$payload.ProjectRef -ne $script:PrynXReleaseProjectRef -or
        [string]$payload.SupabaseUrl -ne $script:PrynXReleaseSupabaseUrl -or
        $payload.SupabaseSecret -isnot [Security.SecureString]) {
        throw "Kho khoa phat hanh sai schema/project; tu choi nap."
    }

    return $payload.SupabaseSecret
}

function Import-PrynXReleaseEnvironment {
    param([string]$StorePath = "")

    # Chỉ giữ cho tương thích CLI cũ. Launcher phát hành không gọi hàm này;
    # build_production tự giải mã just-in-time để process con không kế thừa key.
    $secureSecret = Get-PrynXReleaseSupabaseSecret -StorePath $StorePath
    $plain = $null
    try {
        $plain = ConvertFrom-PrynXSecureString -SecureValue $secureSecret
        if ($plain -notmatch '^sb_secret_[A-Za-z0-9_-]{20,}$') {
            throw "Kho khoa khong chua Supabase secret key hop le."
        }
        $env:PRYNX_SUPABASE_URL = $script:PrynXReleaseSupabaseUrl
        $env:PRYNX_SUPABASE_SECRET_KEY = $plain
        Remove-Item Env:PRYNX_SUPABASE_SERVICE_KEY -ErrorAction SilentlyContinue
    } finally {
        $plain = $null
        if ($secureSecret) { $secureSecret.Dispose() }
        $secureSecret = $null
    }
}

function Clear-PrynXReleaseEnvironment {
    Remove-Item Env:PRYNX_SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:PRYNX_SUPABASE_SERVICE_KEY -ErrorAction SilentlyContinue
}

# ============================================================
#  [DIELINE-PROBE 2026-08-26 §F] Kho license TEST cho probe kich hoat
#
#  Vi sao KHO RIENG chu khong them field vao secrets.clixml:
#  `Get-PrynXReleaseSupabaseSecret` tu choi nap khi SchemaVersion khac 1. Them
#  mot field vao payload cu se lam VO HIEU kho da cau hinh tren may phat hanh
#  (bump schema = phai chay lai setup_release_secrets.ps1 va nhap lai Supabase
#  secret). Tach file probe.clixml giu hai vong doi doc lap: doi license TEST
#  khong dong toi khoa Supabase va nguoc lai.
#
#  License nay la license TEST danh RIENG cho probe. KHONG BAO GIO dung license
#  khach: probe goi license-verify that nen se tieu mot suat activation vinh vien
#  cho `machine_id` co dinh ben duoi.
# ============================================================

$script:PrynXReleaseProbeSecretSchema = 1
# Machine id co dinh cua probe. Hop le vi `authorize_dieline` NHAN hwid lam tham
# so va chi so voi claim `m`; module native khong tu tinh hardware id. Gia tri co
# dinh nghia la probe tieu dung MOT suat activation, khong sinh them moi lan build.
$script:PrynXReleaseProbeMachineId = "PRYNX-RELEASE-PROBE-01"

function Resolve-PrynXReleaseProbeStorePath {
    param([string]$StorePath = "")

    if ([string]::IsNullOrWhiteSpace($StorePath)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw "Khong tim thay LOCALAPPDATA de luu license TEST cua probe."
        }
        $StorePath = Join-Path $env:LOCALAPPDATA "PrynX\ReleaseSecrets\probe.clixml"
    }
    # License TEST dung cung mot trust boundary voi secret Supabase.
    return Assert-PrynXReleasePrivateStorePath -Path $StorePath
}

function Test-PrynXReleaseProbeLicenseShape {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    # Chi bat cac loi dan sai ro rang, khong doan dinh dang key cua admin.
    if ($Value -match '\s') { return $false }
    if ($Value.Length -lt 8 -or $Value.Length -gt 200) { return $false }
    if ($Value -like 'sb_secret_*') { return $false }
    if ($Value -like 'eyJ*') { return $false }
    return $true
}

function Save-PrynXReleaseProbeLicense {
    param(
        [Parameter(Mandatory = $true)][Security.SecureString]$ProbeLicense,
        [string]$StorePath = ""
    )

    $plain = $null
    try {
        $plain = ConvertFrom-PrynXSecureString -SecureValue $ProbeLicense
        if (-not (Test-PrynXReleaseProbeLicenseShape -Value $plain)) {
            throw "Gia tri nhap khong giong license TEST (khong khoang trang, 8-200 ky tu, khong phai sb_secret_ hay JWT)."
        }
    } finally {
        $plain = $null
    }

    $resolvedPath = Resolve-PrynXReleaseProbeStorePath -StorePath $StorePath
    $parent = Split-Path -Parent $resolvedPath
    [void](New-Item -ItemType Directory -Path $parent -Force)
    $resolvedPath = Assert-PrynXReleasePrivateStorePath -Path $resolvedPath
    Set-PrynXPrivatePathAcl -Path $parent -IsDirectory $true

    $payload = [pscustomobject]@{
        SchemaVersion = $script:PrynXReleaseProbeSecretSchema
        ProjectRef    = $script:PrynXReleaseProjectRef
        MachineId     = $script:PrynXReleaseProbeMachineId
        ProbeLicense  = $ProbeLicense
    }
    $tempPath = Join-Path $parent ("probe-" + [guid]::NewGuid().ToString("N") + ".tmp")
    try {
        $payload | Export-Clixml -LiteralPath $tempPath -Depth 3 -Force
        Move-Item -LiteralPath $tempPath -Destination $resolvedPath -Force
        $resolvedPath = Assert-PrynXReleasePrivateStorePath -Path $resolvedPath
        Set-PrynXPrivatePathAcl -Path $resolvedPath -IsDirectory $false
    } finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
    return $resolvedPath
}

function Get-PrynXReleaseProbeLicense {
    param([string]$StorePath = "")

    $resolvedPath = Resolve-PrynXReleaseProbeStorePath -StorePath $StorePath
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Chua co license TEST cho probe kich hoat. Hay chay scripts\setup_release_probe_license.ps1."
    }

    $payload = Import-Clixml -LiteralPath $resolvedPath
    if ([int]$payload.SchemaVersion -ne $script:PrynXReleaseProbeSecretSchema -or
        [string]$payload.ProjectRef -ne $script:PrynXReleaseProjectRef -or
        [string]$payload.MachineId -ne $script:PrynXReleaseProbeMachineId -or
        $payload.ProbeLicense -isnot [Security.SecureString]) {
        throw "Kho license TEST cua probe sai schema/project; tu choi nap."
    }

    return $payload.ProbeLicense
}
