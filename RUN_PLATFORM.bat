@echo off
setlocal
title PrimeStack Platform
color 0b
cd /d "%~dp0"

set "PORT=9009"
set "API_PORT=9009"
set "MULTI_PORTAL=true"
set "WEBSITE_PORT=9004"
set "MERCHANT_PORT=9005"
set "DASHBOARD_PORT=9005"
set "ADMIN_PORT=9006"
set "DASHBOARD_ORIGIN=http://localhost:9005"
set "MERCHANT_PORTAL_ORIGIN=http://localhost:9005"
set "RAILS_PORT=9007"
set "ISO20022_PORT=9008"

set "INBOUND_WEBHOOK_SECRET=dev-inbound-webhook-secret-change-me"
set "INBOUND_WEBHOOK_MAX_TIMESTAMP_DRIFT_MS=300000"
set "INBOUND_FUNDING_ACCOUNT_PREFIX=SYSTEM-FUNDING"
set "T2T_NOTIFY_TIMEOUT_MS=5000"

set "WISE_VIRTUAL_ACCOUNTS_ENABLED=true"
set "WISE_VIRTUAL_ACCOUNT_PROVISIONING_ENABLED=true"

set "TRUSTED_PROXIES="

echo ============================================
echo   PrimeStack Platform
echo   Website 9004 ^| Merchant 9005 ^| Admin 9006
echo   API 9009 ^| Rails 9007 ^| ISO 20022 9008
echo ============================================
echo.

echo Killing any process already on port 9009...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9009 " ^| findstr "LISTENING"') do (
    echo   Stopping PID %%a
    taskkill /F /PID %%a >nul 2>&1
)
echo Done.
echo.

echo Generating the Prisma client...
call npm run prisma:generate
if errorlevel 1 (
  echo Prisma client generation failed.
  pause
  exit /b 1
)

echo.
echo Building the latest API...
call npm run build
if errorlevel 1 (
  echo API build failed.
  pause
  exit /b 1
)

echo.
echo Starting platform... keep this window open.
echo.
echo   Admin:    http://localhost:9006/login
echo   Merchant: http://localhost:9005/merchant-login
echo   Website:  http://localhost:9004
echo.

node start-platform.mjs

echo.
echo Platform stopped. Press any key to close.
pause >nul