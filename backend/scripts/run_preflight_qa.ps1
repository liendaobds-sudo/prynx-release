# Preflight QA — một lệnh chạy toàn bộ (local Windows)
# Usage: .\scripts\run_preflight_qa.ps1
$ErrorActionPreference = "Stop"
$BackendRoot = Split-Path $PSScriptRoot -Parent
Set-Location $BackendRoot

$Python = Join-Path $BackendRoot "venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    Write-Error "Không tìm thấy venv. Chạy: python -m venv venv && .\venv\Scripts\pip install -r requirements.txt"
}

# BUILD (audit 2026-08-11 §REL.QA.GOLDEN): conftest chỉ sinh các PDF còn thiếu.
# Không gọi generate_all ở đây vì nó ghi lại expected_rules.json đã track và làm
# mất ý nghĩa khóa golden hoặc khiến source sạch thành bẩn giữa lượt build.
Write-Host "==> [1/1] Chạy pytest Preflight (tự sinh fixture PDF còn thiếu)..." -ForegroundColor Cyan
& $Python -m pytest `
    tests\preflight_golden `
    tests\test_preflight_engine.py `
    tests\test_image_dpi_props.py `
    tests\test_placed_size_props.py `
    tests\test_tac_threshold_props.py `
    tests\test_tac_props.py `
    tests\test_tac_bbox_props.py `
    -v --tb=short

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nPreflight QA: PASSED" -ForegroundColor Green
} else {
    Write-Host "`nPreflight QA: FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}
