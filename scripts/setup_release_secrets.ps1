#requires -version 5
param([string]$StorePath = "")

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release_secret_store.ps1")

Write-Host ""
Write-Host "  CAU HINH KHOA PHAT HANH PRYNX" -ForegroundColor Cyan
Write-Host "  Nhap Supabase secret key moi (sb_secret_...)." -ForegroundColor Gray
Write-Host "  Gia tri se duoc ma hoa bang DPAPI cua tai khoan Windows hien tai." -ForegroundColor Gray
Write-Host "  Ky tu ban nhap se khong hien tren man hinh." -ForegroundColor Gray
Write-Host ""

$secret = Read-Host "Supabase secret key" -AsSecureString
try {
    $savedPath = Save-PrynXReleaseSecrets -SupabaseSecret $secret -StorePath $StorePath
    Write-Host "  [OK] Da luu kho khoa phat hanh an toan:" -ForegroundColor Green
    Write-Host "       $savedPath" -ForegroundColor DarkGray
} finally {
    if ($secret) { $secret.Dispose() }
    $secret = $null
}
