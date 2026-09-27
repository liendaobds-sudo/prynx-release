<#
.SYNOPSIS
    PPE Viewer GPU - Kich ban chay harness kiem chung nhung Win32 Child HWND & wgpu.

.DESCRIPTION
    Thuc thi cong cu `embedding_spike` o che do tu dong (automated mode) de kiem tra:
    - SetProcessDpiAwarenessContext Per-Monitor V2
    - Gan ket Child HWND voi Host Window (WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS)
    - Khoi tao wgpu Surface truc tiep tren Child HWND
    - Reconfigure swapchain khi resize kich thuoc cua so (khong device loss)
    - Co che cach ly modal lifecycle (EnableWindow)
    - Dong thoi ho tro nhieu viewport (multi-viewport coexistence)

.PARAMETER OutputPath
    Duong dan file ket qua JSON. Mac dinh: .tmp/viewer-gpu/embedding_verification.json
#>

[CmdletBinding()]
param(
    [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputPath) {
    $OutputPath = Join-Path $RepoRoot ".tmp\viewer-gpu\embedding_verification.json"
}

$ParentDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $ParentDir)) {
    New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
}

$ManifestPath = Join-Path $RepoRoot "tools\embedding_spike\Cargo.toml"
if (-not (Test-Path $ManifestPath)) {
    Write-Error "[FAIL-CLOSED] Khong tim thay embedding_spike tai: $ManifestPath"
    exit 1
}

Write-Host ">>> Dang chay embedding_spike de kiem chung Win32 Child HWND..." -ForegroundColor Cyan

$CargoArgs = @(
    "run",
    "--manifest-path", $ManifestPath,
    "--",
    "--automated",
    $OutputPath
)

& cargo @CargoArgs
$ExitCode = $LASTEXITCODE

if ($ExitCode -ne 0) {
    Write-Error "[FAIL-CLOSED] embedding_spike that bai voi ma thoat $ExitCode!"
    exit $ExitCode
}

if (-not (Test-Path $OutputPath)) {
    Write-Error "[FAIL-CLOSED] Khong tim thay file ket qua tai: $OutputPath"
    exit 2
}

$RawJson = Get-Content -Path $OutputPath -Raw -Encoding UTF8
$Report = ConvertFrom-Json $RawJson

Write-Host ">>> Ket qua kiem chung nhung Child HWND:" -ForegroundColor Green
Write-Host "    - DPI V2 Awareness: $($Report.dpi_awareness_v2_set) (DPI: $($Report.system_dpi))"
Write-Host "    - Child HWND Attachment: $($Report.test_results.parent_child_attachment.passed)"
Write-Host "    - wgpu Surface on Child: $($Report.test_results.wgpu_surface_on_child.passed)"
Write-Host "    - Resize Reconfiguration: $($Report.test_results.resize_reconfiguration.passed)"
Write-Host "    - Modal Isolation: $($Report.test_results.modal_lifecycle_isolation.passed)"
Write-Host "    - Multi-Viewport: $($Report.test_results.multi_viewport_coexistence.passed)"
Write-Host "    - Verdict: $($Report.verdict)"

if (-not $Report.verdict) {
    Write-Error "[FAIL-CLOSED] Embedding spike bao ket qua KHONG DAT!"
    exit 3
}

Write-Host ">>> [HOAN TAT] Kiem chung nhung Win32 Child HWND dat 100% tieu chuan." -ForegroundColor Green
exit 0
