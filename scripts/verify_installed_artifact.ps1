<#
.SYNOPSIS
    Cai silent artifact, kiem payload va runtime da cai, roi dien bang chung vao manifest.

.DESCRIPTION
    BUILD (audit 2026-08-03 REL.10): verifier nay la cong fail-closed giua
    "Tauri build thanh cong" va "artifact duoc phep phat hanh". Script chi chap
    nhan installer/manifest cung version va cung hash, cai vao Temp, kiem payload,
    launch app, doi breadcrumb startup MOI, kiem health sidecar va payload AI/OCR.

    Script khong kill theo ten. Neu PrynX dang chay hoac port 8321 dang ban truoc
    smoke, script dung ro rang. Cleanup chi dung process tree do chinh lan verify
    nay tao va chi xoa thu muc cai ngau nhien nam ben trong Temp.

.PARAMETER Installer
    Duong dan file setup .exe. Mac dinh: file moi nhat trong Ban_Phat_Hanh.

.PARAMETER Manifest
    Duong dan release-manifest.txt. Mac dinh: canh installer.

.PARAMETER ExpectedVersion
    SemVer bat buoc phai khop manifest, ten installer va binary da cai. Neu bo
    trong, doc APP_VERSION tu manifest.

.PARAMETER ExpectNoGhostscript
    Bat buoc payload da cai KHONG chua Ghostscript.

.PARAMETER StartupTimeoutSeconds
    Thoi gian toi da doi app/sidecar san sang. Mac dinh 75 giay.

.PARAMETER KeepInstall
    Giu lai thu muc da cai de kiem tay tiep. Process smoke van duoc dung.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\verify_installed_artifact.ps1 -ExpectNoGhostscript
#>
[CmdletBinding()]
param(
    [string]$Installer,
    [string]$Manifest,
    [string]$ExpectedVersion,
    [switch]$ExpectNoGhostscript,
    [ValidateRange(10, 180)][int]$StartupTimeoutSeconds = 75,
    [switch]$KeepInstall
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$PUBLISH_DIR = Join-Path $ROOT "Ban_Phat_Hanh"
$script:AppProcess = $null
$script:TrackedProcesses = @{}
$script:CreatedRoots = @{}
$script:NuitkaCacheTarget = $null
$script:NuitkaCacheBackup = $null
$script:VerificationSucceeded = $false

# Toolhelp32 doc duoc PID cha ma khong can WMI/CIM (co the bi policy doanh nghiep
# chan). Handle dung process van duoc doi chieu them StartTime truoc khi kill.
if ($null -eq ("PrynXArtifactProcessSnapshot" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PrynXArtifactProcessSnapshot
{
    public sealed class Entry
    {
        public int ProcessId;
        public int ParentProcessId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static Entry[] Capture()
    {
        const uint TH32CS_SNAPPROCESS = 0x00000002;
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
            throw new InvalidOperationException("CreateToolhelp32Snapshot failed: " + Marshal.GetLastWin32Error());

        var result = new List<Entry>();
        var native = new PROCESSENTRY32();
        native.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        try
        {
            if (Process32FirstW(snapshot, ref native))
            {
                do
                {
                    result.Add(new Entry {
                        ProcessId = (int)native.th32ProcessID,
                        ParentProcessId = (int)native.th32ParentProcessID
                    });
                }
                while (Process32NextW(snapshot, ref native));
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return result.ToArray();
    }
}
'@
}

function Write-Step($text) { Write-Host "`n[$text]" -ForegroundColor Cyan }
function Write-OK($text) { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Bad($text) { Write-Host "  FAIL $text" -ForegroundColor Red }

function Get-ManifestField {
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

function Set-ManifestField {
    param(
        [Parameter(Mandatory = $true)][string[]]$Lines,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $pattern = "^" + [regex]::Escape($Name) + "\s*="
    $found = 0
    $result = New-Object System.Collections.Generic.List[string]
    foreach ($line in $Lines) {
        if ($line -match $pattern) {
            $found++
            $result.Add("$Name = $Value")
        } else {
            $result.Add($line)
        }
    }
    if ($found -gt 1) { throw "Manifest co trung truong $Name." }
    if ($found -eq 0) { $result.Add("$Name = $Value") }
    return @($result)
}

function Assert-BuildManifestAttestation {
    param([Parameter(Mandatory = $true)][string]$Path)

    # BUILD (audit 2026-08-04 BLD.02/BLD.04): verifier doc bang chung build
    # truoc khi cai, thay vi suy gate/provenance tu ten file hoac output hien tai.
    foreach ($field in @("FRONTEND_FEATURE_GATE", "BACKEND_FEATURE_GATE")) {
        if ((Get-ManifestField -Path $Path -Name $field) -ne "enabled") {
            throw "Manifest $field khong phai enabled."
        }
    }
    if ((Get-ManifestField -Path $Path -Name "SIDECAR_PROVENANCE") -ne "compiled-this-run") {
        throw "Manifest khong chung minh sidecar duoc bien dich trong luot build nay."
    }
    $pythonAbi = Get-ManifestField -Path $Path -Name "PYTHON_ABI"
    $buildMode = Get-ManifestField -Path $Path -Name "BUILD_MODE"
    $buildProvenance = Get-ManifestField -Path $Path -Name "BUILD_PROVENANCE"
    if ($buildMode -eq "public-release") {
        if ($pythonAbi -ne "3.11" -or $buildProvenance -ne "git-clean-commit" -or
            (Get-ManifestField -Path $Path -Name "GIT_DIRTY") -ne "no") {
            throw "Manifest public-release sai Python ABI hoac provenance source."
        }
    } elseif ($buildMode -eq "internal-full") {
        if ($pythonAbi -notin @("3.11", "3.12") -or $buildProvenance -ne "local-working-tree") {
            throw "Manifest internal-full sai Python ABI hoac provenance source."
        }
    } else {
        throw "BUILD_MODE khong duoc verifier chap nhan: $buildMode"
    }
    if ((Get-ManifestField -Path $Path -Name "GIT_COMMIT") -notmatch '^[0-9a-fA-F]{40,64}$') {
        throw "Manifest GIT_COMMIT khong hop le."
    }
}

function Assert-NoExistingPrynXProcess {
    $names = @("PrynX", "pdf-inspector", "pdf-inspector-backend")
    $conflicts = @()
    foreach ($name in $names) {
        $conflicts += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    }
    if ($conflicts.Count -gt 0) {
        $summary = ($conflicts | Sort-Object Id -Unique | ForEach-Object { "$($_.ProcessName) PID=$($_.Id)" }) -join ", "
        throw "PrynX dang co process hoat dong ($summary). Dong ung dung/process do roi chay lai; verifier se khong kill process co san."
    }
}

function Assert-NoExistingPrynXInstall {
    # NSIS /D chi doi noi copy file; product identity, uninstall key va file
    # association van dung chung. Khong smoke tren profile dang co ban cai that.
    $registryPaths = @(
        "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\PrynX",
        "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\PrynX",
        "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\PrynX",
        "Registry::HKEY_CURRENT_USER\Software\prynx\PrynX",
        "Registry::HKEY_LOCAL_MACHINE\Software\prynx\PrynX",
        "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\prynx\PrynX",
        "Registry::HKEY_CURRENT_USER\Software\Classes\prynx",
        "Registry::HKEY_CURRENT_USER\Software\Classes\PrynX.PDF",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.pdf\shell\pdf-inspector-combine",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.jpg\shell\pdf-inspector-combine",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.jpeg\shell\pdf-inspector-combine",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.png\shell\pdf-inspector-combine",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.jpg\shell\pdf-inspector-convert",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.jpeg\shell\pdf-inspector-convert",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.png\shell\pdf-inspector-convert"
    )
    foreach ($path in $registryPaths) {
        try {
            $exists = Test-Path -LiteralPath $path -ErrorAction Stop
        } catch {
            throw "Khong doc duoc installed-app registry de bao ve ban PrynX co san: $($_.Exception.Message)"
        }
        if ($exists) {
            throw "May/profile nay da co PrynX installed metadata ($path). Dung Windows Sandbox hoac user sach de smoke; verifier khong ghi de ban cai that."
        }
    }

    $installCandidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $installCandidates += (Join-Path $env:LOCALAPPDATA "PrynX")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $installCandidates += (Join-Path $env:ProgramFiles "PrynX")
    }
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $installCandidates += (Join-Path ${env:ProgramFiles(x86)} "PrynX")
    }
    foreach ($directory in ($installCandidates | Select-Object -Unique)) {
        if ((Test-Path -LiteralPath (Join-Path $directory "uninstall.exe") -PathType Leaf) -or
            (Test-Path -LiteralPath (Join-Path $directory "pdf-inspector.exe") -PathType Leaf)) {
            throw "Phat hien cay PrynX da cai tai $directory. Dung Windows Sandbox hoac user sach de smoke."
        }
    }
}

function Remove-SmokeRegistryResidue {
    # Preflight da bat buoc cac key nay khong ton tai; vi vay neu co sau smoke
    # thi chinh installer test vua tao va duoc phep don dung key cu the.
    $paths = @(
        "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\PrynX",
        "Registry::HKEY_CURRENT_USER\Software\prynx\PrynX",
        "Registry::HKEY_CURRENT_USER\Software\Classes\prynx",
        "Registry::HKEY_CURRENT_USER\Software\Classes\PrynX.PDF",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.pdf\shell\pdf-inspector-combine",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.jpg\shell\pdf-inspector-combine",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.jpeg\shell\pdf-inspector-combine",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.png\shell\pdf-inspector-combine",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.jpg\shell\pdf-inspector-convert",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.jpeg\shell\pdf-inspector-convert",
        "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.png\shell\pdf-inspector-convert"
    )
    foreach ($path in $paths) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        }
    }
}

function Assert-InternalPortFree {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 8321)
        $listener.Start()
    } catch {
        throw "Port noi bo 127.0.0.1:8321 dang bi chiem. Verifier tu choi smoke va se khong kill listener co san."
    } finally {
        if ($null -ne $listener) { $listener.Stop() }
    }
}

function Assert-ProcessTrackingAvailable {
    $current = @([PrynXArtifactProcessSnapshot]::Capture() | Where-Object { $_.ProcessId -eq $PID })
    if ($current.Count -ne 1) {
        throw "Khong doc duoc process identity; verifier tu choi launch vi khong the cleanup chinh xac."
    }
}

function Remove-SensitiveArtifactEnvironment {
    # SECURITY (audit 2026-08-03 REL.10): installer/app/sidecar khong duoc ke
    # thua signing key, publisher token hay service credential cua may build.
    $pattern = '(?i)(token|secret|password|private[_-]?key|service[_-]?key|api[_-]?key|access[_-]?key)'
    $environment = [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process)
    foreach ($name in @($environment.Keys)) {
        if ([string]$name -match $pattern) {
            [Environment]::SetEnvironmentVariable([string]$name, $null, [EnvironmentVariableTarget]::Process)
        }
    }

    # SECURITY (audit 2026-08-03 REL.10): some orchestrators can inject both
    # Path and PATH. Windows PowerShell Start-Process rejects that environment
    # before launching the child, so collapse case-only duplicates in-process.
    $remaining = [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process)
    $groups = @{}
    foreach ($name in @($remaining.Keys)) {
        $key = [string]$name
        if (-not $groups.ContainsKey($key)) { $groups[$key] = @() }
        $groups[$key] = @($groups[$key]) + [pscustomobject]@{
            Name = $key
            Value = [string]$remaining[$name]
        }
    }
    foreach ($entries in @($groups.Values)) {
        $entries = @($entries)
        if ($entries.Count -le 1) { continue }
        $preferred = @($entries | Where-Object { $_.Name -ceq "Path" } | Select-Object -First 1)
        if ($preferred.Count -eq 0) { $preferred = @($entries | Sort-Object Name | Select-Object -First 1) }
        foreach ($entry in $entries) {
            [Environment]::SetEnvironmentVariable($entry.Name, $null, [EnvironmentVariableTarget]::Process)
        }
        [Environment]::SetEnvironmentVariable(
            $preferred[0].Name,
            $preferred[0].Value,
            [EnvironmentVariableTarget]::Process
        )
    }
}

function Register-CreatedProcessRoot {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

    $Process.Refresh()
    if ($Process.HasExited) { throw "Process do verifier tao da thoat truoc khi dang ky ownership." }
    $path = try { [string]$Process.Path } catch { "" }
    $record = [pscustomobject]@{
        Id = [int]$Process.Id
        ParentId = 0
        Depth = 0
        CreationTicks = $Process.StartTime.ToUniversalTime().Ticks
        ExecutablePath = $path
        Name = [string]$Process.ProcessName
    }
    $key = [string]$record.Id
    # Chi Start-Process handle moi duoc quyen tao/thay root ownership.
    $script:CreatedRoots[$key] = $record
    $script:TrackedProcesses[$key] = $record
}

function Register-CreatedProcessTree {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)

    $rootKey = [string]$RootProcessId
    $rootRecord = $script:CreatedRoots[$rootKey]
    if ($null -eq $rootRecord) { throw "Process root PID=$RootProcessId chua duoc dang ky ownership." }
    if ($null -eq (Get-TrackedProcessIdentity -Record $rootRecord)) {
        # Root da thoat hoac PID da tai su dung: khong nhan con moi tu PID cu.
        return
    }

    $all = @([PrynXArtifactProcessSnapshot]::Capture())
    $byId = @{}
    $children = @{}
    foreach ($entry in $all) {
        $idKey = [string][int]$entry.ProcessId
        $parentKey = [string][int]$entry.ParentProcessId
        $byId[$idKey] = $entry
        if (-not $children.ContainsKey($parentKey)) { $children[$parentKey] = @() }
        $children[$parentKey] += [int]$entry.ProcessId
    }

    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([pscustomobject]@{ Id = $RootProcessId; Depth = 0 })
    $visited = @{}
    while ($queue.Count -gt 0) {
        $entry = $queue.Dequeue()
        $key = [string][int]$entry.Id
        if ($visited.ContainsKey($key)) { continue }
        $visited[$key] = $true

        $acceptedIdentity = $false
        if ($byId.ContainsKey($key)) {
            $snapshotEntry = $byId[$key]
            try {
                $process = Get-Process -Id ([int]$snapshotEntry.ProcessId) -ErrorAction Stop
                $processPath = try { [string]$process.Path } catch { "" }
                $creationTicks = $process.StartTime.ToUniversalTime().Ticks
                $known = $script:TrackedProcesses[$key]
                if ($null -eq $known) {
                    $script:TrackedProcesses[$key] = [pscustomobject]@{
                        Id = [int]$snapshotEntry.ProcessId
                        ParentId = [int]$snapshotEntry.ParentProcessId
                        Depth = [int]$entry.Depth
                        CreationTicks = $creationTicks
                        ExecutablePath = $processPath
                        Name = [string]$process.ProcessName
                    }
                    $acceptedIdentity = $true
                } elseif ($known.CreationTicks -eq $creationTicks) {
                    $acceptedIdentity = $true
                }
            } catch {
                # Process ngan da thoat giua snapshot va Get-Process; khong con gi de cleanup.
            }
        }
        if ($acceptedIdentity -and $children.ContainsKey($key)) {
            foreach ($childId in $children[$key]) {
                $queue.Enqueue([pscustomobject]@{ Id = $childId; Depth = ([int]$entry.Depth + 1) })
            }
        }
    }
}

function Get-TrackedProcessIdentity {
    param([Parameter(Mandatory = $true)]$Record)

    $current = Get-Process -Id $Record.Id -ErrorAction SilentlyContinue
    if ($null -eq $current) { return $null }
    try { $ticks = $current.StartTime.ToUniversalTime().Ticks } catch { return $null }
    if ($ticks -ne $Record.CreationTicks) { return $null }
    if ($Record.ExecutablePath) {
        try { $currentPath = [string]$current.Path } catch { return $null }
        if ($currentPath -ne $Record.ExecutablePath) { return $null }
    }
    return $current
}

function Stop-CreatedProcessTree {
    if ($null -ne $script:AppProcess) {
        try { Register-CreatedProcessTree -RootProcessId $script:AppProcess.Id } catch {
            Write-Host "  WARNING: Khong cap nhat duoc process tree truoc cleanup: $($_.Exception.Message)" -ForegroundColor Yellow
        }

        try {
            $script:AppProcess.Refresh()
            if (-not $script:AppProcess.HasExited) {
                $null = $script:AppProcess.CloseMainWindow()
                $null = $script:AppProcess.WaitForExit(5000)
            }
        } catch {}
    }

    foreach ($record in @($script:TrackedProcesses.Values | Sort-Object Depth -Descending)) {
        try {
            $createdProcess = Get-TrackedProcessIdentity -Record $record
            if ($null -ne $createdProcess) {
                $createdProcess.Kill()
                $null = $createdProcess.WaitForExit(5000)
            }
        } catch {
            Write-Host "  WARNING: Khong dung duoc process smoke PID=$($record.Id): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

function Get-NewLogText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][long]$Offset
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            $share
        )
        if ($stream.Length -lt $Offset) { $Offset = 0 }
        if ($stream.Length -eq $Offset) { return "" }
        $null = $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin)
        $remaining = [int]($stream.Length - $Offset)
        $bytes = New-Object byte[] $remaining
        $readTotal = 0
        while ($readTotal -lt $remaining) {
            $read = $stream.Read($bytes, $readTotal, $remaining - $readTotal)
            if ($read -le 0) { break }
            $readTotal += $read
        }
        return [System.Text.Encoding]::UTF8.GetString($bytes, 0, $readTotal)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Invoke-TesseractSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Tessdata,
        [Parameter(Mandatory = $true)][string]$ScratchDir
    )

    $imagePath = Join-Path $ScratchDir ".verify-tesseract-input.png"
    $bitmap = $null
    $graphics = $null
    $font = $null
    $brush = $null
    $process = $null
    try {
        # BUILD (audit 2026-08-03 REL.10): load both traineddata files and run
        # real OCR. --list-langs alone only proves filenames are discoverable.
        Add-Type -AssemblyName System.Drawing
        $bitmap = [System.Drawing.Bitmap]::new(1600, 240)
        $bitmap.SetResolution(300, 300)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
        $font = [System.Drawing.Font]::new(
            "Arial",
            64,
            [System.Drawing.FontStyle]::Bold,
            [System.Drawing.GraphicsUnit]::Pixel
        )
        $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::Black)
        $graphics.DrawString("PRYNX OCR 24680", $font, $brush, 70, 65)
        $bitmap.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)

        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $Executable
        $startInfo.Arguments = ('"{0}" stdout --tessdata-dir "{1}" -l eng+vie --psm 7' -f $imagePath, $Tessdata)
        $startInfo.WorkingDirectory = Split-Path -Parent $Executable
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw "Khong khoi dong duoc Tesseract OCR smoke." }
        if (-not $process.WaitForExit(15000)) {
            try { $process.Kill() } catch {}
            try { $null = $process.WaitForExit(5000) } catch {}
            throw "Tesseract smoke vuot 15 giay."
        }
        $ocrText = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd().Trim()
        if ($process.ExitCode -ne 0) {
            throw "Tesseract OCR mau tra ma $($process.ExitCode): $stderr"
        }
        $ocrText = $ocrText.ToUpperInvariant()
        $normalizedOcr = [regex]::Replace($ocrText, '[^A-Z0-9]', '')
        if (-not $normalizedOcr.Contains("PRYNXOCR24680")) {
            throw "Tesseract chay nhung OCR anh mau sai ket qua."
        }
    } finally {
        if ($null -ne $process) {
            try {
                $process.Refresh()
                if (-not $process.HasExited) { $process.Kill() }
            } catch {}
            try { $process.Dispose() } catch {}
        }
        if ($null -ne $brush) { $brush.Dispose() }
        if ($null -ne $font) { $font.Dispose() }
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        Remove-Item -LiteralPath $imagePath -Force -ErrorAction SilentlyContinue
    }
}

function Assert-SidecarAiRuntimeOutput {
    param([Parameter(Mandatory = $true)][string]$StandardOutput)

    $marker = "PRYNX_ARTIFACT_SELF_TEST="
    $hits = @($StandardOutput -split "`r?`n" | Where-Object { $_.StartsWith($marker) })
    if ($hits.Count -ne 1) { throw "Frozen sidecar khong tra dung mot AI self-test marker." }
    try {
        $payload = $hits[0].Substring($marker.Length) | ConvertFrom-Json
    } catch {
        throw "Frozen sidecar AI self-test marker khong phai JSON hop le."
    }
    if ($payload.status -ne "ok") { throw "Frozen sidecar AI self-test khong dat." }
    # BUILD (audit 2026-08-04 BLD.02/TEST.02): chi tin marker khi chinh
    # sidecar da chung minh gate bat va Free bi tu choi mot quyen Pro.
    if ($payload.feature_gate.enabled -ne $true -or
        [string]$payload.feature_gate.free_allowed -ne "pdf.merge" -or
        [string]$payload.feature_gate.free_denied -ne "prepress.preflight") {
        throw "Frozen sidecar khong chung minh duoc gate Free/Pro."
    }
    $providers = @($payload.providers)
    foreach ($requiredProvider in @("CPUExecutionProvider", "DmlExecutionProvider")) {
        if ($providers -notcontains $requiredProvider) {
            throw "Frozen sidecar AI self-test thieu provider bat buoc."
        }
    }
    $modelNames = @($payload.models.PSObject.Properties.Name)
    foreach ($requiredModel in @("isnet", "realesrgan-general", "realesrgan-quality")) {
        if ($modelNames -notcontains $requiredModel) {
            throw "Frozen sidecar AI self-test thieu model bat buoc."
        }
    }
}

function Invoke-SidecarAiRuntimeSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$SidecarPath,
        [int]$TimeoutSeconds = 240
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $SidecarPath
    $startInfo.Arguments = "--artifact-self-test"
    $startInfo.WorkingDirectory = Split-Path -Parent $SidecarPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Khong khoi dong duoc sidecar AI self-test." }
        Register-CreatedProcessRoot -Process $process
        Register-CreatedProcessTree -RootProcessId $process.Id
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Register-CreatedProcessTree -RootProcessId $process.Id
            Stop-CreatedProcessTree
            throw "Sidecar AI self-test vuot $TimeoutSeconds giay."
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $null = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            throw "Frozen sidecar AI self-test tra ma $($process.ExitCode)."
        }
        Assert-SidecarAiRuntimeOutput -StandardOutput $stdout
    } finally {
        try { $process.Dispose() } catch {}
    }
}

function Get-SidecarCachePath {
    param(
        [Parameter(Mandatory = $true)][string]$SidecarPath,
        [Parameter(Mandatory = $true)][string]$CacheBase
    )

    $versionInfo = (Get-Item -LiteralPath $SidecarPath).VersionInfo
    $fileVersion = [string]$versionInfo.FileVersion
    $productVersion = [string]$versionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($fileVersion) -or [string]::IsNullOrWhiteSpace($productVersion)) {
        throw "Sidecar phai co FileVersion va ProductVersion de xac dinh cache Nuitka."
    }
    $cacheParent = Join-Path $CacheBase "PrynX"
    # Nuitka {VERSION}: neu hai version bang nhau thi chi dung mot; neu lech moi ghep.
    $fileVersion = $fileVersion.Trim()
    $productVersion = $productVersion.Trim()
    $effectiveVersion = if ($productVersion -eq $fileVersion) {
        $fileVersion
    } else {
        $productVersion + "-" + $fileVersion
    }
    $cachePath = Join-Path $cacheParent ("sidecar-" + $effectiveVersion)
    $resolvedParent = [System.IO.Path]::GetFullPath($cacheParent).TrimEnd('\')
    $resolvedCache = [System.IO.Path]::GetFullPath($cachePath)
    if (-not $resolvedCache.StartsWith($resolvedParent + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Cache Nuitka escaped LocalApplicationData: $resolvedCache"
    }
    return $resolvedCache
}

function Quarantine-NuitkaCache {
    param([Parameter(Mandatory = $true)][string]$CachePath)

    $script:NuitkaCacheTarget = $CachePath
    $script:NuitkaCacheBackup = $null
    if (Test-Path -LiteralPath $CachePath) {
        $backup = $CachePath + ".verify-backup-" + [guid]::NewGuid().ToString("N")
        Move-Item -LiteralPath $CachePath -Destination $backup -ErrorAction Stop
        if ((Test-Path -LiteralPath $CachePath) -or -not (Test-Path -LiteralPath $backup)) {
            throw "Khong quarantine duoc cache Nuitka cu."
        }
        $script:NuitkaCacheBackup = $backup
    }
}

function Restore-NuitkaCache {
    if ([string]::IsNullOrWhiteSpace($script:NuitkaCacheTarget)) { return }

    $target = $script:NuitkaCacheTarget
    $backup = $script:NuitkaCacheBackup
    $createdQuarantine = $null
    if (Test-Path -LiteralPath $target) {
        try {
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
        } catch {
            # Uu tien tra cache cu ve dung cho: doi ten cay moi truoc, roi restore cu.
            $createdQuarantine = $target + ".verify-created-" + [guid]::NewGuid().ToString("N")
            Move-Item -LiteralPath $target -Destination $createdQuarantine -ErrorAction Stop
        }
    }
    if ($backup) {
        if (Test-Path -LiteralPath $target) { throw "Khong the restore cache Nuitka cu vi dich van ton tai." }
        Move-Item -LiteralPath $backup -Destination $target -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $target)) { throw "Restore cache Nuitka cu that bai." }
    }
    if ($createdQuarantine -and (Test-Path -LiteralPath $createdQuarantine)) {
        Remove-Item -LiteralPath $createdQuarantine -Recurse -Force -ErrorAction Stop
    }
    $script:NuitkaCacheTarget = $null
    $script:NuitkaCacheBackup = $null
}

function Reset-TestNuitkaCache {
    if ([string]::IsNullOrWhiteSpace($script:NuitkaCacheTarget)) {
        throw "Cache Nuitka chua duoc quarantine."
    }
    if (Test-Path -LiteralPath $script:NuitkaCacheTarget) {
        Remove-Item -LiteralPath $script:NuitkaCacheTarget -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $script:NuitkaCacheTarget) {
        throw "Khong xoa sach duoc cache Nuitka cua self-test."
    }
}

# -- 1. Xac dinh artifact -----------------------------------------------------
if (-not $Installer) {
    $candidate = Get-ChildItem -LiteralPath $PUBLISH_DIR -Filter "*-setup.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) { throw "Khong tim thay installer trong $PUBLISH_DIR. Truyen -Installer." }
    $Installer = $candidate.FullName
}
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "Khong thay installer: $Installer" }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
if (-not $Manifest) { $Manifest = Join-Path (Split-Path -Parent $Installer) "release-manifest.txt" }
if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { throw "Khong thay manifest: $Manifest" }
$Manifest = (Resolve-Path -LiteralPath $Manifest).Path

if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    $ExpectedVersion = Get-ManifestField -Path $Manifest -Name "APP_VERSION"
}
$ExpectedVersion = $ExpectedVersion.Trim()
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$') {
    throw "ExpectedVersion khong phai SemVer hop le: $ExpectedVersion"
}

$manifestVersion = Get-ManifestField -Path $Manifest -Name "APP_VERSION"
if ($manifestVersion -ne $ExpectedVersion) {
    throw "Manifest APP_VERSION=$manifestVersion, khac version can kiem $ExpectedVersion."
}
Assert-BuildManifestAttestation -Path $Manifest
$installerLeaf = Split-Path -Leaf $Installer
$manifestInstaller = Get-ManifestField -Path $Manifest -Name "INSTALLER"
if ($manifestInstaller -ne $installerLeaf) {
    throw "Manifest INSTALLER=$manifestInstaller, khac artifact $installerLeaf."
}
$versionToken = "_" + $ExpectedVersion + "_"
if ($installerLeaf.IndexOf($versionToken, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Ten installer khong chua dung version ${ExpectedVersion}: $installerLeaf"
}

Write-Step "1/5 Artifact"
Write-Host "  Installer: $Installer" -ForegroundColor DarkGray
Write-Host "  Manifest : $Manifest" -ForegroundColor DarkGray
$installerHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
$declaredInstallerHash = Get-ManifestField -Path $Manifest -Name "INSTALLER_SHA256"
if ($declaredInstallerHash.ToLowerInvariant() -ne $installerHash) {
    throw "Manifest INSTALLER_SHA256 khac hash thuc te. Manifest khong thuoc artifact nay."
}
Write-OK "Version va SHA-256 installer khop manifest"

# Installer hook co the kill theo ten, nen gate nay phai chay TRUOC installer.
Assert-NoExistingPrynXProcess
Assert-NoExistingPrynXInstall
Assert-InternalPortFree
Assert-ProcessTrackingAvailable
Remove-SensitiveArtifactEnvironment
Write-OK "Khong co PrynX process va port 8321 dang trong"

# -- 2. Cai silent vao Temp ---------------------------------------------------
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$installDir = Join-Path $tempRoot ("PrynXVerify-" + [guid]::NewGuid().ToString("N"))
if (-not ([System.IO.Path]::GetFullPath($installDir)).StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Duong dan cai kiem thu escaped Temp: $installDir"
}

Write-Step "2/5 Cai silent"
Write-Host "  Dich: $installDir" -ForegroundColor DarkGray
try {
    $installerProcess = Start-Process -FilePath $Installer -ArgumentList "/S", "/D=$installDir" -WindowStyle Hidden -PassThru
    Register-CreatedProcessRoot -Process $installerProcess
    Register-CreatedProcessTree -RootProcessId $installerProcess.Id
    $installerDeadline = [DateTime]::UtcNow.AddSeconds(180)
    while (-not $installerProcess.WaitForExit(250)) {
        Register-CreatedProcessTree -RootProcessId $installerProcess.Id
        if ([DateTime]::UtcNow -ge $installerDeadline) {
            try { $installerProcess.Kill() } catch {}
            throw "Installer silent vuot 180 giay."
        }
    }
    if ($installerProcess.ExitCode -ne 0) { throw "Installer tra ma loi $($installerProcess.ExitCode)" }
    Write-OK "Installer tra ma 0"

    # -- 3. Kiem payload ------------------------------------------------------
    Write-Step "3/5 Kiem payload da cai"
    $cargoToml = Join-Path $ROOT "desktop\src-tauri\Cargo.toml"
    $mainBinary = $null
    if (Test-Path -LiteralPath $cargoToml) {
        $match = Select-String -LiteralPath $cargoToml -Pattern '^\s*name\s*=\s*"([^"]+)"' | Select-Object -First 1
        if ($match) { $mainBinary = $match.Matches.Groups[1].Value + ".exe" }
    }
    $candidateNames = @()
    if ($mainBinary) { $candidateNames += $mainBinary }
    $candidateNames += "PrynX.exe"
    $appMatches = @()
    foreach ($name in ($candidateNames | Select-Object -Unique)) {
        $appMatches += @(Get-ChildItem -LiteralPath $installDir -Filter $name -File -Recurse -ErrorAction SilentlyContinue)
    }
    $appMatches = @($appMatches | Sort-Object FullName -Unique)
    if ($appMatches.Count -ne 1) {
        throw "Can dung mot main binary ($($candidateNames -join ', ')); tim thay $($appMatches.Count) trong $installDir."
    }
    $appExe = $appMatches[0]
    $installedVersions = @($appExe.VersionInfo.ProductVersion, $appExe.VersionInfo.FileVersion) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
    if ($installedVersions -notcontains $ExpectedVersion) {
        throw "Binary da cai co version [$($installedVersions -join ', ')], khac $ExpectedVersion."
    }
    $installedHash = (Get-FileHash -LiteralPath $appExe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-OK "App $ExpectedVersion va SHA-256 binary da cai"

    $sidecarPath = Join-Path $appExe.Directory.FullName "pdf-inspector-backend.exe"
    if (-not (Test-Path -LiteralPath $sidecarPath -PathType Leaf)) { throw "Thieu sidecar da cai: $sidecarPath" }
    $sidecarHash = (Get-FileHash -LiteralPath $sidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $declaredSidecarHash = Get-ManifestField -Path $Manifest -Name "SIDECAR_SHA256"
    if ($sidecarHash -ne $declaredSidecarHash.ToLowerInvariant()) {
        throw "Sidecar da cai khong khop SIDECAR_SHA256 trong manifest."
    }
    Write-OK "Sidecar da cai khop manifest"

    $pdfiumPath = @(
        (Join-Path $appExe.Directory.FullName "bin\pdfium.dll"),
        (Join-Path $appExe.Directory.FullName "pdfium.dll")
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $pdfiumPath -or (Get-Item -LiteralPath $pdfiumPath).Length -le 0) {
        throw "Thieu payload pdfium.dll."
    }
    Write-OK "Co payload PDFium"

    $tesseractRoot = @(
        (Join-Path $appExe.Directory.FullName "binaries\tesseract"),
        (Join-Path $appExe.Directory.FullName "tesseract")
    ) | Where-Object { Test-Path -LiteralPath (Join-Path $_ "tesseract.exe") -PathType Leaf } | Select-Object -First 1
    if (-not $tesseractRoot) { throw "Thieu payload Tesseract." }
    $tesseractPath = Join-Path $tesseractRoot "tesseract.exe"
    $tessdataPath = Join-Path $tesseractRoot "tessdata"
    foreach ($requiredPath in @(
        $tesseractPath,
        (Join-Path $tessdataPath "eng.traineddata"),
        (Join-Path $tessdataPath "vie.traineddata")
    )) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf) -or (Get-Item -LiteralPath $requiredPath).Length -le 0) {
            throw "Thieu payload OCR: $requiredPath"
        }
    }
    Invoke-TesseractSmoke -Executable $tesseractPath -Tessdata $tessdataPath -ScratchDir $installDir
    Write-OK "Tesseract OCR anh mau bang eng+vie"

    if ($ExpectNoGhostscript) {
        $gsBinaries = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^gswin(32|64)c?\.exe$' -or $_.Name -match '^gsdll\d*\.dll$' })
        if ($gsBinaries.Count -gt 0) {
            throw "Payload van co Ghostscript: $((($gsBinaries | Select-Object -First 5).Name) -join ', ')"
        }
        $noticeHits = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter "*NOTICE*" -ErrorAction SilentlyContinue |
            Select-String -Pattern "Ghostscript|Artifex|AGPL" -List)
        if ($noticeHits.Count -gt 0) { throw "NOTICE van nhac Ghostscript/Artifex/AGPL." }
        $marker = Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter "NO_GHOSTSCRIPT.txt" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $marker) { throw "Thieu marker binaries\gs\NO_GHOSTSCRIPT.txt." }
        Write-OK "Payload dat hop dong no-Ghostscript"
    }

    # -- 4. Runtime smoke -----------------------------------------------------
    Write-Step "4/5 Runtime smoke"
    Assert-NoExistingPrynXProcess
    Assert-InternalPortFree
    # APPDATA/TEMP rieng nam trong cay test de tach log/backend state va file tam.
    # Windows KnownFolder cua Tauri/WebView2 van la profile dang dang nhap; runtime
    # smoke nay khong co quyen sua invariant do neu khong doi code app.
    $smokeProfile = Join-Path $installDir ".runtime-profile"
    $smokeAppData = Join-Path $smokeProfile "AppData\Roaming"
    $smokeLocalAppData = Join-Path $smokeProfile "AppData\Local"
    $smokeTemp = Join-Path $smokeProfile "Temp"
    foreach ($directory in @($smokeAppData, $smokeLocalAppData, $smokeTemp)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    $nuitkaCacheBase = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrWhiteSpace($nuitkaCacheBase)) {
        throw "Khong xac dinh duoc Windows LocalApplicationData cho cache Nuitka."
    }
    $cacheDir = Get-SidecarCachePath -SidecarPath $sidecarPath -CacheBase $nuitkaCacheBase
    # Cache theo version duoc quarantine/restore de file du tu build cu khong the
    # lam payload thieu cua artifact moi vuot smoke.
    Quarantine-NuitkaCache -CachePath $cacheDir

    # BUILD (audit 2026-08-03 REL.10): chay import/session/inference bang chinh
    # frozen sidecar tren cache sach. Xoa cache vua tao de app launch tiep theo
    # cung phai tu giai nen artifact cua lan test nay.
    $selfTestPreviousAppData = $env:APPDATA
    $selfTestPreviousLocalAppData = $env:LOCALAPPDATA
    $selfTestPreviousTemp = $env:TEMP
    $selfTestPreviousTmp = $env:TMP
    try {
        $env:APPDATA = $smokeAppData
        $env:LOCALAPPDATA = $smokeLocalAppData
        $env:TEMP = $smokeTemp
        $env:TMP = $smokeTemp
        Invoke-SidecarAiRuntimeSmoke -SidecarPath $sidecarPath
    } finally {
        $env:APPDATA = $selfTestPreviousAppData
        $env:LOCALAPPDATA = $selfTestPreviousLocalAppData
        $env:TEMP = $selfTestPreviousTemp
        $env:TMP = $selfTestPreviousTmp
    }
    Write-OK "Frozen sidecar gate Free/Pro + import ONNX + inference 3 model"
    Reset-TestNuitkaCache

    Assert-NoExistingPrynXProcess
    Assert-InternalPortFree
    $startupLog = Join-Path $smokeAppData "PrynX\logs\startup_debug.log"
    $startupOffset = 0
    $launchStartedAtUtc = [DateTime]::UtcNow
    $previousAppData = $env:APPDATA
    $previousLocalAppData = $env:LOCALAPPDATA
    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    try {
        $env:APPDATA = $smokeAppData
        $env:LOCALAPPDATA = $smokeLocalAppData
        $env:TEMP = $smokeTemp
        $env:TMP = $smokeTemp
        $script:AppProcess = Start-Process -FilePath $appExe.FullName -WorkingDirectory $appExe.Directory.FullName `
            -WindowStyle Hidden -PassThru
    } finally {
        $env:APPDATA = $previousAppData
        $env:LOCALAPPDATA = $previousLocalAppData
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
    }
    Register-CreatedProcessRoot -Process $script:AppProcess
    Register-CreatedProcessTree -RootProcessId $script:AppProcess.Id

    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $newStartupText = ""
    while ([DateTime]::UtcNow -lt $deadline) {
        $script:AppProcess.Refresh()
        if ($script:AppProcess.HasExited) {
            throw "App thoat som voi ma $($script:AppProcess.ExitCode) truoc khi san sang."
        }
        Register-CreatedProcessTree -RootProcessId $script:AppProcess.Id
        $newStartupText = Get-NewLogText -Path $startupLog -Offset $startupOffset
        if ($newStartupText -match '(?m)pdfium: FAIL|sidecar integrity: FAIL|sidecar startup proof: FAIL|frontend integrity: FAIL') {
            throw "Startup breadcrumb ghi nhan loi runtime: $($Matches[0])"
        }
        $ready = $newStartupText -match '(?m)pdfium: OK' -and
            $newStartupText -match '(?m)sidecar integrity: OK' -and
            $newStartupText -match '(?m)sidecar: spawned on :8321 \(token via stdin\)' -and
            $newStartupText -match '(?m)setup complete.*app ready'
        if ($ready) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw "Khong nhan du breadcrumb moi PDFium/sidecar/app-ready trong $StartupTimeoutSeconds giay."
    }
    $script:AppProcess.Refresh()
    if ($script:AppProcess.HasExited) { throw "App thoat ngay sau breadcrumb ready." }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8321/health" -Method Get -TimeoutSec 3
    if ([string]$health.status -ne "ok" -or [string]::IsNullOrWhiteSpace([string]$health.app)) {
        throw "Sidecar /health khong tra status=ok va app hop le."
    }
    Write-OK "PDFium OK; sidecar integrity + startup proof OK; app ready va song"

    if (-not (Test-Path -LiteralPath $cacheDir -PathType Container)) {
        throw "Sidecar san sang nhung khong tao cache payload Nuitka moi: $cacheDir"
    }
    $cacheFiles = @(Get-ChildItem -LiteralPath $cacheDir -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($runtimeName in @("onnxruntime.dll", "onnxruntime_pybind11_state.pyd")) {
        $runtimeFile = $cacheFiles | Where-Object { $_.Name -eq $runtimeName } | Select-Object -First 1
        if (-not $runtimeFile -or $runtimeFile.Length -le 0) {
            throw "Payload Nuitka da giai nen thieu ONNX Runtime file: $runtimeName"
        }
    }
    $requiredModels = @{
        "isnet-general-use.onnx" = "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"
        "realesr-general-x4v3.onnx" = "3ae50bb3a9131697d62ac79f934e57c2ef9cd3b8762993ca0d1fabd8a36a343f"
        "realesrgan-x4plus.onnx" = "c1b85fae35947577b4c4b7d310af54546c6e7971f14a0862a769e83689ddc003"
    }
    foreach ($modelName in $requiredModels.Keys) {
        $model = $cacheFiles | Where-Object { $_.Name -eq $modelName } | Select-Object -First 1
        if (-not $model) { throw "Payload Nuitka da giai nen thieu model: $modelName" }
        $modelHash = (Get-FileHash -LiteralPath $model.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($modelHash -ne $requiredModels[$modelName]) {
            throw "Model $modelName khong khop SHA-256 da audit."
        }
    }
    $onnxProvider = if ($cacheFiles | Where-Object { $_.Name -eq "DirectML.dll" } | Select-Object -First 1) {
        "directml+cpu"
    } else { "cpu" }
    $script:AppProcess.Refresh()
    if ($script:AppProcess.HasExited) { throw "App thoat trong khi xac minh payload AI." }
    $healthAfterPayload = Invoke-RestMethod -Uri "http://127.0.0.1:8321/health" -Method Get -TimeoutSec 3
    if ([string]$healthAfterPayload.status -ne "ok") { throw "Sidecar mat health sau khi xac minh payload AI." }
    Write-OK "Payload ONNX Runtime + ISNet + hai model Real-ESRGAN ($onnxProvider)"

    # -- 5. Cap nhat manifest -------------------------------------------------
    Write-Step "5/5 Cap nhat manifest"
    $verifiedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
    $manifestLines = @(Get-Content -LiteralPath $Manifest)
    foreach ($field in @(
        @{ Name = "EXE_SHA256"; Value = $installedHash },
        @{ Name = "INSTALL_VERIFIED_AT_UTC"; Value = $verifiedAt },
        @{ Name = "RUNTIME_VERIFIED"; Value = "yes" },
        @{ Name = "RUNTIME_PDFIUM"; Value = "ok" },
        @{ Name = "RUNTIME_SIDECAR"; Value = "integrity+startup-proof+health-ok" },
        @{ Name = "RUNTIME_APP_READY"; Value = "ok" },
        @{ Name = "RUNTIME_OCR"; Value = "tesseract-eng-vie-sample-ok" },
        @{ Name = "RUNTIME_ONNX_PAYLOAD"; Value = "models-ok-$onnxProvider" },
        @{ Name = "RUNTIME_ONNX_INFERENCE"; Value = "frozen-sidecar-3-models-ok" },
        @{ Name = "RUNTIME_FREE_PRO_GATE"; Value = "enabled+free-denied-prepress.preflight" }
    )) {
        $manifestLines = @(Set-ManifestField -Lines $manifestLines -Name $field.Name -Value $field.Value)
    }
    Set-Content -LiteralPath $Manifest -Value $manifestLines -Encoding ASCII
    if ((Get-ManifestField -Path $Manifest -Name "RUNTIME_VERIFIED") -ne "yes") {
        throw "Khong ghi duoc trang thai RUNTIME_VERIFIED=yes."
    }
    Write-OK "Manifest da co hash installed exe va runtime evidence"
    $script:VerificationSucceeded = $true
} finally {
    $cleanupFailures = New-Object System.Collections.Generic.List[string]
    try { Stop-CreatedProcessTree } catch { $cleanupFailures.Add("Process cleanup: $($_.Exception.Message)") }
    foreach ($record in @($script:TrackedProcesses.Values)) {
        if ($null -ne (Get-TrackedProcessIdentity -Record $record)) {
            $cleanupFailures.Add("Process do verifier tao van song: PID=$($record.Id)")
        }
    }
    try { Assert-InternalPortFree } catch { $cleanupFailures.Add($_.Exception.Message) }
    try { Restore-NuitkaCache } catch { $cleanupFailures.Add("Nuitka cache restore: $($_.Exception.Message)") }
    if ($KeepInstall) {
        Write-Host "`n  Giu lai cay da cai: $installDir" -ForegroundColor Yellow
    } else {
        $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter "uninstall.exe" -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($uninstaller) {
            try {
                $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -WindowStyle Hidden -PassThru
                Register-CreatedProcessRoot -Process $uninstallProcess
                Register-CreatedProcessTree -RootProcessId $uninstallProcess.Id
                $uninstallDeadline = [DateTime]::UtcNow.AddSeconds(60)
                $uninstallTimedOut = $false
                while (-not $uninstallProcess.WaitForExit(250)) {
                    try { Register-CreatedProcessTree -RootProcessId $uninstallProcess.Id } catch {}
                    if ([DateTime]::UtcNow -ge $uninstallDeadline) {
                        try { $uninstallProcess.Kill() } catch {}
                        $uninstallTimedOut = $true
                        break
                    }
                }
                if ($uninstallTimedOut) {
                    $cleanupFailures.Add("Uninstaller silent vuot 60 giay.")
                } elseif ($uninstallProcess.ExitCode -ne 0) {
                    $cleanupFailures.Add("Uninstaller tra ma $($uninstallProcess.ExitCode).")
                }
            } catch {
                $cleanupFailures.Add("Uninstaller cleanup: $($_.Exception.Message)")
            }
            try { Stop-CreatedProcessTree } catch { $cleanupFailures.Add("Uninstaller process cleanup: $($_.Exception.Message)") }
        }
        if (Test-Path -LiteralPath $installDir) {
            $resolvedInstall = [System.IO.Path]::GetFullPath($installDir)
            if (-not $resolvedInstall.StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
                $cleanupFailures.Add("Tu choi cleanup ngoai Temp: $resolvedInstall")
            } else {
                # BUILD (audit 2026-08-03 REL.CLEANUSER): NSIS uninstaller co the
                # tra ve ngay truoc khi thread cleanup cuoi cung ket thuc. Khi file
                # bien mat giua luc Remove-Item enumerate va xoa, PowerShell nem
                # FileNotFound du cay dang duoc don dung. Thu lai co gioi han; moi
                # lan van chi xoa dung cay Temp da canonicalize o tren.
                $removeError = $null
                for ($attempt = 1; $attempt -le 5; $attempt++) {
                    if (-not (Test-Path -LiteralPath $resolvedInstall)) {
                        $removeError = $null
                        break
                    }
                    try {
                        Remove-Item -LiteralPath $resolvedInstall -Recurse -Force -ErrorAction Stop
                        $removeError = $null
                        break
                    } catch {
                        $removeError = $_.Exception.Message
                        if ($attempt -lt 5) { Start-Sleep -Milliseconds 250 }
                    }
                }
                if ($null -ne $removeError -and (Test-Path -LiteralPath $resolvedInstall)) {
                    $cleanupFailures.Add("Khong xoa duoc cay cai Temp sau 5 lan: $removeError")
                }
            }
        }
        if (Test-Path -LiteralPath $installDir) { $cleanupFailures.Add("Cay cai Temp van ton tai: $installDir") }
        try { Remove-SmokeRegistryResidue } catch { $cleanupFailures.Add("Registry residue cleanup: $($_.Exception.Message)") }
        try { Assert-NoExistingPrynXInstall } catch { $cleanupFailures.Add("Registry/install cleanup: $($_.Exception.Message)") }
    }
    if ($cleanupFailures.Count -gt 0) {
        foreach ($failure in $cleanupFailures) { Write-Bad $failure }
        if ($script:VerificationSucceeded) {
            try {
                $failedManifest = @(Get-Content -LiteralPath $Manifest)
                $failedManifest = @(Set-ManifestField -Lines $failedManifest -Name "RUNTIME_VERIFIED" -Value "no-cleanup-failed")
                Set-Content -LiteralPath $Manifest -Value $failedManifest -Encoding ASCII
            } catch {}
            throw "Artifact runtime dat nhung cleanup an toan that bai; KHONG danh dau gate thanh cong."
        }
    }
}

Write-Host ""
Write-Host "KET LUAN: artifact dat kiem sau cai va runtime smoke." -ForegroundColor Green
exit 0
