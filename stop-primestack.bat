@echo off
setlocal
title PrimeStack Switch - Shutdown
color 0C

REM ============================================================
REM  PrimeStack Switch - shutdown
REM
REM  Stops the local platform, the microservices stack and the
REM  host infrastructure. Docker volumes (your data) are always
REM  preserved. The build cache is also kept so the next start is
REM  fast - pass "prune" to also reclaim image/network space.
REM
REM  Usage:  stop-primestack.bat           (keep cache - fast restart)
REM          stop-primestack.bat prune     (also prune Docker cache)
REM ============================================================

echo.
echo  ================================================================
echo  Stopping PrimeStack Switch...
echo  ================================================================
echo.

echo  Stopping the PrimeStack website, dashboards, and API...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$targets = @(@{Port=9004; Pattern='start-public-site\.js'}, @{Port=9005; Pattern='start-dashboard\.js'}, @{Port=9006; Pattern='start-dashboard\.js'}, @{Port=9009; Pattern='start-platform\.mjs'}); foreach ($target in $targets) { $listeners = Get-NetTCPConnection -LocalPort $target.Port -State Listen -ErrorAction SilentlyContinue; foreach ($listener in $listeners) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess); if ($process -and $process.CommandLine -match $target.Pattern) { Stop-Process -Id $listener.OwningProcess -Force; Write-Output ('  PrimeStack service stopped on port ' + $target.Port) } } }"
echo.

echo  Stopping microservices...
cd /d "%~dp0services"
docker compose down 2>nul
echo  OK: Services stopped

echo.
echo  Stopping infrastructure...
cd /d "%~dp0"
docker compose down 2>nul
echo  OK: Infrastructure stopped

echo.
if /i "%~1"=="prune" (
    echo  Reclaiming unused Docker resources ^(build cache, networks^)...
    docker system prune -f 2>nul
) else (
    echo  Keeping the Docker build cache so the next start is fast.
    echo  ^(run "stop-primestack.bat prune" to reclaim that space^)
)

echo.
echo  ================================================================
echo  All PrimeStack services stopped. Your data volumes are intact.
echo  ================================================================
echo.
pause
