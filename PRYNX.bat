@echo off
chcp 65001 >nul
title PrynX - Cong cu Build ^& Phat hanh
cd /d "%~dp0"

REM Mo thang UI quan ly phat hanh (co ca nut Build NOI BO va PHAT HANH).
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0quanly_phathanh.ps1"
