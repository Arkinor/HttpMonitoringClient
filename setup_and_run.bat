@echo off
cd /d "%~dp0"
title Service Monitoring v2.0
color 0A

echo ================================================================
echo              Service Monitoring v2.0
echo ================================================================
echo.

:: Set Python 3.11 paths
set PYTHON311_PATH=%ProgramFiles%\Python311
set PYTHON311_PATH_ALT=%LocalAppData%\Programs\Python\Python311

:: Try to find Python 3.11
:find_python
set PYTHON_EXE=
echo Looking for Python 3.11...
echo.

:: Check standard locations
if exist "%PYTHON311_PATH%\python.exe" (
    set PYTHON_EXE="%PYTHON311_PATH%\python.exe"
    goto python_found
)
if exist "%PYTHON311_PATH_ALT%\python.exe" (
    set PYTHON_EXE="%PYTHON311_PATH_ALT%\python.exe"
    goto python_found
)

:: Search Program Files for Python 3.11
for /d %%i in ("%ProgramFiles%\Python*") do (
    if exist "%%i\python.exe" (
        for /f "tokens=2" %%v in ('"%%i\python.exe" --version 2^>^&1') do (
            echo %%v | findstr "^3\.11" >nul
            if not errorlevel 1 (
                set PYTHON_EXE="%%i\python.exe"
                goto python_found
            )
        )
    )
)

:: Search LocalAppData for Python 3.11
for /d %%i in ("%LocalAppData%\Programs\Python\Python*") do (
    if exist "%%i\python.exe" (
        for /f "tokens=2" %%v in ('"%%i\python.exe" --version 2^>^&1') do (
            echo %%v | findstr "^3\.11" >nul
            if not errorlevel 1 (
                set PYTHON_EXE="%%i\python.exe"
                goto python_found
            )
        )
    )
)

:: Check PATH for python3.11
where python3.11 >nul 2>&1
if not errorlevel 1 (
    set PYTHON_EXE=python3.11
    goto python_found
)

:: Check PATH for python with version 3.11
where python >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=2" %%i in ('python --version 2^>^&1') do set PYTHON_VERSION=%%i
    echo %PYTHON_VERSION% | findstr "^3\.11" >nul
    if not errorlevel 1 (
        set PYTHON_EXE=python
        goto python_found
    )
)

:: Python 3.11 not found, install it
echo Python 3.11 not found.
echo Installing Python 3.11 automatically...
echo.
goto install_python

:install_python
echo ================================================================
echo Python 3.11 Installation Required
echo ================================================================
echo.
echo Python 3.11 was not found on your system.
echo.
echo Please download and install Python 3.11 for Windows (64-bit):
echo.
echo 1. Opening download page in your browser...
echo 2. Download the installer (Windows installer 64-bit)
echo 3. Run the installer (check "Add Python to PATH")
echo 4. Run this script again
echo.
start https://www.python.org/downloads/release/python-3110/
echo.
echo Alternatively, you can download directly:
echo https://www.python.org/ftp/python/3.11.0/python-3.11.0-amd64.exe
echo.
pause
exit /b 1

:: Find newly installed Python
echo Locating Python 3.11 installation...
if exist "%PYTHON311_PATH%\python.exe" (
    set PYTHON_EXE="%PYTHON311_PATH%\python.exe"
    goto python_found
)
if exist "%PYTHON311_PATH_ALT%\python.exe" (
    set PYTHON_EXE="%PYTHON311_PATH_ALT%\python.exe"
    goto python_found
)

:: Search for Python 3.11 again
for /d %%i in ("%ProgramFiles%\Python*") do (
    if exist "%%i\python.exe" (
        for /f "tokens=2" %%v in ('"%%i\python.exe" --version 2^>^&1') do (
            echo %%v | findstr "^3\.11" >nul
            if not errorlevel 1 (
                set PYTHON_EXE="%%i\python.exe"
                goto python_found
            )
        )
    )
)

:: If still not found, show error
echo.
echo ERROR: Python 3.11 installed but not found!
echo Please restart your computer and run this script again.
echo.
pause
exit /b 1

:python_found
echo.
echo ================================================================
echo Python 3.11 found successfully!
echo ================================================================
echo Using: %PYTHON_EXE%
%PYTHON_EXE% --version
echo.

:continue_setup
:: Create virtual environment if not exists
if not exist ".venv" (
    echo Creating virtual environment...
    %PYTHON_EXE% -m venv .venv
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment!
        pause
        exit /b 1
    )
    echo Virtual environment created!
)

:: Activate virtual environment
echo Activating virtual environment...
call .venv\Scripts\activate.bat

:: Verify Python version
echo Python version in venv: 
python --version
echo.

:: Install dependencies
echo.
echo ================================================================
echo Installing Python dependencies
echo ================================================================
echo This may take 5-10 minutes...
echo.

echo Upgrading pip...
python -m pip install --upgrade pip

echo.
echo Installing packages...
if exist "requirements.txt" (
    pip install -r requirements.txt
) else (
    echo ERROR: requirements.txt not found!
    echo Creating basic requirements...
    echo fastapi>=0.104.0> requirements.txt
    echo uvicorn[standard]>=0.24.0>> requirements.txt
    echo aiohttp>=3.9.0>> requirements.txt
    echo pydantic>=2.0.0>> requirements.txt
    echo pydantic-settings>=2.0.0>> requirements.txt
    echo python-dotenv>=1.0.0>> requirements.txt
    echo aiofiles>=23.0.0>> requirements.txt
    pip install -r requirements.txt
)

if errorlevel 1 (
    echo.
    echo ERROR: Failed to install dependencies!
    echo Please check your internet connection.
    pause
    exit /b 1
)
echo.
echo Dependencies installed successfully!

echo.
echo ================================================================
echo                Starting Service Monitoring v2.0
echo ================================================================
echo.
echo Service Monitoring v2.0 - система мониторинга доступности веб-сервисов
echo.
echo Особенности:
echo - Мониторинг доступности веб-сервисов
echo - Веб-интерфейс с двумя вкладками: сервисы и результаты
echo - Автоматическая проверка по расписанию
echo.
echo Web interface: http://localhost:8062
echo Press Ctrl+C to stop the server
echo.

:: Run the application
python run.py

echo.
echo Application stopped.
pause >nul