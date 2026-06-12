@echo off
title PrynX - Dev Environment Setup
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   PrynX — Cai Dat Moi Truong Dev (1 click)  ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: Check if running as admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Can quyen Administrator. Dang khoi dong lai...
    echo.
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Run the PowerShell setup script
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_dev_env.ps1"
