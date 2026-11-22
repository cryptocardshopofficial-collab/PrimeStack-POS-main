// start-platform.mjs ΓÇö local multi-portal and single-service launcher.
//
// Runs the API and supporting services alongside separate website, merchant,
// and admin HTTP servers when MULTI_PORTAL=true; otherwise it preserves the
// single dashboard server used by hosted deployments.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const WEBSITE_PORT = process.env.WEBSITE_PORT || '9004';
const MERCHANT_PORT = process.env.MERCHANT_PORT || process.env.DASHBOARD_PORT || '9005';
const ADMIN_PORT = process.env.ADMIN_PORT || '9006';
const API_PORT = process.env.API_PORT || '9009';
const SINGLE_PORT = process.env.PORT || '9005';
const MULTI_PORTAL = process.env.MULTI_PORTAL === 'true';
const MERCHANT_PORTAL_ORIGIN =
  process.env.MERCHANT_PORTAL_ORIGIN || `http://127.0.0.1:${MERCHANT_PORT}`;
const children = new Set();
let shuttingDown = false;

function stopChildren() {
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, stopChildren);
}

process.env.API_PORT = API_PORT;
process.env.PRIMESTACK_API_URL = `http://127.0.0.1:${API_PORT}`;
process.env.PORT = process.env.PORT || API_PORT;
await import('./dist/server.js');
console.log(`[platform] Fastify API starting on internal port ${API_PORT}`);

async function waitForApi(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/health`);
      if (res.ok) return true;
    } catch { /* not listening yet */ }
    await delay(500);
  }
  return false;
}

// Payment rails service (Wise pass-through) ΓÇö in-memory, no database.
const RAILS_PORT = process.env.RAILS_PORT || '9007';
process.env.RAILS_PORT = RAILS_PORT;
await import('./rails-service.js');
console.log(`[platform] Payment rails service on 127.0.0.1:${RAILS_PORT}`);

// ISO 20022 engine ΓÇö message generation, validation, and acknowledgement.
// It reads ISO20022_PORT (not PORT), so this does not disturb the console port.
// Ledger posting stays disabled until ISO20022_LEDGER_HMAC_SECRET is set to a
// secret of at least 32 bytes; the engine logs that on start.
const ISO20022_PORT = process.env.ISO20022_PORT || '9008';
process.env.ISO20022_PORT = ISO20022_PORT;
await import('./iso20022-engine.js');
console.log(`[platform] ISO 20022 engine on 127.0.0.1:${ISO20022_PORT}`);

const apiReady = await waitForApi();
console.log(apiReady
  ? '[platform] API health check passed'
  : '[platform] WARNING: API did not answer /health ΓÇö starting portals anyway');

function startService(name, script, environment) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(script, import.meta.url))],
    {
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    },
  );
  children.add(child);
  child.on('error', (error) => {
    console.error(`[platform] Failed to start ${name}: ${error.message}`);
    process.exitCode = 1;
    stopChildren();
    process.kill(process.pid, 'SIGTERM');
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(
        `[platform] ${name} stopped unexpectedly (code ${code}, signal ${signal})`,
      );
      process.exitCode = code || 1;
      stopChildren();
      process.kill(process.pid, 'SIGTERM');
    }
  });
  return child;
}

if (!MULTI_PORTAL) {
  process.env.PORT = SINGLE_PORT;
  await import('./start-dashboard.js');
} else {
  const apiEnvironment = {
    API_PORT,
    PRIMESTACK_API_URL: `http://127.0.0.1:${API_PORT}`,
    MERCHANT_PORT,
    ADMIN_PORT,
    MERCHANT_PORTAL_ORIGIN,
  };

  startService('merchant dashboard', './start-dashboard.js', {
    ...apiEnvironment,
    PORT: MERCHANT_PORT,
    PORTAL_MODE: 'merchant',
  });
  startService('admin dashboard', './start-dashboard.js', {
    ...apiEnvironment,
    PORT: ADMIN_PORT,
    PORTAL_MODE: 'admin',
  });
  startService('public website', './start-public-site.js', {
    WEBSITE_PORT,
    DASHBOARD_PORT: MERCHANT_PORT,
    DASHBOARD_ORIGIN: MERCHANT_PORTAL_ORIGIN,
  });
}
