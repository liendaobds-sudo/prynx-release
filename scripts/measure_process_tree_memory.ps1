[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$StopWhenProcessIdExits,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Output,
    [ValidateRange(10, 5000)][int]$IntervalMs = 25
)

$ErrorActionPreference = "Stop"
$MIB = 1MB

# PERF (audit 2026-08-14 §VIEW.LARGE.3): lấy quan hệ cha/con bằng Toolhelp32 vì CIM/WMI
# có thể bị policy máy chặn. RSS/private được cộng tại cùng một mẫu; không cộng peak lịch sử
# riêng của từng process vì các peak đó có thể xảy ra ở thời điểm khác nhau.
if ($null -eq ("PrynXViewerProcessSnapshot" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PrynXViewerProcessSnapshot
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
            throw new InvalidOperationException(
                "CreateToolhelp32Snapshot failed: " + Marshal.GetLastWin32Error());

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

function Get-ProcessTreeIds {
    param([Parameter(Mandatory = $true)][int]$RootId)

    $children = @{}
    foreach ($entry in [PrynXViewerProcessSnapshot]::Capture()) {
        $parentKey = [string][int]$entry.ParentProcessId
        if (-not $children.ContainsKey($parentKey)) { $children[$parentKey] = @() }
        $children[$parentKey] += [int]$entry.ProcessId
    }

    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootId)
    $visited = @{}
    while ($queue.Count -gt 0) {
        $id = [int]$queue.Dequeue()
        $key = [string]$id
        if ($visited.ContainsKey($key)) { continue }
        $visited[$key] = $true
        if ($children.ContainsKey($key)) {
            foreach ($child in $children[$key]) { $queue.Enqueue([int]$child) }
        }
    }
    return @($visited.Keys | ForEach-Object { [int]$_ })
}

$root = Get-Process -Id $RootProcessId -ErrorAction Stop
$rootStartTicks = $root.StartTime.ToUniversalTime().Ticks
$stopProcess = Get-Process -Id $StopWhenProcessIdExits -ErrorAction Stop
$stopProcessStartTicks = $stopProcess.StartTime.ToUniversalTime().Ticks
$startedAt = [DateTimeOffset]::Now
$sampleCount = 0
$failedProcessReads = 0
$peakWorkingSetBytes = [int64]0
$peakPrivateBytes = [int64]0
$peakProcessCount = 0
$peakSample = $null

try {
    while ($true) {
        $currentStopProcess = Get-Process -Id $StopWhenProcessIdExits -ErrorAction SilentlyContinue
        if ($null -eq $currentStopProcess) { break }
        try {
            if ($currentStopProcess.StartTime.ToUniversalTime().Ticks -ne $stopProcessStartTicks) {
                break
            }
        } catch { break }
        $currentRoot = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
        if ($null -eq $currentRoot) { break }
        try {
            if ($currentRoot.StartTime.ToUniversalTime().Ticks -ne $rootStartTicks) {
                throw "PID root đã được tái sử dụng trong lúc đo."
            }
        } catch { throw }

        $workingSet = [int64]0
        $privateBytes = [int64]0
        $processCount = 0
        $ids = @(Get-ProcessTreeIds -RootId $RootProcessId)
        foreach ($id in $ids) {
            try {
                $process = Get-Process -Id $id -ErrorAction Stop
                $workingSet += [int64]$process.WorkingSet64
                $privateBytes += [int64]$process.PrivateMemorySize64
                $processCount += 1
            } catch {
                $failedProcessReads += 1
            }
        }

        $sampleCount += 1
        if ($workingSet -gt $peakWorkingSetBytes) {
            $peakWorkingSetBytes = $workingSet
            $peakSample = [ordered]@{
                capturedAt = [DateTimeOffset]::Now.ToString("o")
                workingSetBytes = $workingSet
                privateBytes = $privateBytes
                processCount = $processCount
            }
        }
        if ($privateBytes -gt $peakPrivateBytes) { $peakPrivateBytes = $privateBytes }
        if ($processCount -gt $peakProcessCount) { $peakProcessCount = $processCount }
        Start-Sleep -Milliseconds $IntervalMs
    }
} finally {
    $endedAt = [DateTimeOffset]::Now
    $report = [ordered]@{
        schemaVersion = 1
        scope = "whole-application-process-tree-same-instant-sampling"
        rootProcessId = $RootProcessId
        rootStartTicksUtc = $rootStartTicks
        stopWhenProcessIdExits = $StopWhenProcessIdExits
        stopProcessStartTicksUtc = $stopProcessStartTicks
        intervalMs = $IntervalMs
        startedAt = $startedAt.ToString("o")
        endedAt = $endedAt.ToString("o")
        durationMs = [math]::Round(($endedAt - $startedAt).TotalMilliseconds)
        sampleCount = $sampleCount
        failedProcessReads = $failedProcessReads
        peakWorkingSetBytes = $peakWorkingSetBytes
        peakWorkingSetMiB = [math]::Round($peakWorkingSetBytes / $MIB, 3)
        peakPrivateBytes = $peakPrivateBytes
        peakPrivateMiB = [math]::Round($peakPrivateBytes / $MIB, 3)
        peakProcessCount = $peakProcessCount
        peakWorkingSetSample = $peakSample
        complete = $sampleCount -gt 0
    }
    $absoluteOutput = [System.IO.Path]::GetFullPath($Output)
    $directory = [System.IO.Path]::GetDirectoryName($absoluteOutput)
    if ($directory) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }
    $temporary = "$absoluteOutput.$PID.$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()).tmp"
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $absoluteOutput -Force
}
