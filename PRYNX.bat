@echo off
chcp 65001 >nul
title PrynX - Cong cu Build ^& Phat hanh
cd /d "%~dp0"

REM Mo UI quan ly phat hanh; moi luot build/phat hanh se co terminal log rieng.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0quanly_phathanh.ps1" -ShowBuildTerminal
