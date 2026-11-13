@echo off
setlocal
title PrimeStack Switch - Shutdown
color 0C

echo.
echo  ================================================================
echo  Stopping PrimeStack Switch...
echo  ================================================================
echo.

echo  Stopping the PrimeStack website and dashboard applications...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$targets = @(@{Port=9004; Pattern='start-public-site\.js'}, @{Port=9005; Pattern='start-dashboard\.js|start-platform\.mjs'}); foreach ($target in $targets) { $listeners = Get-NetTCPConnection -LocalPort $target.Port -State Listen -ErrorAction SilentlyContinue; foreach ($listener in $listeners) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess); if ($process -and $process.CommandLine -match $target.Pattern) { Stop-Process -Id $listener.OwningProcess -Force; Write-Output ('  PrimeStack website/dashboard stopped on port ' + $target.Port) } } }"
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
echo  Cleaning up unused Docker resources...
docker system prune -f 2>nul

echo.
echo  ================================================================
echo  All PrimeStack services stopped.
echo  ================================================================
echo.
pause
