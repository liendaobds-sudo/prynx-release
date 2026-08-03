#requires -version 5

# Wrapper tuong thich cho quy trinh cu. Khong dan key vao file nay.
# Thiet lap mot lan (nhap an, luu DPAPI CurrentUser):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup_release_secrets.ps1
#
# Nap vao dung process can build:
#   . .\scripts\set_release_env.example.ps1
#   .\build_production.ps1 -Release

. (Join-Path $PSScriptRoot "release_secret_store.ps1")
Import-PrynXReleaseEnvironment
Write-Host "Release secret da nap tu kho DPAPI cho dung project PrynX." -ForegroundColor Green
