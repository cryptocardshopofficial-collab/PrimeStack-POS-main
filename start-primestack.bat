@echo off
setlocal EnableDelayedExpansion
title PrimeStack Switch
color 0B
mode con: cols=100 lines=45

REM ============================================================
REM  PrimeStack Switch - one-click launcher
REM
REM  Stages:
REM    1. Verify Docker Desktop is installed and the engine is up.
REM    2. Start host infrastructure (PostgreSQL + Redis) from the
REM       root compose file. This stack owns the application data
REM       and is what the local platform reaches on 5432 / 6379.
REM    3. Start the microservices stack (3 infra + 15 services).
REM       Images are built only when they are missing, so repeat
REM       runs start from cache instead of rebuilding everything.
REM    4. Start the local platform: website 9004, merchant 9005,
REM       admin 9006, rails 9007, ISO 20022 9008, API 9009.
REM
REM  Usage:
REM    start-primestack.bat            Fast start (uses image cache)
REM    start-primestack.bat rebuild    Force a full image rebuild
REM ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "REBUILD=0"
if /i "%~1"=="rebuild"   set "REBUILD=1"
if /i "%~1"=="--rebuild" set "REBUILD=1"

echo.
echo ============================================
echo   PrimeStack Switch - Payment Platform
echo   Website 9004 ^| Dashboards 9005/9006 ^| API 9009
echo ============================================
echo.

REM -- Stage 1: Docker ------------------------------------------------
echo [1/4] Checking Docker...
where docker >nul 2>&1
if errorlevel 1 (
    if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" set "PATH=%ProgramFiles%\Docker\Docker\resources\bin;%PATH%"
    if exist "%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe" set "PATH=%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin;%PATH%"
    where docker >nul 2>&1
)
docker --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Docker was not found. Install Docker Desktop and try again.
    goto :fail
)

echo   Waiting for the Docker engine...
set /a dockerTries=0
:dockerwait
docker info >nul 2>&1
if not errorlevel 1 goto :dockerready
set /a dockerTries+=1
if !dockerTries! GEQ 30 (
    echo   ERROR: The Docker engine did not start within 60 seconds.
    echo          Open Docker Desktop manually and run this again.
    goto :fail
)
timeout /t 2 /nobreak >nul
goto :dockerwait
:dockerready
echo   OK: Docker engine is running.
echo.

REM -- Stage 2: Host infrastructure -----------------------------------
echo [2/4] Starting host infrastructure (PostgreSQL, Redis)...
pushd "%ROOT%"
docker compose up -d postgres redis >nul 2>&1
echo   Waiting for the databases to become healthy...
call :waitHealthy primestack-postgres 60
call :waitHealthy primestack-redis    60
popd
echo.

REM -- Stage 3: Microservices -----------------------------------------
echo [3/4] Starting the microservices stack (3 infra + 15 services)...
pushd "%ROOT%\services"
if "%REBUILD%"=="1" (
    echo   Rebuilding all service images - the first run takes several minutes.
    docker compose up -d --build
) else (
    echo   Reusing cached images ^(missing images are built automatically^)...
    docker compose up -d
)
if errorlevel 1 (
    echo   WARNING: the microservices stack reported errors.
    echo            The local platform will still start below.
)
popd
echo.

REM -- Stage 4: Local platform ----------------------------------------
echo [4/4] Starting the local platform (9004-9009)...
cd /d "%ROOT%"

REM Stop only stale PrimeStack processes on the assigned ports.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$targets = @(@{Port=9004; Pattern='start-public-site\.js'}, @{Port=9005; Pattern='start-dashboard\.js'}, @{Port=9006; Pattern='start-dashboard\.js'}, @{Port=9009; Pattern='start-platform\.mjs'}); foreach ($target in $targets) { $listeners = Get-NetTCPConnection -LocalPort $target.Port -State Listen -ErrorAction SilentlyContinue; foreach ($listener in $listeners) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess); if ($process -and $process.CommandLine -match $target.Pattern) { Stop-Process -Id $listener.OwningProcess -Force; Write-Output ('   Stopped stale PrimeStack process on port ' + $target.Port) } } }"

REM RUN_PLATFORM.bat builds the latest API then starts the local services.
start "PrimeStack Platform" /min cmd /c "call RUN_PLATFORM.bat"

echo   Waiting for the platform to become healthy...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline = (Get-Date).AddMinutes(5); do { $ready = $true; foreach ($port in @(9004,9005,9006,9009)) { try { $null = Invoke-WebRequest -UseBasicParsing -Uri ('http://localhost:' + $port + '/health') -TimeoutSec 3 } catch { $ready = $false; break } }; if ($ready) { exit 0 }; Start-Sleep -Seconds 3 } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
    echo   WARNING: one or more platform services did not report healthy in time.
    echo            Check the minimized "PrimeStack Platform" window for details.
) else (
    echo   OK: website, merchant, admin and API are healthy.
)

REM Audible "ready" cue.
powershell -NoProfile -Command "[console]::beep(800,300); Start-Sleep -m 200; [console]::beep(1000,300); Start-Sleep -m 200; [console]::beep(1200,500)" 2>nul

echo.
echo ============================================
echo   PRIMESTACK SWITCH IS RUNNING
echo.
echo   Public Website:
echo     Website:     http://localhost:9004
echo.
echo   Dashboards:
echo     Merchant:    http://localhost:9005/merchant-login
echo     Admin:       http://localhost:9006/login
echo     Agent:       http://localhost:9006/agent-portal
echo.
echo   API Endpoints:
echo     Health:      http://localhost:9009/health
echo     Gateway:     http://localhost:9024/health
echo.
echo   Microservices (Docker):
echo     9010  Ledger Service          9018  Notification Service
echo     9011  IP Whitelist            9019  Switch Core
echo     9012  Auth Service            9020  Security Service
echo     9013  Terminal Service (TMS)  9021  Routing Engine
echo     9014  Transfer Service        9022  ISO 8583 Gateway
echo     9015  Risk Engine             9023  Crypto Payout Service
echo     9016  Audit Service           9024  API Gateway (external)
echo     9017  Settlement Engine
echo.
echo   Stop:    stop-primestack.bat
echo   Rebuild: start-primestack.bat rebuild
echo   Logs:    cd services ^&^& docker compose logs -f
echo ============================================
echo.

start "" "http://localhost:9004/"
start "" "http://localhost:9005/merchant-login"
start "" "http://localhost:9006/login"

echo Website and portal sign-in pages opened in your browser.
echo Keep this window open. Close it to stop.
pause
exit /b 0

REM -- Subroutine: wait until a container reports healthy (bounded) ---
:waitHealthy
set "CONTAINER=%~1"
set /a "MAXSEC=%~2"
set /a "elapsed=0"
:healthloop
set "HSTAT="
for /f "usebackq tokens=*" %%s in (`docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" %CONTAINER% 2^>nul`) do set "HSTAT=%%s"
if /i "!HSTAT!"=="healthy" (
    echo   OK: %CONTAINER% is healthy.
    exit /b 0
)
set /a elapsed+=2
if !elapsed! GEQ %MAXSEC% (
    echo   WARNING: %CONTAINER% not healthy after %MAXSEC%s ^(status: !HSTAT!^).
    exit /b 0
)
timeout /t 2 /nobreak >nul
goto :healthloop

:fail
echo.
echo   Startup aborted. Fix the issue above and run this again.
echo.
pause
exit /b 1
