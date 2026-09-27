<#
.SYNOPSIS
    PPE Viewer GPU - Runner nghiem thu tong the mot lenh (One-Command Acceptance Runner).

.DESCRIPTION
    Thuc hien toan bo chu trinh kiem chung G0 theo dung dac ta:
    1. Kiem tra băm SHA-256 fixture mỏ neo (R01). Fail-closed neu sai hash.
    2. Thu thap cau hinh he thong, GPU, CPU, RAM va git provenance (capture_baseline.ps1).
    3. Tham do truc tiep nang luc GPU D3D12/Vulkan qua wgpu 24 (probe_gpu.ps1).
    4. Kiem chung nhung Win32 Child HWND, DPI V2, resize va modal isolation (run_embedding_spike.ps1).
    5. Kiem chung giao thuc Surface Lease, zero full-frame GPU readback va device recovery (process_protocol_probe.py).
    6. Tong hop toan bo artifact chuan vao thu muc .tmp/viewer-gpu/runs/<run-id>/ va danh gia verdict.

.PARAMETER FixtureId
    Dinh danh fixture can nghiem thu. Mac dinh: R01
.PARAMETER RunId
    Ma dot chay tuy chon. Mac dinh: tu dong sinh theo timestamp YYYYMMDD-HHMMSS
#>

[CmdletBinding()]
param(
    [string]$FixtureId = "R01",
    [string]$RunId = "",
    [string]$RuntimeEvidenceDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (-not $RunId) {
    $RunId = Get-Date -Format "yyyyMMdd-HHmmss"
}

$RunDir = Join-Path $RepoRoot ".tmp\viewer-gpu\runs\$RunId"
if (-not (Test-Path $RunDir)) {
    New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ">>> PPE VIEWER GPU - BAT DAU RUNNER NGHIEM THU TONG THE (RUN: $RunId)" -ForegroundColor Cyan
Write-Host "    Thu muc ket qua: $RunDir" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# 1. Kiem tra băm SHA-256 fixture R01 va Hardware Baseline
Write-Host "`n[BUOC 1/5] Thu thap thong so moi truong & kiem tra toan ven file PDF R01..." -ForegroundColor Yellow
$CaptureScript = Join-Path $RepoRoot "scripts\viewer_gpu\capture_baseline.ps1"
& powershell.exe -ExecutionPolicy Bypass -File $CaptureScript -FixtureId $FixtureId -OutputDir $RunDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "[FAIL-CLOSED] Buoc 1 (capture_baseline) that bai!"
    exit 10
}

# 2. Tham do nang luc GPU (wgpu, D3D12/Vulkan)
Write-Host "`n[BUOC 2/5] Tham do nang luc adapter GPU & wgpu 24..." -ForegroundColor Yellow
$GpuProbeScript = Join-Path $RepoRoot "scripts\viewer_gpu\probe_gpu.ps1"
$GpuJsonOut = Join-Path $RunDir "gpu_capability.json"
& powershell.exe -ExecutionPolicy Bypass -File $GpuProbeScript -OutputPath $GpuJsonOut
if ($LASTEXITCODE -ne 0) {
    Write-Error "[FAIL-CLOSED] Buoc 2 (probe_gpu) that bai!"
    exit 20
}

# 3. Kiem chung nhung Win32 Child HWND & wgpu Surface
Write-Host "`n[BUOC 3/5] Kiem chung nhung Win32 Child HWND & wgpu surface..." -ForegroundColor Yellow
$SpikeScript = Join-Path $RepoRoot "scripts\viewer_gpu\run_embedding_spike.ps1"
$SpikeJsonOut = Join-Path $RunDir "embedding_verification.json"
& powershell.exe -ExecutionPolicy Bypass -File $SpikeScript -OutputPath $SpikeJsonOut
if ($LASTEXITCODE -ne 0) {
    Write-Error "[FAIL-CLOSED] Buoc 3 (embedding_spike) that bai!"
    exit 30
}

# 4. Kiem chung Surface Lease Lifetime & Zero Full-Frame Readback
Write-Host "`n[BUOC 4/5] Kiem chung giao thuc Surface Lease & zero full-frame GPU readback..." -ForegroundColor Yellow
$ProtocolScript = Join-Path $RepoRoot "scripts\viewer_gpu\process_protocol_probe.py"
$PythonExe = Join-Path $RepoRoot "backend\venv\Scripts\python.exe"
$ProtocolJsonOut = Join-Path $RunDir "process_protocol.json"

$ProtocolResult = & $PythonExe $ProtocolScript
if ($LASTEXITCODE -ne 0) {
    Write-Error "[FAIL-CLOSED] Buoc 4 (process_protocol_probe) that bai!"
    exit 40
}
$ProtocolResult | Out-File -FilePath $ProtocolJsonOut -Encoding UTF8

# 5. Sao chep acceptance-v1.json va tao summary.json
Write-Host "`n[BUOC 5/5] Tong hop ket qua va danh gia tieu chi nghiem thu..." -ForegroundColor Yellow
$AcceptanceSrc = Join-Path $RepoRoot "tests\viewer_gpu\acceptance-v1.json"
$AcceptanceDst = Join-Path $RunDir "acceptance.json"
Copy-Item -Path $AcceptanceSrc -Destination $AcceptanceDst -Force

$GpuData = Get-Content -Path $GpuJsonOut -Raw -Encoding UTF8 | ConvertFrom-Json
$SpikeData = Get-Content -Path $SpikeJsonOut -Raw -Encoding UTF8 | ConvertFrom-Json
$ProtocolData = Get-Content -Path $ProtocolJsonOut -Raw -Encoding UTF8 | ConvertFrom-Json
$HardwareData = Get-Content -Path (Join-Path $RunDir "hardware.json") -Raw -Encoding UTF8 | ConvertFrom-Json

# PERF (audit 2026-09-25 §R25.GPU.10): spike/model không cấp phép nghiệm thu runtime.
if (-not $RuntimeEvidenceDir) { $RuntimeEvidenceDir = $RunDir }
& $PythonExe (Join-Path $PSScriptRoot "validate_acceptance.py") $RuntimeEvidenceDir
$RuntimeVerdict = $LASTEXITCODE -eq 0
$OverallVerdict = ($GpuData.verdict.meets_minimum_requirements -eq $true) -and $RuntimeVerdict

$Summary = [ordered]@{
    run_id = $RunId
    fixture_id = $FixtureId
    timestamp_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    verdict = $OverallVerdict
    evidence_scope = "G0 probes + runtime evidence validation; spike/model alone cannot pass"
    runtime_acceptance_path = (Join-Path $RuntimeEvidenceDir "runtime-acceptance.json")
    milestone_g0_status = if ($OverallVerdict) { "PASSED" } else { "FAILED" }
    components = [ordered]@{
        fixture_integrity_r01 = "PASSED"
        gpu_capability = [ordered]@{
            primary_adapter = $GpuData.adapters[$GpuData.primary_adapter_index].name
            backend = $GpuData.adapters[$GpuData.primary_adapter_index].backend
            max_texture_2d = $GpuData.verdict.max_texture_dimension_2d
            hardware_accelerated = $GpuData.verdict.hardware_accelerated
            status = if ($GpuData.verdict.meets_minimum_requirements) { "PASSED" } else { "FAILED" }
        }
        embedding_spike = [ordered]@{
            dpi_v2 = $SpikeData.dpi_awareness_v2_set
            child_hwnd_attachment = $SpikeData.test_results.parent_child_attachment.passed
            wgpu_surface = $SpikeData.test_results.wgpu_surface_on_child.passed
            resize_reconfig = $SpikeData.test_results.resize_reconfiguration.passed
            modal_isolation = $SpikeData.test_results.modal_lifecycle_isolation.passed
            status = if ($SpikeData.verdict) { "PASSED" } else { "FAILED" }
        }
        process_protocol = [ordered]@{
            zero_gpu_readback = $ProtocolData.zero_gpu_readback
            use_after_free_blocked = $ProtocolData.use_after_free_blocked
            device_loss_recovery = $ProtocolData.device_loss_recovery_successful
            status = if ($ProtocolData.verdict) { "PASSED" } else { "FAILED" }
        }
    }
}

$SummaryJsonPath = Join-Path $RunDir "summary.json"
$Summary | ConvertTo-Json -Depth 6 | Out-File -FilePath $SummaryJsonPath -Encoding UTF8

Write-Host "======================================================================" -ForegroundColor Green
Write-Host ">>> TONG HOP KET QUA NGHIEM THU G0: $($Summary.milestone_g0_status)" -ForegroundColor Green
Write-Host "    - Fixture R01 SHA-256: PASSED"
Write-Host "    - GPU Adapter Probe: $($Summary.components.gpu_capability.status) ($($Summary.components.gpu_capability.primary_adapter) / $($Summary.components.gpu_capability.backend))"
Write-Host "    - Win32 Child HWND Spike: $($Summary.components.embedding_spike.status)"
Write-Host "    - Process Protocol & Lease Lifetime: $($Summary.components.process_protocol.status)"
Write-Host "    - Artifact Directory: $RunDir"
Write-Host "======================================================================" -ForegroundColor Green

if (-not $OverallVerdict) {
    Write-Error "[FAIL-CLOSED] Nghiem thu G0 khong dat!"
    exit 50
}

exit 0
