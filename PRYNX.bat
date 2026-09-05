@echo off
setlocal
chcp 65001 >nul
title PrynX - Cong cu Build ^& Phat hanh
cd /d "%~dp0"

REM SEC (audit 2026-09-04 SEC.24-R7): __APPDIR__ do cmd.exe tu sinh,
REM khong tin SystemRoot/PATH ambient truoc khi PowerShell guard nhan quyen.
set "PRYNX_SYSTEM_POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PRYNX_SYSTEM_POWERSHELL%" (
  echo Khong tim thay Windows PowerShell he thong.
  exit /b 1
)
REM Mo UI quan ly phat hanh; moi luot build/phat hanh se co terminal log rieng.
start "" "%PRYNX_SYSTEM_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0quanly_phathanh.ps1" -ShowBuildTerminal
