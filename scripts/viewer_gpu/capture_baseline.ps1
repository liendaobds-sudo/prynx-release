#Requires -Version 5.1
<#
.SYNOPSIS
    Thu thập thông số phần cứng, định danh nhị phân và kiểm tra fixture PDF cho benchmark Viewer GPU.
.DESCRIPTION
    Script thực hiện kiểm chứng mỏ neo R01 (hoặc fixture khác), băm SHA-256, đối chiếu với fixtures.json,
    thu thập cấu hình phần cứng (CPU, GPU, RAM, OS, màn hình) và xuất manifest có provenance đầy đủ.
    Không đóng PrynX đang chạy, không sửa file người dùng.
.PARAMETER FixtureId
    Mã định danh fixture trong fixtures.json (mặc định: 'R01').
.PARAMETER PdfPath
    Đường dẫn tường minh tới file PDF cần kiểm tra (nếu không cung cấp sẽ tìm theo standard_locations).
.PARAMETER OutputDir
    Thư mục lưu kết quả (mặc định: .tmp/viewer-gpu/runs/<timestamp>).
.PARAMETER SnapshotFile
    Đường dẫn tới file snapshot log của trace (nếu có).
#>
[CmdletBinding()]
param(
    [string]$FixtureId = "R01",
    [string]$PdfPath = "",
    [string]$OutputDir = "",
    [string]$SnapshotFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = (Resolve-Path "$scriptDir\..\..").Path
$fixturesJsonPath = Join-Path $rootDir "tests\viewer_gpu\fixtures.json"

if (-not (Test-Path $fixturesJsonPath)) {
    Write-Error "Không tìm thấy file fixtures: $fixturesJsonPath"
    exit 1
}

$fixturesConfig = Get-Content $fixturesJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$fixture = $fixturesConfig.fixtures | Where-Object { $_.id -eq $FixtureId }
if (-not $fixture) {
    Write-Error "Không tìm thấy FixtureId '$FixtureId' trong $fixturesJsonPath"
    exit 1
}

# 1. Xác định file PDF
$targetPdfPath = $PdfPath
if ([string]::IsNullOrWhiteSpace($targetPdfPath)) {
    foreach ($loc in $fixture.standard_locations) {
        if (Test-Path $loc) {
            $targetPdfPath = $loc
            break
        }
    }
}

if ([string]::IsNullOrWhiteSpace($targetPdfPath) -or -not (Test-Path $targetPdfPath)) {
    Write-Error "Không tìm thấy file PDF cho fixture '$FixtureId'. Hãy chỉ định -PdfPath."
    exit 1
}

$targetPdfPath = (Resolve-Path $targetPdfPath).Path

# 2. Băm SHA-256 và kiểm tra tính toàn vẹn (Fail-closed)
$pdfHashObj = Get-FileHash -Path $targetPdfPath -Algorithm SHA256
$actualPdfHash = $pdfHashObj.Hash.ToLowerInvariant()
$actualPdfSize = (Get-Item $targetPdfPath).Length

if ($actualPdfHash -ne $fixture.expected_sha256.ToLowerInvariant()) {
    Write-Error @"
LỖI SAI FIXTURE: File PDF không khớp SHA-256 đã đăng ký!
  Đường dẫn : $targetPdfPath
  Kỳ vọng   : $($fixture.expected_sha256)
  Thực tế   : $actualPdfHash
Runner dừng ngay để tránh làm sai lệch kết quả benchmark.
"@
    exit 1
}

# 3. Thu thập thông tin phần cứng & hệ điều hành
$osInfo = Get-CimInstance Win32_OperatingSystem
$cpuInfo = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM, VideoProcessor)

$totalRamBytes = [int64]$osInfo.TotalVisibleMemorySize * 1024
$totalRamGb = [math]::Round($totalRamBytes / 1GB, 2)
$freeRamBytes = [int64]$osInfo.FreePhysicalMemory * 1024
$freeRamGb = [math]::Round($freeRamBytes / 1GB, 2)

$ramTier = if ($totalRamGb -lt 8.0) { "<8GB" } elseif ($totalRamGb -lt 16.0) { "8-<16GB" } else { ">=16GB" }

# Lấy thông số độ phân giải màn hình chính
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$primaryScreen = [System.Windows.Forms.Screen]::PrimaryScreen
$screenWidth = if ($primaryScreen) { $primaryScreen.Bounds.Width } else { 0 }
$screenHeight = if ($primaryScreen) { $primaryScreen.Bounds.Height } else { 0 }

# 4. Thu thập thông tin Git và Binary Provenance
$gitCommit = ""
$gitBranch = ""
$gitDirty = $false
try {
    $gitCommit = (git rev-parse HEAD).Trim()
    $gitBranch = (git rev-parse --abbrev-ref HEAD).Trim()
    $gitStatusShort = (git status -s)
    $gitDirty = [bool]$gitStatusShort
} catch {
    $gitCommit = "unknown"
}

$exePath = Join-Path $rootDir "desktop\src-tauri\target\debug\pdf-inspector.exe"
$exeProvenance = $null
if (Test-Path $exePath) {
    $exeHash = (Get-FileHash $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $exeItem = Get-Item $exePath
    $exeProvenance = @{
        path = $exePath
        sha256 = $exeHash
        size_bytes = $exeItem.Length
        last_modified = $exeItem.LastWriteTimeUtc.ToString("o")
    }
}

$pdfiumDllPath = Join-Path $rootDir "desktop\src-tauri\bin\pdfium.dll"
$pdfiumProvenance = $null
if (Test-Path $pdfiumDllPath) {
    $pdfiumHash = (Get-FileHash $pdfiumDllPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $pdfiumProvenance = @{
        path = $pdfiumDllPath
        sha256 = $pdfiumHash
        size_bytes = (Get-Item $pdfiumDllPath).Length
    }
}

# 5. Tạo thư mục đầu ra
$runId = if (-not [string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir
} else {
    $timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    Join-Path $rootDir ".tmp\viewer-gpu\runs\$timestamp"
}

if (-not (Test-Path $runId)) {
    New-Item -ItemType Directory -Path $runId -Force | Out-Null
}

$hardwarePayload = @{
    schema_version = 1
    captured_utc = (Get-Date).ToUniversalTime().ToString("o")
    os = @{
        caption = $osInfo.Caption
        version = $osInfo.Version
        build_number = $osInfo.BuildNumber
        os_architecture = $osInfo.OSArchitecture
    }
    cpu = @{
        name = $cpuInfo.Name.Trim()
        number_of_cores = $cpuInfo.NumberOfCores
        number_of_logical_processors = $cpuInfo.NumberOfLogicalProcessors
        max_clock_speed_mhz = $cpuInfo.MaxClockSpeed
    }
    memory = @{
        total_ram_gb = $totalRamGb
        free_ram_gb = $freeRamGb
        ram_tier = $ramTier
    }
    gpus = @($gpus | ForEach-Object {
        @{
            name = $_.Name
            driver_version = $_.DriverVersion
            adapter_ram_mb = if ($_.AdapterRAM) { [math]::Round($_.AdapterRAM / 1MB, 0) } else { $null }
            video_processor = $_.VideoProcessor
        }
    })
    display = @{
        primary_width = $screenWidth
        primary_height = $screenHeight
    }
}

$manifestPayload = @{
    schema_version = 1
    run_id = (Split-Path -Leaf $runId)
    created_utc = (Get-Date).ToUniversalTime().ToString("o")
    fixture = @{
        id = $fixture.id
        name = $fixture.name
        path = $targetPdfPath
        sha256 = $actualPdfHash
        size_bytes = $actualPdfSize
        page = $fixture.page
        baseline_trace_id = $fixture.baseline_trace_id
        baseline_snapshot_sha256 = $fixture.baseline_snapshot_sha256
    }
    git = @{
        commit = $gitCommit
        branch = $gitBranch
        is_dirty = $gitDirty
    }
    binaries = @{
        worker_executable = $exeProvenance
        pdfium_dll = $pdfiumProvenance
    }
    snapshot_file = if (-not [string]::IsNullOrWhiteSpace($SnapshotFile)) { (Resolve-Path $SnapshotFile).Path } else { $null }
}

$hardwareJsonFile = Join-Path $runId "hardware.json"
$manifestJsonFile = Join-Path $runId "manifest.json"

$hardwarePayload | ConvertTo-Json -Depth 6 | Set-Content -Path $hardwareJsonFile -Encoding UTF8
$manifestPayload | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestJsonFile -Encoding UTF8

Write-Host "Baseline captured successfully."
Write-Host "  Run directory : $runId"
Write-Host "  Fixture       : $($fixture.id) ($($fixture.name)) [VERIFIED SHA-256]"
Write-Host "  CPU           : $($cpuInfo.Name.Trim()) ($($cpuInfo.NumberOfLogicalProcessors) logical)"
Write-Host "  RAM           : $totalRamGb GB (Tier: $ramTier)"
if (@($gpus).Count -gt 0) {
    Write-Host "  GPU           : $($gpus[0].Name) (Driver: $($gpus[0].DriverVersion))"
}
Write-Host "  Manifest      : $manifestJsonFile"
Write-Host "  Hardware      : $hardwareJsonFile"
