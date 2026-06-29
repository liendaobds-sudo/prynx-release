@echo off
chcp 65001 >nul
REM ============================================================
REM   PrynX - BUILD 1-CLICK: dong goi file cai dat gui khach
REM   Chi can DOUBLE-CLICK file nay va doi (~10-20 phut lan dau).
REM   Ket qua: file .exe trong thu muc  Ban_Phat_Hanh\
REM ============================================================
title PrynX - Build 1-click (dong goi gui khach)
cd /d "%~dp0"

echo.
echo   ============================================
echo     PrynX - BUILD 1-CLICK
echo   ============================================
echo.
echo   Dang kiem tra dieu kien truoc khi build...

REM --- Kiem tra 1: venv backend (neu thieu -> chay setup) ---
if not exist "%~dp0backend\venv\Scripts\python.exe" (
    echo.
    echo   [LOI] Chua co moi truong backend ^(backend\venv^).
    echo         Hay chay  setup_dev_env.bat  mot lan truoc, roi build lai.
    echo.
    pause >nul
    exit /b 1
)

REM --- Kiem tra 2: Ghostscript (BAT BUOC - kiem som de khoi doi 15 phut roi moi loi) ---
if not exist "C:\Program Files\gs\gs10.04.0" (
    echo.
    echo   [LOI] Thieu Ghostscript 10.04.0 tai  C:\Program Files\gs\gs10.04.0
    echo         Ghostscript la BAT BUOC ^(tach mau CMYK / xuat PDF-X^).
    echo         Cai Ghostscript 10.04.0 roi build lai.
    echo.
    pause >nul
    exit /b 1
)

echo   [OK] Du dieu kien. Bat dau build ^(Preflight QA -^> Nuitka -^> installer^)...
echo        Lan dau co the mat 10-20 phut, cu de may chay.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_production.ps1"

echo.
if %ERRORLEVEL% NEQ 0 (
    echo   [LOI] Build that bai. Doc dong mau do o tren de biet ly do.
) else (
    echo   [XONG] Da build xong. File cai dat nam trong thu muc  Ban_Phat_Hanh\
    echo          Gui file .exe trong thu muc do cho khach la duoc.
)
echo.
echo   Nhan phim bat ky de dong cua so nay...
pause >nul
