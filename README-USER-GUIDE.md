# PrimeStack Operations and Dashboard User Guide

**Last updated: 2026-11-09**

This guide explains what is in this repository, how to start a local development instance, where to find the admin and merchant screens, and how the implemented send and receive APIs work.

> **Development and integration software only.** This project is not certified as a bank, payment processor, wallet custodian, or production-ready financial service. Do not enter real card data, bank credentials, customer documents, or real funds. A successful response from an internal API does not prove that a bank or external processor moved or settled money.

## 1. What this software does

PrimeStack is a collection of related but separate software components:

1. **Root API (`src/`)** - a TypeScript/Fastify API backed by PostgreSQL and Redis. It includes merchant and wallet records, internal transfers, a double-entry ledger, card transaction lifecycle records, routing/risk foundations, settlement tools, and admin APIs.
2. **Public website (`public-site.html`)** - the marketing site served by `start-dashboard.js`. Its navigation pages describe the platform; they are not checkout pages or authenticated customer accounts.
3. **Standalone dashboard (`start-dashboard.js`)** - a separate Node.js server with operations and merchant-demo pages. It has its own proxy/runtime and is not the root API.
4. **Service stack (`services/`)** - separately packaged services with their own deployment and data model. It is not automatically connected to the root app.
5. **Supporting tools** - ISO 20022 message/draft tools, ISO 8583 code, developer pages, integration examples, and documentation. A message template or draft is not a transmitted payment.

Pick one runtime and follow its documentation. The root API, standalone dashboard, and containerized services must not be assumed to share the same database, accounts, API routes, or authentication.

## 2. Start a local development API

The root Fastify API is the recommended starting point for testing the implemented API.

1. Install Node.js 20+, npm, and Docker Desktop.
2. Read [SETUP.md](./SETUP.md), and configure a local `.env` with a local PostgreSQL database, Redis, and a development-only JWT secret. Use your own random values; never deploy sample credentials.
3. From the repository root, start the database and cache:

   ```powershell
   docker compose up -d
   ```

4. Install dependencies and prepare the local schema:

   ```powershell
   npm install
   npm run prisma:generate
   npm run prisma:push
   ```

   `prisma:push` is for disposable local development only. For an existing database or deployment, follow the migration instructions in [README.md](./README.md) and back up the database first.

5. If you need seeded development data, set `SEED_ADMIN_PASSWORD` in your shell to a unique password with at least 16 characters, then run the seed script with `.env` loading enabled:

   ```powershell
   $env:SEED_ADMIN_PASSWORD = Read-Host "Development admin password (16+ characters)"
   node --import dotenv/config --import tsx .\prisma\seed.ts
   Remove-Item Env:\SEED_ADMIN_PASSWORD
   ```

   The seed script creates a sample merchant and development data. It does not provide a fixed default admin password. Keep any generated API credentials private.
6. Start the API:

   ```powershell
   npm run dev
   ```

7. Check `http://localhost:9006/health`, then open `http://localhost:9006/docs` for the live Swagger request schemas and available API operations.

For local development, the public website runs on port 9004 (`npm run website`), the console/dashboard runs on port 9005 (`node start-dashboard.js`), and the root API runs on port 9006 (`npm run dev`). The website proxies its API requests through the dashboard so existing authentication and API routing remain intact. The standalone dashboard is not required for API testing. The Fastify HTML shells at `/admin/...` are not a guarantee that every operation is available or that every screen is a finished production portal.

The Render `start-platform.mjs` deployment remains a single public service on
Render's assigned `PORT`; it keeps the website and console routes together and
the API on its internal `API_PORT`.

## 3. Admin dashboard and operations

### Sign in to the API

The root API's admin login endpoint is `POST /admin/login`. Use the development admin account created by your local seed, or an account provisioned by your deployment administrator. Never rely on a committed/default password.

1. Open Swagger at `/docs` or use the Postman collection.
2. Submit `POST /admin/login` with the admin email and password.
3. Use the returned JWT as `Authorization: Bearer <token>` for protected admin API calls.
4. Sign out by discarding the token. Treat the token like a password.

### Admin pages

Depending on which modules are enabled, the root Fastify app provides pages such as:

| Page | URL | What it is for |
|---|---|---|
| Command center | `/admin/dashboard` | Admin overview and operational navigation |
| Merchant acquiring | `/admin/merchant-dashboard` | Merchant registry, onboarding, review, and acquiring operations |
| Merchant home preview | `/admin/merchant-home` | Admin-oriented merchant home preview |
| Wallet center | `/admin/wallet-dashboard` | Admin wallet operations |
| PAG operations | `/admin/pag-dashboard` | Asset/network configuration and operational records |
| Developer platform | `/admin/developer-platform-dashboard` | Application and integration metadata, terminal/IP registration requests, and the customer Messages inbox |
| Agent registration | `/admin/agent-registration-dashboard` | Create agent registration codes and approve or reject agent registrations |
| Governance | `/admin/governance-dashboard` | Governance record workflows |
| Intelligence | `/admin/intelligence-dashboard` | Read-only operational summaries |
| SWIFT draft | `/admin/swift-payout-draft` | Prepare an ISO 20022 draft; does not transmit funds |

Use the page navigation as a starting point, then verify every action and permission in Swagger. Some pages return public HTML while the data-changing API calls behind them require JWT authentication and specific roles. Do not assume that opening a page means you are signed in.

### Typical merchant onboarding review

1. Sign in as an authorized admin.
2. Open Merchant Acquiring and refresh the merchant registry.
3. Select a merchant or create a development merchant using the form and required fields.
4. Review the merchant's KYC document *references*, risk profile, status, merchant IDs, and terminal records.
5. Apply only the changes allowed for your admin role. KYC references are metadata; the system does not upload or securely store the underlying documents.
6. Confirm results through the page or the corresponding `/admin/merchants/...` API response.

Admin write permissions are role-gated. Keep admin credentials private, use least-privilege roles, and do not use this workflow for production onboarding until the deployment's identity, compliance, storage, and audit controls have been independently validated.

### Sender/IP registration and customer messages

1. An administrator creates an agent registration with a unique code in Agent Registration. New agent codes are pending and cannot be used until an administrator approves that agent.
2. The customer opens the Developer Portal sender registration form at `/developer`, enters the approved agent code and sender IP/terminal details, and may add an optional message for operations.
3. The server verifies that the exact agent code exists and is approved before saving the registration. Invalid or pending codes are rejected; there is no separate customer sign-in/account flow in this registration process.
4. An authorized administrator opens the Developer Platform dashboard, then selects **Messages** to view the submitted customer messages alongside the sender IP, customer, agent code, request status, and received time. The registration request also appears in the terminal registration list.
5. Review and approve or reject the request using the available admin actions. The form is for onboarding review only; approval does not itself configure an external terminal, whitelist an IP, or move funds.

Do not include passwords, API secrets, bank credentials, or other sensitive authentication material in the message field.

### Agent transaction hold/resume requests

The existing Agent Portal authenticates approved agents with their agent code and PIN. An agent may submit a reason-required hold request for an unsettled `AUTHORIZED` or `CAPTURED` transaction belonging to a merchant assigned to that agent. A resume request is available only for an unsettled transaction already in `ON_HOLD`.

Submitting either request does **not** change the transaction status. An administrator reviews requests in the Admin Command Center's **Agent hold/resume requests** section or through:

- `GET /admin/agent-transaction-requests`
- `POST /admin/agent-transaction-requests/:id/review` with `decision` (`APPROVE`, `REJECT`, or `REQUEST_INFO`) and mandatory `adminRemarks`

Agents can submit a hold request through `POST /public/agent-portal/transactions/:transactionId/hold-request` or a resume request through `POST /public/agent-portal/transactions/:transactionId/resume-request`. If an administrator requests more information, the agent can respond through `POST /public/agent-portal/transaction-control-requests/:id/respond`.

Approval moves a transaction to `ON_HOLD` or restores its prior `AUTHORIZED`/`CAPTURED` status. Approval is rejected if the transaction has changed or settled while awaiting review. Decisions and transaction history are recorded in the audit log. Apply the `20261116170000_agent_transaction_control` migration before using these routes.

This is an internal workflow foundation, not a payment-provider hold/cancel instruction. It cannot stop an external processor or reverse a settled payment.

## 4. Merchant views

There are two different things called a merchant dashboard:

### Standalone merchant demo

`start-dashboard.js` provides `/merchant`, `/merchant/send`, `/merchant/payout`, `/merchant/balance`, `/merchant/terminals`, `/merchant/keys`, `/merchant/payment-link`, `/merchant/bank-connect`, and related pages.

These are standalone demo/preview screens, not an authenticated merchant portal. Do not expose this server to untrusted networks or enter real credentials or payment details. In particular:

- The payment-link list is stored in browser memory and is lost when the page is reloaded.
- The displayed bank and crypto payout forms are not proof of an external payout integration.
- Some send forms use request fields that do not match the current root API contract. A button or success-style screen is not evidence that the root API or a bank processed the request.
- The standalone server uses its own proxy configuration; it does not automatically use the Fastify API's authentication rules.

Use these screens only for safe local UI exploration. For actual integration testing, use the root API and its exact Swagger schemas.

### Fastify merchant API

The root app does not provide a general merchant username/password session in the same way as an online banking portal. Merchant API routes use HMAC credentials and scope data to the merchant associated with the API key. Available merchant resources include:

- `GET /merchant/profile`
- `GET /merchant/transactions`
- `GET /merchant/terminals`
- `GET /merchant/settlements`
- `GET /merchant/balance`
- `GET /merchant/statements`
- `GET` and `POST /merchant/invoices`
- `GET` and `POST /merchant/payment-links`

KYC document endpoints store references/metadata, not uploaded files. Merchant-created invoices and payment-link records are not a connected checkout or payment collection service.

## 5. Sending funds

### Supported internal wallet transfer

For a ledger-backed wallet-to-wallet transfer in the root API:

1. Use a development merchant and two existing, active wallets with matching currency. Confirm the source has enough available balance.
2. Open `/docs` and review `POST /transfers` and its current schema.
3. Send a request using the documented transfer fields. Example body:

   ```json
   {
     "type": "WALLET",
     "amount": "25.00",
     "currency": "USD",
     "sourceType": "WALLET",
     "sourceId": "source-wallet-address",
     "destType": "WALLET",
     "destId": "destination-wallet-address",
     "description": "Development test transfer"
   }
   ```

4. Sign the request with an active merchant HMAC key. The default headers are `x-primestack-key-id`, `x-primestack-timestamp` (13-digit Unix milliseconds), `x-primestack-nonce` (unique, 16-128 URL-safe characters), and `x-primestack-signature`. The signature is HMAC-SHA256 over `keyId + timestamp + nonce + JSON.stringify(parsedRequestBody)` using the key's secret. Never put that secret in a browser or source file.
5. Check the API result and verify the transfer and ledger statement. A completed `/transfers` operation is an **internal ledger movement**, not a bank payment.

`POST /transfers` supports `T2T`, `S2S`, `IP2IP`, `WALLET`, `MERCHANT`, and `BULK` transfer types in its schema, but terminal transfers must use the dedicated `POST /t2t/transfer` route. See the [T2T requirements in SETUP.md](./SETUP.md#terminal-to-terminal-t2t-production-requirements) before testing terminal transfers. Bulk requests accept one to 1,000 items and may partially complete. Check `/docs` and the relevant service before using a transfer type other than a wallet transfer.

### Card transaction records

The card API has separate `POST /transactions/authorize`, `/transactions/capture`, and `/transactions/reverse` operations. Authorization validates local records and routing/risk rules; it does not contact an external card issuer. Capture records transaction state; settlement posts internal ledger entries according to the configured flow. Test only with approved dummy data. Never submit real card numbers.

## 6. Receiving funds

### Incoming server-to-server (S2S) payment

The root app's explicit incoming payment endpoint is `POST /s2s/connections/:id/receive`. It accepts a payment notification from a registered external server and credits an existing wallet inside the PrimeStack ledger. It does not independently confirm that the external server or a bank actually sent funds.

1. The merchant first registers a connection at `POST /s2s/connections` with an HTTPS `endpointUrl`, a strong shared `apiSecret` of at least 16 characters, supported currencies, and any limits or allowed IPs. The connection is created under the authenticated merchant.
2. Confirm the destination wallet exists, is `ACTIVE`, and uses the same currency as the incoming payment. Configure the connection's supported currency, limits, and IP allowlist to match the integration agreement.
3. The remote server calls `/s2s/connections/{connectionId}/receive` with JSON containing `amount`, `currency`, and `receiverWalletAddr`. Optional fields include `feeAmount`, `senderReference`, `senderAccountId`, and `metadata`.
4. The call needs the normal merchant `x-primestack-*` HMAC authentication **and** the S2S headers `x-s2s-timestamp` (Unix milliseconds), `x-s2s-nonce`, `x-s2s-idempotency-key`, and `x-s2s-signature`. S2S signatures use the connection secret and the canonical JSON fields `{connectionId, amount, currency, timestamp, nonce, senderReference}`. See the implementation and Swagger schema for exact canonical formatting; do not guess at signing or reuse a nonce.
5. On success, verify the returned payment reference/status and the recipient wallet statement. The ledger posting is atomic and idempotent by connection and idempotency key. A repeat with the same key returns the original payment rather than crediting it again.

Coordinate the signature and idempotency contract with the remote provider before sending requests. Do not test this endpoint with a real transfer unless both parties have completed security, reconciliation, and operational testing.

### Wallet funding is not external receipt

`POST /wallets/:address/fund` is an internal funding/ledger operation. It is **not** a bank deposit notification, card charge, or confirmation of external funds. Do not use it to mark a real-world payment as received. For bank and payment-provider receipts, a certified provider integration must verify the provider's authenticated notification and settlement state before any ledger credit.

## 7. Other common dashboard areas

| Area | How to use it | Limitation to remember |
|---|---|---|
| Balance and statements | Read the wallet or merchant balance/statement API and reconcile entries by reference and currency. | Internal ledger values are not automatically bank balances. |
| Terminals | Register and review terminal records through the admin tools and terminal APIs. | A terminal record is not a live/accredited device connection. |
| API keys | Use the secured credential lifecycle workflow; store the secret once in an approved secrets manager. | Never paste a merchant secret into the standalone dashboard, browser, logs, or this repository. |
| Payment links and invoices | Create/list merchant metadata records through `/merchant/payment-links` and `/merchant/invoices`. | Records alone do not provide hosted checkout, collect funds, or settle payments. |
| Settlement | Review captured transactions, batches, and ledger postings using the admin/API tools. | Internal settlement is not evidence of external bank settlement. |
| Bank connections | Review configured connection metadata and integration documentation. | The standalone bank directory is in-memory demo data; a TCP reachability test is not bank certification. |
| Risk, routing, and compliance | Review configured rules and decisions through the API/dashboard. | A rule or recommendation does not provide a complete AML, sanctions, regulatory, or fraud program. |
| ISO 20022 / SWIFT | Prepare or inspect message templates and drafts. | A generated message is not bank-validated, transmitted, accepted, or settled. |

## 8. Troubleshooting and safe operation

- **Cannot connect to the API:** confirm PostgreSQL and Redis are running, `.env` points to the local services, and the API process is listening on its configured port.
- **Port already in use:** the public website defaults to port 9004, `start-dashboard.js` to port 9005, and the root Fastify app to port 9006. Stop the process using the intended port or configure `WEBSITE_PORT`, `DASHBOARD_PORT`, or `PORT` as appropriate.
- **401 / missing HMAC headers:** merchant API calls require a valid active key, current timestamp, unique nonce, and correctly computed signature. Admin APIs instead use a bearer JWT.
- **403:** check the caller's role, merchant ownership, and configured IP allowlist.
- **Insufficient funds or account not found:** verify wallet/ledger account IDs, currency, account status, and source balance. Do not invent balances by calling a funding endpoint for an external payment.
- **Dashboard data is missing:** an HTML page can load even when its API or upstream service is unavailable. Check its runtime, network configuration, browser console, and `/docs`.
- **Before changing schema:** back up and test restoration. Use reviewed migrations for shared or production databases.
- **Before any deployment:** replace development configuration, rotate any exposed or reused keys, enforce HTTPS, configure trusted proxies and restricted CORS/IP rules, secure Redis and PostgreSQL, and obtain an independent security/compliance review.

## 9. Related references

- [Project README](./README.md) - architecture, runtime choices, modules, and known limitations.
- [Setup guide](./SETUP.md) - development installation and database preparation.
- [Phase 17 roadmap](./PHASE_17_IMPLEMENTATION_ROADMAP.md) - production readiness gates.
- [Service startup guide](./services/START.md) and [service architecture](./services/ARCHITECTURE.md) - separate containerized runtime.
- `http://localhost:9006/docs` - live root API schemas when the root Fastify app is running.
