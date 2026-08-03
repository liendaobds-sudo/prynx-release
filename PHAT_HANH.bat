@echo off
REM ============================================================
REM  PHAT_HANH.bat  --  Build ban phat hanh PrynX (mot cu chay)
REM
REM  Cach dung: double-click file nay, HOAC chay trong terminal:
REM     PHAT_HANH.bat
REM
REM  Script tu dong:
REM    1. Nap Supabase sb_secret_ tu kho DPAPI + khoa ky updater tu file rieng
REM    2. Chay build_production.ps1 -Release (build + khoa dieline + ky updater)
REM    3. Tu in ket qua DIELINE_LOCKED + mo thu muc Ban_Phat_Hanh
REM ============================================================
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command ^
  "$signingKeyFile = Join-Path $HOME '.tauri\prynx.key'; ^
   try { ^
     if (-not (Test-Path -LiteralPath $signingKeyFile -PathType Leaf)) { throw ('Khong thay khoa ky updater: ' + $signingKeyFile) }; ^
     $env:PRYNX_TAURI_SIGNING_KEY_FILE = $signingKeyFile; ^
     ^& .\build_production.ps1 -Release; ^
   } finally { ^
     Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue; ^
     Remove-Item Env:PRYNX_TAURI_SIGNING_KEY_FILE -ErrorAction SilentlyContinue; ^
     Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue; ^
   }; ^
   Write-Host ''; ^
   Write-Host '  ===========================================' -ForegroundColor Cyan; ^
   $mf = Join-Path $PWD 'Ban_Phat_Hanh\release-manifest.txt'; ^
   if (Test-Path $mf) { ^
     $locked = (Select-String -Path $mf -Pattern 'DIELINE_LOCKED').Line; ^
     if ($locked -match 'yes') { ^
       Write-Host ('  ' + $locked + '   <-- OK, PHAT HANH DUOC') -ForegroundColor Green; ^
     } else { ^
       Write-Host ('  ' + $locked + '   <-- KHONG OK, DUNG PHAT HANH') -ForegroundColor Red; ^
     } ^
     Write-Host '  Installer o: Ban_Phat_Hanh\' -ForegroundColor Cyan; ^
     Start-Process (Join-Path $PWD 'Ban_Phat_Hanh'); ^
   } else { ^
     Write-Host '  KHONG thay release-manifest.txt -- build co the da that bai.' -ForegroundColor Red; ^
   } ^
   Write-Host '  ===========================================' -ForegroundColor Cyan"
