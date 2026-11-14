@echo off
rem Jalankan backend (FastAPI) dan frontend (React/Vite) dalam dua jendela terminal.
rem Taruh file ini di root repo (sejajar dengan folder backend, frontend, venv).
set "ROOT=%~dp0"

if not exist "%ROOT%venv\Scripts\python.exe" (
    echo [ERROR] venv tidak ditemukan di "%ROOT%venv"
    echo Buat dulu dengan: python -m venv venv ^&^& venv\Scripts\activate ^&^& python -m pip install -r backend\requirements.txt
    pause
    exit /b 1
)

if not exist "%ROOT%backend\models\best.pt" (
    echo [PERINGATAN] backend\models\best.pt tidak ditemukan. Backend akan gagal start tanpa model.
)

if not exist "%ROOT%frontend\node_modules" (
    echo Menginstall dependensi frontend, tunggu sebentar...
    pushd "%ROOT%frontend"
    call npm install
    popd
)

echo Menjalankan backend di http://localhost:8000 ...
start "Backend" /d "%ROOT%backend" cmd /k ""%ROOT%venv\Scripts\python.exe" -m uvicorn main:app --reload --port 8000"

echo Menjalankan frontend di http://localhost:5173 ...
start "Frontend" /d "%ROOT%frontend" cmd /k "npm run dev"

echo.
echo Dua jendela terminal sudah dibuka. Tutup jendelanya untuk menghentikan server.
timeout /t 5 >nul