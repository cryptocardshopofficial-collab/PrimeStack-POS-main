# PrimeStack — Security Audit & Hardening Report

Date: 2026-11-14
Scope: the public website server (`start-public-site.js`), the Fastify API
(`src/`), and the admin/browser-facing surfaces served by the same app.

> This report is deliberately blunt about what is **not** achievable, so the
> items that *are* implemented are not mistaken for more than they are.

---

## 1. Requests that cannot be delivered (by any software)

| Request | Reality |
| --- | --- |
| Block browser extensions | Impossible. Extensions run in the browser with higher privilege than the page. A site cannot detect or block them. Only enterprise browser policy / kiosk mode can. |
| Block right-click / Inspect | Not security. JS can swallow `contextmenu` / F12, but it is bypassed via the browser menu bar, `Ctrl+Shift+J`, view-source, `curl`, or disabling JS — and it breaks screen readers and keyboard users. Deterrent only. |
| Block Burp Suite / mitmproxy / ZAP | Impossible. The proxy runs on the user's own machine between them and the server; the server cannot see or block it, and the traffic is the user's own session. The only real control is to never trust the client (all enforcement server-side) and force TLS + HSTS. |
| "Block all tracing/hacking" | Not a single switch. Handled by the concrete controls in §3. |

These were left out by design.

---

## 2. What was implemented in this pass

### 2.1 Website server hardening — `start-public-site.js`
- Added `applySecurityHeaders()` applied to **every** response, including the
  `/api` proxy pass-through:
  - `Content-Security-Policy-Report-Only` (report-only first — the pages use
    inline scripts/styles, so an enforcing policy must be validated on real
    traffic before it is switched on)
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy` (camera/mic/geolocation/payment/usb denied)
  - `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`,
    `X-Permitted-Cross-Domain-Policies`, `X-DNS-Prefetch-Control`,
    `Origin-Agent-Cluster`
  - `Strict-Transport-Security` (production only)
  - `Server` / `X-Powered-By` stripped
- Dotfile / directory-listing block: any path with a `/.` segment returns 404
  (`/.env`, `/.git/config`, `/.ssh/...`).
- HTTP method allowlist (`GET, HEAD`; `405` otherwise) and single trailing-slash
  canonicalisation were already present and kept.

### 2.2 Backend Security Shield — `src/plugins/security-shield.ts` (new)
Ported the previously unwired draft (`.save-security-shield.ts`) into the app and
registered it in `src/app.ts`. It now runs before IP-whitelist and HMAC auth and:
- bans IPs on a block-list; auto-bans after repeated auth failures;
- blocks scanner/proxy user-agents (sqlmap, nikto, nmap, **burp**, zap, wpscan,
  shodan, censys, …);
- rejects path-traversal and known exploit paths;
- screens the query string **and** the parsed body for SQL-injection patterns;
- strips `X-Powered-By` / `Server` and sets hardening headers on responses.

Three defects in the draft were fixed while porting:
1. **Redis was a hard dependency.** An unreachable Redis would have thrown inside
   the request hook and 500'd *every* request. All Redis access now degrades
   gracefully (skip the check, never throw).
2. **Body screening ran in `onRequest`**, before the body is parsed, so it never
   fired. Moved to `preHandler`.
3. **Absent user-agent blocked all requests**, including internal
   service-to-service health calls. Now only state-changing methods without a UA
   are rejected.

### 2.3 Verification performed
- `npx tsc --noEmit` → clean.
- Website server restarted; all headers confirmed present on `/`.
- `/.env` → 404 (dotfile block works).

---

## 3. Findings (not yet fixed)

**HIGH — admin console HTML was served without CSP.**
`src/app.ts` registers Helmet with `contentSecurityPolicy: false` on the premise
"API server, not a browser app", but the same app renders admin HTML dashboards
(`src/shared/admin-ui.ts`, `src/modules/admin/admin-pages.ts`, plus the
monitoring / wallet / merchant / pag / governance / intelligence / swift-payout
dashboards). Those pages are browser-facing and currently have no CSP.
*Recommendation:* emit a CSP (report-only first) for `content-type: text/html`
responses only.

**MEDIUM — `/docs` (Swagger UI) is public and exempt from rate limiting.**
`app.ts` allow-lists `/docs` and `/health` from rate limiting, and `/docs` is
served unauthenticated. In production this exposes the full API surface.
*Recommendation:* disable Swagger UI or gate `/docs` behind admin auth when
`NODE_ENV=production`.

**MEDIUM — bans/rate-limits are per-instance when Redis is down.**
The shield degrades to "no ban list" without Redis (by design, so the API stays
up), and the rate limiter falls back to the in-process store. Behind multiple
instances this means limits are not shared.
*Recommendation:* treat Redis as required in production and alert when it is
unreachable.

**MEDIUM — no HSTS without TLS termination.**
`start-public-site.js` speaks plain HTTP; HSTS is only sent in production and is
ignored over HTTP. The site must run behind a TLS-terminating proxy for HSTS/TLS
to mean anything.

**LOW — `.env.example` typo.** `WISE_VIRTUAL_ACCOUNTS_ENABLED=falses` parses to
`false` (harmless but confusing). Placeholder secrets in the example file are
expected; production values must come from a secrets manager.

**LOW — `X-XSS-Protection: 1; mode=block`** is a legacy header ignored by modern
browsers. Harmless.

**INFO — CORS.** In development all origins are allowed; in production the
allow-list is `CORS_ORIGINS`, which defaults to **empty** (deny all). Ensure
`CORS_ORIGINS` is set in production.

**INFO — `trustProxy`.** Only enabled when `TRUSTED_PROXIES` is set. Correct, but
must be set behind a proxy or `request.ip` (and therefore IP bans) will be wrong.

**INFO — positive existing controls.** HMAC request signing with timestamp drift
+ nonce replay protection, constant-time signature compare, JWT admin auth with
active-user re-check, AES-256-GCM secret encryption, production secret-strength
validation, and IP allow-listing are already in place.

---

## 4. Test status

`npx tsc --noEmit` passes. The Vitest suite was **not** run here because it needs
a live PostgreSQL/Redis. Run `npm test` in an environment with both before
deploying the shield, since it adds a global `onRequest`/`preHandler` hook.
