// start-platform.mjs — single-service launcher.
//
// Runs the whole platform inside ONE Render web service:
//   1. the PrimeStack Fastify API (src/ → dist/server.js) on an internal port
//   2. the operator console (start-dashboard.js) on the public PORT
//
// The console proxies every /api/* call to the internal API, signing the
// request with the console HMAC key and replaying the operator session.
import { setTimeout as delay } from 'node:timers/promises';

const PUBLIC_PORT = process.env.PORT || '9005';
const API_PORT = process.env.API_PORT || '9006';

// The console reads these at import time.
process.env.API_PORT = API_PORT;
// This launcher owns the API process, so ignore inherited URLs for retired services.
process.env.PRIMESTACK_API_URL = `http://127.0.0.1:${API_PORT}`;

// The API resolves its listen port from PORT — set it before importing.
process.env.PORT = API_PORT;
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

// Payment rails service (Wise pass-through) — in-memory, no database.
const RAILS_PORT = process.env.RAILS_PORT || '9007';
process.env.RAILS_PORT = RAILS_PORT;
await import('./rails-service.js');
console.log(`[platform] Payment rails service on 127.0.0.1:${RAILS_PORT}`);

// ISO 20022 engine — message generation, validation, and acknowledgement.
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
  : '[platform] WARNING: API did not answer /health — starting console anyway');

// Hand PORT back to the console.
process.env.PORT = PUBLIC_PORT;
await import('./start-dashboard.js');
