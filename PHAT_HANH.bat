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

REM SEC (audit 2026-09-04 SEC.24-R7): passphrase chi vao Windows PowerShell
REM nam canh cmd.exe hien tai; khong tin SystemRoot/PATH ambient truoc guard.
set "PRYNX_SYSTEM_POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PRYNX_SYSTEM_POWERSHELL%" (
  echo Khong tim thay Windows PowerShell he thong.
  exit /b 1
)

"%PRYNX_SYSTEM_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -NoExit -Command ^
  "$userProfileDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile); ^
   if ([string]::IsNullOrWhiteSpace($userProfileDirectory) -or -not [System.IO.Path]::IsPathRooted($userProfileDirectory)) { throw 'Windows khong tra ve UserProfile hop le cho khoa ky updater.' }; ^
   $signingKeyFile = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $userProfileDirectory '.tauri') 'prynx.key')); ^
   $signingKeyRoot = [System.IO.Path]::GetPathRoot($signingKeyFile); ^
   if ([string]::IsNullOrWhiteSpace($signingKeyRoot) -or $signingKeyFile.StartsWith('\\')) { throw 'Khoa ky updater phai nam tren volume cuc bo.' }; ^
   $currentPath = $signingKeyRoot; ^
   $relativePath = $signingKeyFile.Substring($signingKeyRoot.Length); ^
   foreach ($component in @($relativePath.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries))) { ^
     $currentPath = Join-Path $currentPath $component; ^
     if (-not (Test-Path -LiteralPath $currentPath)) { continue }; ^
     $pathItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop; ^
     if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Duong dan khoa ky updater chua reparse point: ' + $currentPath) }; ^
   }; ^
   $signingPassword = $null; $passwordBstr = [IntPtr]::Zero; ^
   try { ^
     if (-not (Test-Path -LiteralPath $signingKeyFile -PathType Leaf)) { throw ('Khong thay khoa ky updater: ' + $signingKeyFile) }; ^
     $securePassword = Read-Host 'Nhap passphrase khoa ky updater' -AsSecureString; ^
     $passwordBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword); ^
     $signingPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordBstr); ^
     if ([string]::IsNullOrEmpty($signingPassword)) { throw 'Release tu choi khoa updater khong co passphrase.' }; ^
     $env:PRYNX_TAURI_SIGNING_KEY_FILE = $signingKeyFile; ^
     $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $signingPassword; ^
     ^& .\build_production.ps1 -Release; ^
   } finally { ^
     if ($passwordBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordBstr) }; ^
     $signingPassword = $null; $securePassword = $null; ^
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
