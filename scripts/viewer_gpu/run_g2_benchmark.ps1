# PPE Viewer GPU - Runner do dac Benchmark Milestone G2 (DirectX 12 / Vulkan tren GPU that)
[CmdletBinding()]
param(
    [switch]$VerboseOutput = $false
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path "$ScriptDir\..\.."
Set-Location $RepoRoot

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  PPE VIEWER GPU - BENCHMARK PIPELINE G2 (1024x1024, 100 RUNS)  " -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

# 1. Chay benchmark test trong crate viewer_gpu
$CargoCmd = "cargo test --manifest-path viewer_gpu/Cargo.toml --test benchmark_r01_graph -- --nocapture"
Write-Host "[1/3] Dang thuc thi benchmark tren GPU..." -ForegroundColor Yellow
Invoke-Expression $CargoCmd
if ($LASTEXITCODE -ne 0) {
    Write-Error "Benchmark test that bai voi ma loi $LASTEXITCODE"
    exit 1
}

# 2. Tim file benchmark_g2.json
$JsonPath = "$RepoRoot\.tmp\viewer-gpu\runs\latest\benchmark_g2.json"
if (-not (Test-Path $JsonPath)) {
    $JsonPath = "$RepoRoot\viewer_gpu\.tmp\viewer-gpu\runs\latest\benchmark_g2.json"
}

if (-not (Test-Path $JsonPath)) {
    Write-Error "Khong tim thay file ket qua benchmark_g2.json!"
    exit 1
}

$Bench = Get-Content $JsonPath -Raw | ConvertFrom-Json

Write-Host "`n[2/3] BANG TONG HOP CHI TIEU HIEU NANG PER-STAGE (GPU: $($Bench.gpu_adapter)):" -ForegroundColor Green
Write-Host "-----------------------------------------------------------------"
Write-Host ("{0,-28} | {1,-12} | {2,-12}" -f "Giai doan (Stage)", "Thoi gian p95", "Muc tieu/Nguong")
Write-Host "-----------------------------------------------------------------"
Write-Host ("{0,-28} | {1,-12} | {2,-12}" -f "1. Vector Path Raster", "$($Bench.stage_raster_p95_ms) ms", "< 2.0 ms")
Write-Host ("{0,-28} | {1,-12} | {2,-12}" -f "2. Transparency Group Blend", "$($Bench.stage_blend_p95_ms) ms", "< 2.0 ms")
Write-Host ("{0,-28} | {1,-12} | {2,-12}" -f "3. Output Color Resolve", "$($Bench.stage_resolve_p95_ms) ms", "< 2.0 ms")
Write-Host "-----------------------------------------------------------------"
Write-Host ("{0,-28} | {1,-12} | {2,-12}" -f "TONG FRAME WORK (P01)", "$($Bench.frame_p95_ms) ms", "<= $($Bench.p01_target_ms) ms (60 Hz)")
Write-Host "-----------------------------------------------------------------"

# 3. Danh gia ket luan
Write-Host "`n[3/3] DANH GIA NGHIEM THU MILESTONE G2:" -ForegroundColor Yellow
if ($Bench.frame_p95_ms -le $Bench.p01_target_ms) {
    Write-Host "  >> KET QUA: DAT CHUAN P01! (p95 = $($Bench.frame_p95_ms) ms <= 16.7 ms, p50 = $($Bench.frame_p50_ms) ms)" -ForegroundColor Green
    Write-Host "  >> MILESTONE G2 HOAN THANH XUAT SAC!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "  >> KET QUA: KHONG DAT P01 (p95 = $($Bench.frame_p95_ms) ms > 16.7 ms)" -ForegroundColor Red
    exit 1
}
