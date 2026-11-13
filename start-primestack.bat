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

REM -- Step 4: Start public website and dashboard + beep + open browser --
echo [4/4] Starting public website on port 9004 and dashboard on port 9005...
cd /d "d:\PrimeStack Asset Gateway"

set "WEBSITE_PORT=9004"
set "DASHBOARD_PORT=9005"
set "SERVE_PUBLIC_SITE=false"

REM Stop only existing PrimeStack website/dashboard processes on these ports.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports = @(9004,9005); foreach ($port in $ports) { $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; foreach ($listener in $listeners) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess); if (($port -eq 9004 -and $process.CommandLine -match 'start-public-site\.js') -or ($port -eq 9005 -and $process.CommandLine -match 'start-dashboard\.js|start-platform\.mjs')) { Stop-Process -Id $listener.OwningProcess -Force; Write-Output ('  Stopped existing PrimeStack process on port ' + $port) } } }"

REM Start dashboard server in a minimized window (more reliable than start /b with redirection)
start "PrimeStack Dashboard" /min cmd /c "node start-dashboard.js"
start "PrimeStack Website" /min cmd /c "node start-public-site.js"

echo Waiting 5 seconds for website and dashboard to start...
timeout /t 5 /nobreak >nul

REM Verify both web servers are running.
curl -fsS http://localhost:9005/health >nul 2>&1
if errorlevel 1 (
    echo WARNING: Dashboard may not have started. Check if Node.js is on PATH.
    echo You can start it manually: node start-dashboard.js
) else (
    echo OK: Dashboard is running on port 9005
)
curl -fsS http://localhost:9004/health >nul 2>&1
if errorlevel 1 (
    echo WARNING: Public website may not have started. Try: npm run website
) else (
    echo OK: Public website is running on port 9004
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
echo     Operations:  http://localhost:9005/ops
echo     Admin:       http://localhost:9005/admin/dashboard
echo     Merchant:    http://localhost:9005/admin/merchant-dashboard
echo.
echo   API Endpoints:
echo     Health All:  http://localhost:9005/admin/health-all
echo     Live Data:   http://localhost:9005/admin/live-data
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

REM Open the public website and operations hub in the browser.
start "" "http://localhost:9004/"
start "" "http://localhost:9005/ops"

REM Wait 2 seconds then open admin dashboard too
timeout /t 2 /nobreak >nul
start "" "http://localhost:9005/admin/dashboard"

echo Operations hub opened in browser.
echo Keep this window open. Close it to stop.
pause
