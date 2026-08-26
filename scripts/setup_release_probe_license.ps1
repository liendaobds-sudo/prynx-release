#requires -version 5
param([string]$StorePath = "")

# ============================================================
#  [DIELINE-PROBE 2026-08-26 §F] Nhap license TEST cho probe kich hoat
#
#  Probe o cong phat hanh (build_production.ps1, Step 1a) goi license-verify that
#  roi dung token nhan duoc de chay engine khuon be trong wheel da staged. No can
#  MOT license TEST rieng.
#
#  Bat buoc: KHONG BAO GIO nhap license cua khach. Lan goi that se tieu mot suat
#  activation vinh vien cho machine_id co dinh cua probe va mot suat cap khoa cho
#  cap (license TEST, app_version).
#
#  Gia tri duoc ma hoa bang DPAPI CurrentUser va luu o kho RIENG probe.clixml,
#  khong dung chung payload voi secrets.clixml (xem chu thich trong
#  release_secret_store.ps1).
# ============================================================

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release_secret_store.ps1")

Write-Host ""
Write-Host "  CAU HINH LICENSE TEST CHO PROBE KICH HOAT" -ForegroundColor Cyan
Write-Host "  Nhap license TEST danh rieng cho probe phat hanh." -ForegroundColor Gray
Write-Host "  KHONG dung license cua khach: probe tieu mot suat activation that." -ForegroundColor Yellow
Write-Host "  Machine id co dinh cua probe: $script:PrynXReleaseProbeMachineId" -ForegroundColor DarkGray
Write-Host "  Ky tu ban nhap se khong hien tren man hinh." -ForegroundColor Gray
Write-Host ""

$probeLicense = Read-Host "License TEST cho probe" -AsSecureString
try {
    $savedPath = Save-PrynXReleaseProbeLicense -ProbeLicense $probeLicense -StorePath $StorePath
    Write-Host "  [OK] Da luu license TEST cua probe:" -ForegroundColor Green
    Write-Host "       $savedPath" -ForegroundColor DarkGray
    Write-Host "  Buoc ke tiep: chay build noi bo de probe kiem tra ca hai chang." -ForegroundColor Gray
} finally {
    if ($probeLicense) { $probeLicense.Dispose() }
    $probeLicense = $null
}
