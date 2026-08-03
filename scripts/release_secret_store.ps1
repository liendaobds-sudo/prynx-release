#requires -version 5

# SEC (audit 2026-08-03 §REL.SECRET): kho bí mật phát hành dùng DPAPI CurrentUser.
# File CLIXML chỉ giải mã được bởi đúng tài khoản Windows đã lưu nó; khóa không còn
# nằm dạng plaintext trong repo, script launcher hoặc lịch sử lệnh.

$script:PrynXReleaseSecretSchema = 1
$script:PrynXReleaseProjectRef = "ryvyuxjgdcvoxujqmggm"
$script:PrynXReleaseSupabaseUrl = "https://ryvyuxjgdcvoxujqmggm.supabase.co"

function Resolve-PrynXReleaseSecretStorePath {
    param([string]$StorePath = "")

    if ([string]::IsNullOrWhiteSpace($StorePath)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw "Khong tim thay LOCALAPPDATA de luu khoa phat hanh."
        }
        $StorePath = Join-Path $env:LOCALAPPDATA "PrynX\ReleaseSecrets\secrets.clixml"
    }
    return [System.IO.Path]::GetFullPath($StorePath)
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
