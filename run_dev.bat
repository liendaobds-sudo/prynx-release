@echo off
setlocal
echo ==================================================
echo      KHOI DONG PDF INSPECTOR (DEV MODE)
echo ==================================================
echo.

set "ROOT_DIR=%cd%"
:: Them poppler vao PATH he thong
set "PATH=%ROOT_DIR%\poppler\poppler-24.08.0\Library\bin;%PATH%"

echo [1/3] Kiem tra moi truong Backend (Python)...
if not exist "backend\venv" (
    echo - Dang thiet lap moi truong ao Python venv...
    cd backend
    python -m venv venv
    echo - Dang cai thu vien Python phia Backend hoi lau do nhe...
    venv\Scripts\python.exe -m pip install --upgrade pip
    venv\Scripts\python.exe -m pip install -r requirements.txt
    cd ..
) else (
    echo - Backend OK.
)

:: Tu dong cap nhat POPPLER_PATH vao file backend\.env theo tinh trang hien tai
cd backend
if not exist ".env" (
    if exist "..\.env.example" (
        copy "..\.env.example" ".env" > nul
    ) else (
        echo. > ".env"
    )
)
findstr /v "POPPLER_PATH" ".env" > ".env.tmp"
echo POPPLER_PATH=%ROOT_DIR%\poppler\poppler-24.08.0\Library\bin>> ".env.tmp"
move /y ".env.tmp" ".env" > nul
cd ..

echo.
echo [2/3] Kiem tra moi truong Frontend (Node.js)...
if not exist "desktop\node_modules" (
    echo - Dang cai dat cac thu vien giao dien...
    cd desktop
    call npm install
    cd ..
) else (
    echo - Frontend OK.
)

echo.
echo [3/4] Dang dang ky Context Menu (Chuot phai)...
set "EXE_PATH=%ROOT_DIR%\desktop\src-tauri\target\debug\pdf-inspector.exe"
set "REG_BASE=HKCU\Software\Classes\SystemFileAssociations"

:: PDF
reg add "%REG_BASE%\.pdf\shell\pdf-inspector-combine" /ve /d "Combine in PrynX" /f >nul
reg add "%REG_BASE%\.pdf\shell\pdf-inspector-combine" /v "Icon" /d "\"%EXE_PATH%\",0" /f >nul
reg add "%REG_BASE%\.pdf\shell\pdf-inspector-combine" /v "MultiSelectModel" /d "Player" /f >nul
reg add "%REG_BASE%\.pdf\shell\pdf-inspector-combine\command" /ve /d "\"%EXE_PATH%\" \"%%1\"" /f >nul

:: JPG
reg add "%REG_BASE%\.jpg\shell\pdf-inspector-combine" /ve /d "Combine in PrynX" /f >nul
reg add "%REG_BASE%\.jpg\shell\pdf-inspector-combine" /v "Icon" /d "\"%EXE_PATH%\",0" /f >nul
reg add "%REG_BASE%\.jpg\shell\pdf-inspector-combine" /v "MultiSelectModel" /d "Player" /f >nul
reg add "%REG_BASE%\.jpg\shell\pdf-inspector-combine\command" /ve /d "\"%EXE_PATH%\" \"%%1\"" /f >nul

:: PNG
reg add "%REG_BASE%\.png\shell\pdf-inspector-combine" /ve /d "Combine in PrynX" /f >nul
reg add "%REG_BASE%\.png\shell\pdf-inspector-combine" /v "Icon" /d "\"%EXE_PATH%\",0" /f >nul
reg add "%REG_BASE%\.png\shell\pdf-inspector-combine" /v "MultiSelectModel" /d "Player" /f >nul
reg add "%REG_BASE%\.png\shell\pdf-inspector-combine\command" /ve /d "\"%EXE_PATH%\" \"%%1\"" /f >nul

:: ─── Convert to PDF (CHI anh: 1 anh -> 1 PDF). Co --prynx-action=convert de
::     App.tsx dinh tuyen 1 file vao tab Ghep (xuat PDF) thay vi Binh bai. ───
set "CONVERB=pdf-inspector-convert"
for %%E in (.jpg .jpeg .png) do (
    reg add "%REG_BASE%\%%E\shell\%CONVERB%" /ve /d "Convert to PDF in PrynX" /f >nul
    reg add "%REG_BASE%\%%E\shell\%CONVERB%" /v "Icon" /d "\"%EXE_PATH%\",0" /f >nul
    reg add "%REG_BASE%\%%E\shell\%CONVERB%" /v "MultiSelectModel" /d "Player" /f >nul
    reg add "%REG_BASE%\%%E\shell\%CONVERB%\command" /ve /d "\"%EXE_PATH%\" --prynx-action=convert \"%%1\"" /f >nul
)

echo - Context Menu OK.

echo.
echo [4/4] Dang khoi dong he thong...
echo - Don dep cong 8321 truoc khi chay (tranh loi bong ma tien trinh)
powershell -NoProfile -Command "Get-Process -Name python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*uvicorn app.main:app*' } | Stop-Process -Force"

echo - Tieu diet tat ca tien trinh Python bi treo (Neu co)
taskkill /F /IM python.exe /T >nul 2>&1

echo - Tieu diet tat ca tien trinh Frontend/Tauri bi kẹt (Neu co)
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM cargo.exe /T >nul 2>&1
taskkill /F /IM pdf-inspector.exe /T >nul 2>&1

FOR /F "tokens=5" %%a IN ('netstat -aon ^| findstr :8321 ^| findstr LISTENING') DO (
    echo - Dang diet tien trinh ao PID %%a...
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo [*] Dong bo bundle engine khuon tu source TypeScript...
cd desktop
call npm.cmd run build:dieline-sidecar
if errorlevel 1 (
    cd ..
    echo *** LOI: Khong the build bundle engine khuon. Dung khoi dong de tranh chay code cu. ***
    exit /b 1
)
cd ..

echo.
echo [*] Build + cai module Rust (imposition_core / pdfcompare_native) vao venv backend...
:: Dam bao cargo co trong PATH
where cargo >nul 2>&1 || set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
:: Dam bao maturin co trong venv
backend\venv\Scripts\python.exe -m pip show maturin >nul 2>&1
if errorlevel 1 (
    echo - Cai maturin...
    backend\venv\Scripts\python.exe -m pip install maturin
)
:: maturin develop build crate trong native\ va cai thang vao venv dang chay
set "VIRTUAL_ENV=%ROOT_DIR%\backend\venv"
cd native
..\backend\venv\Scripts\python.exe -m maturin develop --release
if errorlevel 1 (
    echo *** CANH BAO: Build Rust that bai. Backend se fail-fast hoac dung fallback Python. ***
    echo *** Kiem tra da cai Rust toolchain ^(cargo^) chua. ***
)
cd ..

:: UIUX (audit 2026-07-28 §DEV.01): assetProtocol chi doc cac thu muc an toan
:: nhu %%TEMP%%. Dat file trung gian dev tai day de viewer khong bi 403 asset.localhost.
set "UPLOAD_DIR=%TEMP%\PrynX-dev\uploads"
set "RESULTS_DIR=%TEMP%\PrynX-dev\results"

echo - Khoi dong Backend (FastAPI - Port 8321)
start "PDF Inspector - Backend" cmd /k "cd backend && venv\Scripts\python.exe -m uvicorn app.main:app --port 8321 --reload --reload-dir app"

echo - Khoi dong Giao dien Desktop (Tauri)
start "PDF Inspector - Frontend" cmd /k "cd desktop && set PATH=%USERPROFILE%\.cargo\bin;%PATH% && npx @tauri-apps/cli dev"

echo.
echo ==================================================
echo Hoan tat! Phan mem se tu dong mo len sau vai giay.
echo Neu la may moi, vui long kiem tra ban da cai Node.js, Python, va Rust!
echo ==================================================
pause
