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

rem --- Inbound real-funds webhook + signed outbound sender notice ---
rem T2T_NOTIFY_SECRET falls back to INBOUND_WEBHOOK_SECRET, so one local secret signs both directions.
set "INBOUND_WEBHOOK_SECRET=dev-inbound-webhook-secret-change-me"
set "INBOUND_WEBHOOK_MAX_TIMESTAMP_DRIFT_MS=300000"
set "INBOUND_FUNDING_ACCOUNT_PREFIX=SYSTEM-FUNDING"
set "T2T_NOTIFY_TIMEOUT_MS=5000"

rem --- Wise virtual accounts (set to true and add WISE_API_KEY/WISE_PROFILE_ID to provision real accounts) ---
set "WISE_VIRTUAL_ACCOUNTS_ENABLED=true"
set "WISE_VIRTUAL_ACCOUNT_PROVISIONING_ENABLED=true"

rem --- Reverse-proxy trust (leave empty locally; set to real proxy CIDRs when hosted behind Render/nginx) ---
set "TRUSTED_PROXIES="

echo ============================================
echo   PrimeStack Platform
echo   Website 9004 ^| Merchant 9005 ^| Admin 9006
echo   API 9009 ^| Rails 9007 ^| ISO 20022 9008
echo ============================================
echo.
echo Generating the Prisma client...
call npm run prisma:generate
if errorlevel 1 (
  echo.
  echo Prisma client generation failed. Fix the Prisma errors before starting the platform.
  pause
  exit /b 1
)

echo.
echo Building the latest API...
call npm run build
if errorlevel 1 (
  echo.
  echo API build failed. Fix the build errors before starting the platform.
  pause
  exit /b 1
)

echo.
echo Starting... keep this window open to keep the platform running.
echo.

node start-platform.mjs

echo.
echo Platform stopped. Press any key to close.
pause >nul
