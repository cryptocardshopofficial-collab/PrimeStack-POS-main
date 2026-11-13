# PrimeStack Global Server Network — Setup Guide

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20+ | Runtime |
| Docker | Any | PostgreSQL + Redis |
| npm | 9+ | Package manager |

---

## 1. Install Dependencies

```powershell
npm install
```

If the install is slow, try:
```powershell
npm install --prefer-offline
# or with legacy peer deps if you hit conflicts:
npm install --legacy-peer-deps
```

---

## 2. Start Infrastructure

```powershell
docker compose up -d
```

This starts:
- **PostgreSQL 16** on `localhost:5432` (user: `primestack`, pass: `primestack`, db: `primestack`)
- **Redis 7** on `localhost:6379`

Wait ~10 seconds, then verify:
```powershell
docker compose ps
```

---

## 3. Environment Configuration

Review `.env` and configure local PostgreSQL, Redis, and development-only secrets before starting. If creating it from `.env.example`, inspect each value and replace placeholders with values appropriate for your local environment. Never deploy example credentials or commit `.env`.

For production, update these values in `.env`:
```
JWT_SECRET=<256-bit random key>
DATABASE_URL=<your PostgreSQL connection string>
REDIS_HOST=<your Redis host>
REDIS_PASSWORD=<your Redis password>
```

---

## 4. Generate Prisma Client

```powershell
npx prisma generate
```

---

## 5. Create Database Tables

```powershell
npx prisma db push
```

This creates all 30+ tables from `prisma/schema.prisma`. For production, use migrations instead:
```powershell
npx prisma migrate dev --name init
```

---

## 6. Seed Initial Data

```powershell
$env:SEED_ADMIN_PASSWORD = Read-Host "Development admin password (16+ characters)"
node --import dotenv/config --import tsx .\prisma\seed.ts
Remove-Item Env:\SEED_ADMIN_PASSWORD
```

The seed creates a development admin account with email `admin@primestack.io`, a sample merchant, system ledger accounts, and development records. The admin password is the value supplied as `SEED_ADMIN_PASSWORD`; there is no fixed default password. Review seed output for any generated development credentials and keep them private. Do not seed production data.

---

## 7. Start the Server

```powershell
npm run dev
```

Output:
```
[INFO] Database connected
[INFO] Redis connected
[INFO] i18n initialized { languages: ['en','fr','es','ar','pt'] }
[INFO] Fastify application configured
[INFO] PrimeStack Global Server Network started — development mode { port: 9006 }
[INFO] API documentation available at /docs
```

---

## 8. Verify It's Running

```powershell
# Health check
Invoke-WebRequest http://localhost:9006/health | Select-Object -ExpandProperty Content

# Or visit in browser:
# http://localhost:9006/docs      — Swagger UI
# http://localhost:9006/api-gateway/info  — API overview
```

The public website and operator dashboard run independently on separate ports.
Start each command in its own terminal:

```powershell
npm start                 # API on port 9006
node start-dashboard.js   # operator dashboard on port 9005
npm run website           # public website on port 9004
```

The public website's sign-in and API requests are routed through the dashboard,
but the dashboard no longer serves the public marketing pages. The Render
Blueprint likewise deploys `primestack-platform` (dashboard + API) and
`primestack-public-site` as separate web services. Render assigns each service
its own URL; the public-site service receives the dashboard URL automatically.
The existing `primestack-website` static site remains the documentation site
served from `./docs`.

---

## Testing with Postman

1. Import `primestack-global-server-network.postman_collection.json` into Postman
2. Set the collection variable `base_url` to `http://localhost:9006`
3. Run **Admin → Login** first — it auto-saves the JWT token
4. Set `merchant_id` to the ID of a created merchant
5. Explore all 15 modules from the collection

---

## Terminal-to-Terminal (T2T) Production Requirements

T2T transfers require an active source and destination terminal owned by the
same merchant, plus an active ledger account for each terminal in the selected
currency. The API does not create missing terminal accounts. Per-transfer
amounts are limited to `10,000,000` currency units and at most four decimal
places; only currencies provisioned on both accounts are accepted.

`POST /t2t/transfer` requires:

- PrimeStack HMAC headers: `x-primestack-key-id`, `x-primestack-timestamp`
  (Unix milliseconds), `x-primestack-nonce` (unique, 16–128 URL-safe
  characters), and `x-primestack-signature`.
- `x-primestack-idempotency-key`, unique per logical transfer and 16–128
  characters.
- JSON body: `amount`, `currency`, `sourceId`, and `destId`. Optional
  `description` is limited to 500 characters.

The signature is HMAC-SHA256 over
`keyId + timestamp + nonce + JSON.stringify(parsedRequestBody)`. Reuse the
same idempotency key only for retries with the same transfer details.
Successful posting, the double-entry journal, balance updates, and audit record
are committed atomically. Transfer requests are limited to 100 per minute and
require Redis for distributed rate limiting and replay protection.

Administrators manage the IP allowlist using JWT-authenticated
`POST /t2t/whitelist`; the route supports `{"ip":"203.0.113.10","action":"add"}`
and `"remove"`. In production, set `TRUSTED_PROXIES` to only the proxy IP
addresses/CIDRs actually used by the deployment. Do not trust arbitrary
forwarded headers or use `0.0.0.0/0`; if unset, forwarded IPs are ignored and
the allowlist checks the socket peer address. Apply migrations with
`npx prisma migrate deploy` before enabling T2T.

---

## Common Issues

### `Error: Missing required environment variable`
The `.env` file is missing or not loaded. Copy `.env.example` to `.env`.

### `Can't reach database server`
Docker containers aren't running. Run `docker compose up -d` and wait 10 seconds.

### `P1001: Can't reach database server`
Prisma can't connect. Check `DATABASE_URL` in `.env` matches your Docker setup.

### `npm install` hangs
Network issue. Try:
```powershell
npm install --prefer-offline --no-audit --no-fund
```
Or configure a faster npm mirror:
```powershell
npm config set registry https://registry.npmmirror.com
npm install
```

---

## Project Structure

```
primestack-global-server-network/
├── prisma/
│   ├── schema.prisma       # Full database schema (30+ models)
│   └── seed.ts             # Initial data seeder
├── src/
│   ├── server.ts           # Entry point
│   ├── app.ts              # Fastify app + all 15 modules registered
│   ├── config/             # Environment config
│   ├── core/               # DB, Redis, logger, i18n, errors, decimal
│   ├── plugins/            # Fastify plugins (auth, i18n, IP whitelist, etc.)
│   ├── modules/            # 15 feature modules
│   │   ├── ledger/         # Double-entry accounting
│   │   ├── wallet/         # Digital wallets
│   │   ├── transfer/       # T2T, S2S, IP2IP, bulk transfers
│   │   ├── admin/          # Users, audit, KYC
│   │   ├── iso8583/        # ISO 8583 message engine
│   │   ├── terminal/       # Terminal management
│   │   ├── routing/        # Route rules, BIN routing
│   │   ├── switch-core/    # Auth, reversal, capture, settlement, chargebacks
│   │   ├── fraud/          # Velocity, blacklist, AML, risk scoring
│   │   ├── treasury/       # Float, liquidity, reserves
│   │   ├── monitoring/     # Dashboard, live feeds
│   │   ├── notifications/  # Multi-channel with i18n
│   │   ├── network/        # IP whitelist, HMAC, API keys, certs
│   │   ├── merchant/       # Merchant onboarding, stats
│   │   └── api-gateway/    # Webhooks, request logs, developer portal
│   ├── shared/             # Response helpers, crypto utils
│   └── locales/            # i18n translations (en, fr, es, ar, pt)
├── .kiro/
│   ├── hooks/              # Kiro automation hooks
│   └── steering/           # Kiro project context
├── .env                    # Local environment (not committed)
├── .env.example            # Environment template
├── docker-compose.yml      # PostgreSQL + Redis
├── primestack-global-server-network.postman_collection.json
└── SETUP.md                # This file
```

---

## Adding a New Module

1. Create `src/modules/<name>/` with:
   - `types.ts` — Zod schemas + TypeScript types
   - `<name>.service.ts` — Business logic
   - `<name>.routes.ts` — Fastify route handlers
   - `<name>.module.ts` — Exports service singleton, registers routes

2. In `<name>.module.ts`:
   ```typescript
   import { prisma } from "../../core/database.js";
   export const myService = new MyService(prisma);
   export function registerMyModule(app: FastifyInstance) {
     registerMyRoutes(app, myService);
   }
   ```

3. In `src/app.ts`:
   ```typescript
   import { registerMyModule } from "./modules/<name>/<name>.module.js";
   // ...
   registerMyModule(app);
   ```

4. Export from `src/modules/index.ts`

---

## Scaling to Microservices

When you're ready to extract a module:
1. Each module has clear boundaries and its own service class
2. The ledger is the hardest to extract — do it last
3. Replace direct service imports with HTTP clients or a message broker (NATS/Kafka)
4. The Prisma schema can be split per-service with foreign keys replaced by IDs

---

## Production Checklist

- [ ] Replace JWT_SECRET with 256-bit random key
- [ ] Set Redis password
- [ ] Remove `0.0.0.0/0` from IP whitelist (seed adds it for dev only)
- [ ] Run `npx prisma migrate dev` instead of `prisma db push`
- [ ] Configure TLS certificates for API gateway
- [ ] Enable HMAC key rotation schedule
- [ ] Set up log aggregation (Pino sends JSON — works with Datadog/Splunk/CloudWatch)
- [ ] Configure webhook delivery worker (current implementation queues to Redis — needs a consumer)
- [ ] Review and tighten fraud velocity rules for your transaction volumes
- [ ] Enable MFA for admin users
