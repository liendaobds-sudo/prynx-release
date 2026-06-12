@echo off
chcp 65001 >nul
REM ============================================================
REM   PrynX - Dong goi 1 phat ra file cai dat gui khach
REM   Chi can DOUBLE-CLICK file nay va doi.
REM ============================================================
title PrynX - Dong goi gui khach
cd /d "%~dp0"

echo.
echo   ============================================
echo     PrynX - Dang dong goi file cai dat...
echo     (Lan dau co the mat 10-20 phut, cu de may chay)
echo   ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_production.ps1"

echo.
if %ERRORLEVEL% NEQ 0 (
    echo   [LOI] Dong goi that bai. Doc dong mau do o tren de biet ly do.
) else (
    echo   [XONG] File cai dat da san sang trong thu muc vua mo.
    echo   Gui file .exe trong thu muc do cho khach la duoc.
)
echo.
echo   Nhan phim bat ky de dong cua so nay...
pause >nul
