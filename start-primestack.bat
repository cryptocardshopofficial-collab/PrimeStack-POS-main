@echo off
title PrimeStack Switch
color 0b
mode con: cols=100 lines=45

echo.
echo ============================================
echo   PrimeStack Switch - Payment Platform
echo   14 Services ^| 16 Migrations ^| 9 Tests
echo ============================================
echo.

REM -- Step 1: Check Docker --
echo [1/4] Checking Docker...
where docker >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker not found on PATH.
    echo Adding Docker to PATH...
    set "PATH=C:\Users\prime\AppData\Local\Programs\DockerDesktop\resources\bin;%PATH%"
)
docker --version 2>nul
if errorlevel 1 (
    echo Docker is not running. Please start Docker Desktop first.
    echo.
    pause
    exit /b 1
)
echo OK: Docker is available
echo.

REM -- Step 2: Start infrastructure --
echo [2/4] Starting infrastructure (PostgreSQL, Redis, RabbitMQ)...
cd /d "d:\PrimeStack Asset Gateway\services"
docker compose up -d postgres redis rabbitmq 2>nul
echo Waiting 10 seconds for databases...
timeout /t 10 /nobreak >nul
echo OK: Infrastructure running
echo.

REM -- Step 3: Start all 14 services --
echo [3/4] Building and starting 14 services...
echo First run takes 3-5 minutes to build Docker images.
echo.
docker compose up -d --build

echo.
echo Waiting for services to start...
set count=0
:waitloop
timeout /t 5 /nobreak >nul
set /a count+=1
for /f "tokens=*" %%i in ('docker compose ps --format "{{.Status}}" 2^>nul ^| find /c "Up"') do set running=%%i
echo   Check %count%/24 - Running containers: %running%
if %running% GEQ 14 (
    echo All services are up!
    goto ready
)
if %count% LSS 24 goto waitloop
echo Timeout: Some services may still be starting.

:ready
echo.
echo Service Status:
echo ----------------------------------------------
docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>nul
echo.

REM -- Step 4: Start website, merchant dashboard, admin dashboard, and API --
echo [4/4] Starting website 9004, merchant 9005, admin 9006, and API 9009...
cd /d "%~dp0"

REM Stop only existing PrimeStack processes on the assigned ports.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$targets = @(@{Port=9004; Pattern='start-public-site\.js'}, @{Port=9005; Pattern='start-dashboard\.js'}, @{Port=9006; Pattern='start-dashboard\.js'}, @{Port=9009; Pattern='start-platform\.mjs'}); foreach ($target in $targets) { $listeners = Get-NetTCPConnection -LocalPort $target.Port -State Listen -ErrorAction SilentlyContinue; foreach ($listener in $listeners) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess); if ($process -and $process.CommandLine -match $target.Pattern) { Stop-Process -Id $listener.OwningProcess -Force; Write-Output ('  Stopped existing PrimeStack process on port ' + $target.Port) } } }"

REM RUN_PLATFORM builds the latest API and starts the four local services.
start "PrimeStack Platform" /min cmd /c "call RUN_PLATFORM.bat"

echo Waiting for the platform build and services to start...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline = (Get-Date).AddMinutes(5); do { $ready = $true; foreach ($port in @(9004,9005,9006,9009)) { try { $null = Invoke-WebRequest -UseBasicParsing -Uri ('http://localhost:' + $port + '/health') -TimeoutSec 3 } catch { $ready = $false; break } }; if ($ready) { exit 0 }; Start-Sleep -Seconds 5 } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
    echo WARNING: One or more platform services did not become healthy.
) else (
    echo OK: Website, merchant dashboard, admin dashboard, and API are healthy.
)

REM Beep 3 times
powershell -command "[console]::beep(800,300); Start-Sleep -m 200; [console]::beep(1000,300); Start-Sleep -m 200; [console]::beep(1200,500)"

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
echo   Services (all on Docker):
echo     9010  Ledger Service
echo     9011  IP Whitelist
echo     9012  Auth Service
echo     9013  Terminal Service (TMS)
echo     9014  Transfer Service
echo     9015  Risk Engine
echo     9016  Audit Service
echo     9017  Settlement Engine
echo     9018  Notification Service
echo     9019  Switch Core
echo     9020  Security Service
echo     9021  Routing Engine
echo     9022  ISO 8583 Gateway
echo     9023  Crypto Payout Service
echo     9024  API Gateway (external)
echo.
echo   Stop:  stop-primestack.bat
echo   Logs:  cd services ^&^& docker compose logs -f
echo ============================================
echo.

REM Open the website and separate portal sign-in pages.
start "" "http://localhost:9004/"
start "" "http://localhost:9005/merchant-login"
start "" "http://localhost:9006/login"

echo Website and portal sign-in pages opened in browser.
echo Keep this window open. Close it to stop.
pause
