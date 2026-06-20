@echo off
chcp 65001 >nul
title Claude Code CLI - Nghimmo
color 0B

cls
echo.
echo ============================================================
echo          CLAUDE CODE CLI - POWERED BY NGHIMMO
echo ============================================================
echo.
echo  Server : https://api.nghimmo.com
echo  Check  : https://api.nghimmo.com/check
echo.
echo ============================================================
echo.

:: Nhap API key cua khach
set "APIKEY="
set /p "APIKEY=Nhap API Key cua ban (sk-...): "

if "%APIKEY%"=="" (
    echo.
    echo [LOI] Ban chua nhap API Key. Dong cua so va mo lai.
    echo.
    pause
    exit /b
)

:: Tro Claude Code ve server Nghimmo (chi trong phien nay, dong la mat)
set "ANTHROPIC_BASE_URL=https://api.nghimmo.com"
set "ANTHROPIC_AUTH_TOKEN=%APIKEY%"
set "ANTHROPIC_API_KEY=%APIKEY%"
set "ANTHROPIC_MODEL=nghi/claude-sonnet-4.6"
set "ANTHROPIC_SMALL_FAST_MODEL=nghi/claude-haiku-4.5"

echo.
echo [OK] Da cau hinh xong. Dang mo Claude Code tai thu muc nay...
echo      (Thu muc: %CD%)
echo.

:: Mo Claude Code ngay tai thu muc dat file bat
claude

echo.
echo ============================================================
echo  Claude Code da dong. Nhan phim bat ky de thoat.
echo ============================================================
pause >nul
