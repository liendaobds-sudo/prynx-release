<#
.SYNOPSIS
    PPE Viewer GPU - Kich ban tham do nang luc GPU (wgpu, D3D12/Vulkan).

.DESCRIPTION
    Thuc thi cong cu Rust `gpu_capability_probe` de truy van truc tiep cac adapter GPU,
    cac gioi han texture (max_texture_dimension_2d), ho tro D3D12/Vulkan, compute shader,
    va kha nang render texture Rgba16Float/Rgba8Unorm.
    Xuat ket qua ra file JSON va tra ma loi fail-closed neu GPU khong dat yeu cau.

.PARAMETER OutputPath
    Duong dan file JSON dau ra. Mac dinh: .tmp/viewer-gpu/gpu_capability.json
#>

[CmdletBinding()]
param(
    [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputPath) {
    $OutputPath = Join-Path $RepoRoot ".tmp\viewer-gpu\gpu_capability.json"
}

$ParentDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $ParentDir)) {
    New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
}

$ManifestPath = Join-Path $RepoRoot "tools\gpu_capability_probe\Cargo.toml"
if (-not (Test-Path $ManifestPath)) {
    Write-Error "[FAIL-CLOSED] Khong tim thay tool gpu_capability_probe tai: $ManifestPath"
    exit 1
}

Write-Host ">>> Dang chay gpu_capability_probe de kiem tra D3D12/Vulkan..." -ForegroundColor Cyan

$CargoArgs = @(
    "run",
    "--manifest-path", $ManifestPath,
    "--",
    $OutputPath
)

& cargo @CargoArgs
$ExitCode = $LASTEXITCODE

if ($ExitCode -ne 0) {
    Write-Error "[FAIL-CLOSED] gpu_capability_probe that bai voi ma thoat $ExitCode!"
    exit $ExitCode
}

if (-not (Test-Path $OutputPath)) {
    Write-Error "[FAIL-CLOSED] File ket qua JSON khong duoc sinh ra tai: $OutputPath"
    exit 2
}

# Doc va xac thuc JSON ket qua
$RawJson = Get-Content -Path $OutputPath -Raw -Encoding UTF8
$Report = ConvertFrom-Json $RawJson

Write-Host ">>> Ket qua tham do GPU:" -ForegroundColor Green
Write-Host "    - Primary Adapter: $($Report.adapters[$Report.primary_adapter_index].name)"
Write-Host "    - Backend: $($Report.adapters[$Report.primary_adapter_index].backend)"
Write-Host "    - Device Type: $($Report.adapters[$Report.primary_adapter_index].device_type)"
Write-Host "    - Max 2D Texture: $($Report.verdict.max_texture_dimension_2d)px"
Write-Host "    - Hardware Accelerated: $($Report.verdict.hardware_accelerated)"
Write-Host "    - Supports RGBA16F Render: $($Report.verdict.supports_rgba16f_render)"
Write-Host "    - Supports Compute Shaders: $($Report.verdict.supports_compute_shaders)"
Write-Host "    - Meets Minimum Requirements: $($Report.verdict.meets_minimum_requirements)"

if (-not $Report.verdict.meets_minimum_requirements) {
    Write-Error "[FAIL-CLOSED] GPU khong dat yeu cau toi thieu cua PPE Viewer GPU!"
    exit 3
}

Write-Host ">>> [HOAN TAT] GPU hop le va dat tieu chuan cho PPE Viewer GPU." -ForegroundColor Green
exit 0
