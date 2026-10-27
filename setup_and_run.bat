@echo off
setlocal
cd /d "%~dp0"
title Service Monitor

echo ============================================================
echo   Service Monitor 3.2
echo ============================================================
echo.

set "PYTHON="
if exist ".venv\Scripts\python.exe" set "PYTHON=.venv\Scripts\python.exe"
if not defined PYTHON (
    where py >nul 2>&1
    if not errorlevel 1 set "PYTHON=py -3"
)
if not defined PYTHON (
    where python >nul 2>&1
    if not errorlevel 1 set "PYTHON=python"
)
if not defined PYTHON (
    echo Python 3.10 or newer is required.
    echo Download it from https://www.python.org/downloads/windows/
    echo During installation enable "Add Python to PATH".
    echo.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    %PYTHON% -m venv .venv
    if errorlevel 1 (
        echo Failed to create the virtual environment.
        pause
        exit /b 1
    )
)

set "VENV_PY=.venv\Scripts\python.exe"

echo Installing dependencies...
"%VENV_PY%" -m pip install --disable-pip-version-check --quiet --upgrade pip
"%VENV_PY%" -m pip install --disable-pip-version-check --quiet -r requirements.txt
if errorlevel 1 (
    echo Failed to install dependencies. Check your internet connection.
    pause
    exit /b 1
)

echo.
echo Panel: http://localhost:8062
echo The application minimizes to the system tray.
echo Close it from the tray menu or press Ctrl+C in this window.
echo.

"%VENV_PY%" run.py
echo.
echo Service Monitor stopped.
pause
