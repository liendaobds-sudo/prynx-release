@echo off
chcp 65001 >nul
title PrynX - Phat hanh ban cap nhat (auto-update)
cd /d "%~dp0"
echo.
echo   === PrynX - Phat hanh ban cap nhat ===
echo   (Preflight QA -^> build + ky updater + upload len GitHub Releases)
echo.
set /p VER=Nhap so phien ban moi (vd 1.0.1): 
set /p REPO=Nhap repo releases PUBLIC (vd owner/pdfcompare-releases): 
set /p KPWD=Nhap mat khau khoa updater (Enter neu de trong): 
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release_update.ps1" -Version "%VER%" -ReleaseRepo "%REPO%" -KeyPassword "%KPWD%"
echo.
if %ERRORLEVEL% NEQ 0 (
    echo   [LOI] Phat hanh that bai - doc dong mau do o tren.
) else (
    echo   [XONG] Da phat hanh ban %VER%.
)
echo.
echo   Nhan phim bat ky de dong...
pause >nul
