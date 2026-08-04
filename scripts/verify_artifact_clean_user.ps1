<#
.SYNOPSIS
    Chay installed-artifact verifier trong mot tai khoan Windows tam sach.

.DESCRIPTION
    BUILD (audit 2026-08-03 REL.CLEANUSER): tao standard local user ngau nhien,
    nap profile, chay verifier, roi xoa dung profile/tai khoan theo SID. Script
    khong dong cham metadata/thu muc PrynX cua tai khoan dang dung.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Manifest,
    [string]$ExpectedVersion = "",
    [switch]$ExpectNoGhostscript,
    [ValidateRange(10, 180)][int]$StartupTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$VERIFIER = Join-Path $PSScriptRoot "verify_installed_artifact.ps1"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "verify_artifact_clean_user.ps1 can quyen Administrator de tao/xoa tai khoan tam."
}

foreach ($path in @($Installer, $Manifest, $VERIFIER)) {
    if ([string]::IsNullOrWhiteSpace($path) -or $path.Contains('"')) {
        throw "Duong dan verifier khong hop le."
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Khong tim thay file bat buoc: $path"
    }
}
$Installer = [System.IO.Path]::GetFullPath($Installer)
$Manifest = [System.IO.Path]::GetFullPath($Manifest)
$VERIFIER = [System.IO.Path]::GetFullPath($VERIFIER)

if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and
    $ExpectedVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$') {
    throw "ExpectedVersion khong phai SemVer hop le."
}

function New-PrynXTemporaryPassword {
    # Tao SecureString truc tiep; khong tao password plaintext trong log/argv/file.
    $alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%"
    $bytes = New-Object byte[] 28
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $secure = New-Object Security.SecureString
    try {
        $rng.GetBytes($bytes)
        foreach ($required in @('a', 'A', '7', '!')) { $secure.AppendChar($required) }
        foreach ($value in $bytes) {
            $secure.AppendChar($alphabet[$value % $alphabet.Length])
        }
        $secure.MakeReadOnly()
        return $secure
    } finally {
        $rng.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

$userName = "PrynXRel" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$securePassword = New-PrynXTemporaryPassword
$createdUser = $null
$createdSid = $null
$verificationExit = $null
$cleanupFailures = New-Object System.Collections.Generic.List[string]
$logDir = Join-Path $ROOT "tmp\clean-user-smoke"
[void](New-Item -ItemType Directory -Path $logDir -Force)
$runId = [guid]::NewGuid().ToString("N")
$stdoutPath = Join-Path $logDir ("stdout-" + $runId + ".log")
$stderrPath = Join-Path $logDir ("stderr-" + $runId + ".log")

try {
    if (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue) {
        throw "Tai khoan tam trung ten bat ngo: $userName"
    }
    $createdUser = New-LocalUser -Name $userName -Password $securePassword `
        -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword `
        -Description "PrynX release artifact clean-profile smoke test"
    $createdSid = [string]$createdUser.Sid.Value
    if ([string]::IsNullOrWhiteSpace($createdSid)) { throw "Khong doc duoc SID tai khoan tam." }

    $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$userName", $securePassword)
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", ('"' + $VERIFIER + '"'),
        "-Installer", ('"' + $Installer + '"'),
        "-Manifest", ('"' + $Manifest + '"'),
        "-StartupTimeoutSeconds", [string]$StartupTimeoutSeconds
    )
    if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
        $arguments += @("-ExpectedVersion", $ExpectedVersion)
    }
    if ($ExpectNoGhostscript) { $arguments += "-ExpectNoGhostscript" }

    Write-Host "  [CLEAN USER] Dang chay verifier trong profile tam $userName ($createdSid)..." -ForegroundColor Cyan
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments `
        -Credential $credential -LoadUserProfile -WindowStyle Hidden -Wait -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $verificationExit = $process.ExitCode
    if ($verificationExit -ne 0) {
        $stderrTail = if (Test-Path -LiteralPath $stderrPath) {
            (Get-Content -LiteralPath $stderrPath -Tail 30 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
        } else { "" }
        throw "Clean-user verifier that bai (exit=$verificationExit).`n$stderrTail"
    }
    Write-Host "  [CLEAN USER] Runtime smoke dat." -ForegroundColor Green
} finally {
    $credential = $null
    if ($securePassword) { $securePassword.Dispose() }
    $securePassword = $null

    if (-not [string]::IsNullOrWhiteSpace($createdSid)) {
        try {
            $profile = Get-CimInstance Win32_UserProfile -Filter ("SID='" + $createdSid.Replace("'", "''") + "'") `
                -ErrorAction SilentlyContinue
            if ($profile) {
                if ($profile.Loaded) {
                    $cleanupFailures.Add("Profile $createdSid van dang loaded.")
                } else {
                    $profile | Remove-CimInstance -ErrorAction Stop
                }
            }
        } catch {
            $cleanupFailures.Add("Khong xoa duoc profile $createdSid`: $($_.Exception.Message)")
        }
    }

    if ($createdUser) {
        try {
            $current = Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
            if ($current -and [string]$current.Sid.Value -eq $createdSid) {
                Remove-LocalUser -Name $userName -ErrorAction Stop
            } elseif ($current) {
                $cleanupFailures.Add("Tu choi xoa user $userName vi SID khong khop.")
            }
        } catch {
            $cleanupFailures.Add("Khong xoa duoc user $userName`: $($_.Exception.Message)")
        }
    }

    if ($verificationExit -eq 0) {
        foreach ($path in @($stdoutPath, $stderrPath)) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($cleanupFailures.Count -gt 0) {
    throw "Verifier da chay nhung cleanup tai khoan tam chua tron ven: $($cleanupFailures -join ' | ')"
}
