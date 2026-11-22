# Payment Ingestion Orchestration - Product Requirements Document

## Overview
- **Summary**: Wire the four newly-built modules (SWIFT MT parser, sanctions screening, event streaming, webhook orchestration) together with the existing ledger, fraud, and audit subsystems into a single production-grade incoming-payment pipeline. An operator submits a raw SWIFT MT103/MT202 message (or structured payment data) and the platform parses it, screens both parties against sanctions, runs fraud/AML checks, resolves the destination merchant wallet, posts a balanced double-entry ledger entry, records an audit trail, publishes lifecycle events to the stream, and notifies the merchant via signed webhook.
- **Purpose**: The SUPE engine already ingests ISO 20022 and posts to the ledger, but each new module (parsers, sanctions, streaming, webhooks) is standalone. Real-world payments require an end-to-end orchestrated flow with gating, idempotency, atomicity, and observability so that "funds arrived" is a deterministic, auditable outcome rather than a side effect.
- **Target Users**: Operations staff (manual ingestion via API/console), downstream services (SFTP/MQ connectors that will feed this pipeline), merchants (receive settlement notifications).

## Goals
- A single `PaymentIngestionService.ingest()` entry point that takes a raw SWIFT MT message (or pre-parsed payment) and drives it through parse → screen → fraud → resolve → post → notify.
- A persisted `IncomingPayment` record that records the full lifecycle (status, parties, amounts, screening/fraud results, ledger reference, timestamps).
- Hard gates: a sanctions match (POTENTIAL_MATCH / CONFIRMED_MATCH) or fraud BLOCK verdict prevents ledger posting and routes the payment to REJECTED / REVIEW.
- Idempotency: the same incoming reference (`:20:` for MT103) cannot be posted twice.
- Atomicity: the IncomingPayment status transition to POSTED, the journal entry, and the audit log are written in one database transaction.
- Observability: every state transition emits a stream event (`payments.received`, `payments.validated`, `payments.posted`, `payments.failed`) and a structured log line.
- Merchant notification: on successful posting, a signed `PAYMENT_SETTLED` webhook is dispatched to the merchant's active subscriptions (with retry/backoff handled by the webhook module).

## Non-Goals
- Building outbound payment rails (ACH/SEPA/Fedwire/SFTP/MQ connectors) — those are separate ingestion sources that will call this pipeline.
- AML engine beyond the existing fraud service's velocity/amount checks (a dedicated structuring/layering engine is a future module).
- Sanctions list data seeding — operators import lists via `/sanctions/lists/import`.
- Real-time Kafka consumers in this iteration — the streaming module publishes; consumer-side processing is out of scope.
- Automatic merchant-wallet resolution by IBAN — in v1 the destination wallet is resolved by merchantId supplied in the request or matched by creditor account against a wallet's virtual account; otherwise the payment is held for manual assignment.

## Background & Context
- Existing modules already in the repo and passing tests:
  - SWIFT MT parser (`src/modules/swift-mt`): stateless, returns `SwiftPaymentSummary` with debtor/creditor/amount/currency/reference.
  - Sanctions screening (`src/modules/sanctions`): `screen(input)` returns status CLEAR/POTENTIAL_MATCH/CONFIRMED_MATCH/FALSE_POSITIVE with score and match detail. Threshold 85.
  - Event streaming (`src/modules/streaming`): `publish(topic, eventName, reference, payload)` — memory fallback when Kafka disabled.
  - Webhook orchestration (`src/modules/webhooks`): `dispatch(eventName, reference, payload)` fans out to merchant subscriptions with HMAC-signed payloads and retry.
  - Ledger (`src/modules/ledger`): `postEntry({reference, entryType, source, postedBy, lines})` — double-entry, atomic, rejects duplicate references.
  - Fraud (`src/modules/fraud`): `evaluate({amount, currency, merchantId, ...})` returns `{verdict: ALLOW|REVIEW|BLOCK, riskScore, riskLevel, triggeredRules}`.
  - AuditLog model exists with `userId`, `merchantId`, `action`, `entity`, `entityId`, `before`, `after`, `ipAddress`.
- SUPE module (`src/modules/supe/supe.routes.ts`) is the closest existing pattern: it validates, checks duplicate reference, ensures accounts, posts a debit-credit journal entry, and writes an audit log. The new pipeline generalizes this and adds screening + fraud + streaming + webhook gating.

## Functional Requirements

### FR-1: Ingestion entry point
- `POST /payments/ingest` accepts either `{ rawMessage: string }` (SWIFT MT103/MT202) or `{ payment: <structured> }`.
- Returns a persisted `IncomingPayment` with its current status and a reference.

### FR-2: Parse & validate
- For raw SWIFT: use `swiftMtService.parse()`. Reject structurally invalid messages with status `REJECTED` and a validation error (no ledger posting).
- Extract: reference, amount, currency, valueDate, debtor (name/account/bic/country), creditor (name/account/bic/country), operationCode, charges.

### FR-3: Sanctions screening gate
- Screen both debtor and creditor (name + country + bankName) via `sanctionsService.screen()`.
- If either returns `POTENTIAL_MATCH` or `CONFIRMED_MATCH`, set payment status to `REJECTED` (sanctions), record the screening references, do **not** post to the ledger, publish `payments.failed`, and return.
- `FALSE_POSITIVE` or `CLEAR` proceeds.

### FR-4: Fraud / AML gate
- Call `fraudService.evaluate({amount, currency, merchantId})`.
- `BLOCK` → status `REJECTED` (fraud), no ledger post, publish `payments.failed`.
- `REVIEW` → status `UNDER_REVIEW`, no ledger post, publish `payments.validated` with review flag.
- `ALLOW` → proceed to posting.

### FR-5: Destination resolution
- Resolve the destination merchant wallet: prefer explicit `merchantId` in the request; otherwise match creditor account against `VirtualAccount` / wallet account codes.
- If no wallet can be resolved, set status `PENDING_ASSIGNMENT` and stop (no ledger post). An operator can later assign and resume.

### FR-6: Ledger posting (atomic)
- Debit a nostro/settlement funding account (`SETTLEMENT:{currency}`) and credit the merchant's wallet ledger account.
- Post within a Prisma transaction that also transitions the `IncomingPayment` to `POSTED` and writes the `AuditLog`.
- Link `IncomingPayment.journalEntryRef` to the posted entry.

### FR-7: Idempotency
- The incoming reference (SWIFT `:20:` or supplied `reference`) is unique per rail. A second ingest with the same `rail + reference` returns the existing `IncomingPayment` without re-posting (HTTP 200, not 201).

### FR-8: Stream events
- Publish `payments.received` on ingest, `payments.validated` after sanctions+fraud pass, `payments.posted` after ledger commit, `payments.failed` on rejection.
- Use `streamingService.publish()` (Kafka or memory fallback).

### FR-9: Webhook notification
- On `POSTED`, call `webhookService.dispatch("PAYMENT_SETTLED", reference, {amount, currency, ...})` scoped to the destination merchant.
- Webhook delivery is best-effort and asynchronous (retry handled by webhook module); failure does not roll back the ledger post.

### FR-10: Payment status query
- `GET /payments/incoming/:reference` returns the full `IncomingPayment` record including screening/fraud results, ledger reference, and current status.
- `GET /payments/incoming` lists with filters (status, rail, merchantId, date range) and pagination.

### FR-11: Manual review resolution
- `POST /payments/incoming/:reference/resolve` lets an operator approve (`POSTED`) or reject (`REJECTED`) a payment in `UNDER_REVIEW` or `PENDING_ASSIGNMENT`, with `reviewedBy` and `reviewNotes`. Posting only happens on approve.

### FR-12: Production hardening
- All state transitions are audited (AuditLog with before/after).
- `payments.failed` includes the failure reason.
- Structured logging with payment reference on every step.
- The funding account is auto-created if missing (settlement liability account).

## Non-Functional Requirements
- **NFR-1**: The POSTED transition (payment status + journal entry + audit) is a single atomic DB transaction — no partial states.
- **NFR-2**: Idempotent re-ingestion returns within one DB read; never double-posts.
- **NFR-3**: Sanctions/fraud gating never allows a matched or blocked payment to reach the ledger.
- **NFR-4**: The ingest endpoint responds in < 2s for the happy path (excluding webhook delivery, which is fire-and-forget).
- **NFR-5**: All error paths set a terminal status (`REJECTED` or `FAILED`) with a `failureReason`; no payment is left in a transient state on error.
- **NFR-6**: No raw SWIFT message PII is logged at info level; only the reference, amount, currency, and status are logged.

## Constraints
- **Technical**: Fastify 4, Prisma 5, PostgreSQL, TypeScript 5.4 ESM, strict mode with `noUnusedLocals`. New code follows the existing `*.module.ts` / `*.routes.ts` / `*.service.ts` / `*.types.ts` pattern and reuses `sendSuccess`/`sendCreated`/`sendPaginated` and error classes from `src/core/errors.ts`.
- **Business**: A sanctions match or fraud BLOCK is an unconditional hard stop — no auto-approve path.
- **Dependencies**: Exists — swift-mt, sanctions, streaming, webhooks, ledger, fraud modules; AuditLog model. New — `IncomingPayment` model + migration.

## Assumptions
- The existing `swiftMtService`, `sanctionsService`, `streamingService`, `webhookService`, `ledgerService`, `fraudService` singletons are importable from their `*.module.ts` files.
- Kafka may be disabled in dev; the streaming module's memory buffer is acceptable for event emission.
- Merchants have at least one active wallet with a ledger account; a settlement funding account per currency can be auto-provisioned.
- The HMAC auth plugin protects `/payments/*` routes (no allowlisting needed).

## Acceptance Criteria

### AC-1: Ingest creates a persisted IncomingPayment
- **Type**: `rule`
- **Given**: A valid MT103 message and an active merchant wallet
- **When**: `POST /payments/ingest` is called
- **Then**: An `IncomingPayment` row exists with `rail=SWIFT_MT103`, the parsed reference/amount/currency, debtor/creditor fields, and status `RECEIVED` (then transitioning through the pipeline)
- **Pass Condition**: DB query returns the row with parsed fields populated
- **Evidence**: Integration test + DB inspection

### AC-2: Sanctions match blocks posting
- **Type**: `rule`
- **Given**: A sanctions list entry matching the creditor name with score >= 85
- **When**: A payment referencing that creditor is ingested
- **Then**: Status is `REJECTED`, `journalEntryRef` is null, `payments.failed` is published, no journal entry is created
- **Pass Condition**: No `JournalEntry` with the payment reference exists; payment.status === 'REJECTED'
- **Evidence**: Test with a seeded sanctions entry

### AC-3: Fraud BLOCK blocks posting
- **Type**: `rule`
- **Given**: Fraud rules configured to BLOCK the amount/velocity
- **When**: The payment is ingested
- **Then**: Status `REJECTED`, no ledger post, `payments.failed` published
- **Pass Condition**: No journal entry; status REJECTED with failureReason
- **Evidence**: Test with a triggering amount

### AC-4: Happy path posts ledger and dispatches webhook
- **Type**: `rule`
- **Given**: Clean sanctions + fraud ALLOW + resolvable merchant wallet
- **When**: Ingested
- **Then**: Status `POSTED`, `journalEntryRef` links to a POSTED journal entry debiting settlement and crediting the merchant wallet, an AuditLog exists, and a `PAYMENT_SETTLED` webhook delivery exists for the merchant
- **Pass Condition**: JournalEntry.lines show debit SETTLEMENT / credit wallet; AuditLog action PAYMENT_POSTED; WebhookDelivery eventName PAYMENT_SETTLED
- **Evidence**: End-to-end integration test

### AC-5: Idempotent re-ingestion
- **Type**: `rule`
- **Given**: A payment successfully posted once
- **When**: The same `rail + reference` is ingested again
- **Then**: The existing `IncomingPayment` is returned (HTTP 200), no new journal entry is created, no double credit
- **Pass Condition**: Only one JournalEntry exists for the reference
- **Evidence**: Test that double ingest returns 200 and single journal entry

### AC-6: Atomicity of POSTED transition
- **Type**: `rule`
- **Given**: A payment at the posting step
- **When**: The ledger post throws (e.g. funding account missing and cannot be created)
- **Then**: The IncomingPayment remains in its pre-POSTED status (no partial post), `failureReason` is set, status becomes `FAILED`
- **Pass Condition**: No journal entry; payment not in POSTED state
- **Evidence**: Test with a forced ledger failure

### AC-7: Manual resolution of UNDER_REVIEW
- **Type**: `rule`
- **Given**: A payment in `UNDER_REVIEW`
- **When**: Operator calls `/resolve` with `decision: APPROVE`
- **Then**: Payment posts to ledger, status `POSTED`, `reviewedBy`/`reviewNotes` recorded
- **Pass Condition**: Journal entry created, status POSTED, reviewedBy populated
- **Evidence**: Test approve path

### AC-8: Stream events emitted on each transition
- **Type**: `rule`
- **Given**: A happy-path ingest
- **When**: The pipeline runs
- **Then**: `payments.received`, `payments.validated`, `payments.posted` are each published exactly once (observable via the streaming buffer)
- **Pass Condition**: `streamingService.listBuffered()` contains the three events for the reference
- **Evidence**: Test inspects the in-memory buffer

### AC-9: No PII in info logs
- **Type**: `rubric`
- **Dimension**: Sensitive-data leakage in logs
- **Scale**: 1-5
- **Anchors**: 1 = raw SWIFT message or party names logged at info; 3 = only reference logged but amount/currency absent; 5 = only reference, amount, currency, status, rail logged at info; PII only in error details at debug
- **Pass Threshold**: >= 4
- **Evidence**: Log output inspection from tests

### AC-10: Endpoint performance
- **Type**: `rubric`
- **Dimension**: Happy-path ingest latency (excluding async webhook delivery)
- **Scale**: 1-5
- **Anchors**: 1 = > 5s; 3 = 2-5s; 5 = < 2s
- **Pass Threshold**: >= 4
- **Evidence**: Timed integration test

## Open Questions
- [ ] Should raw SWIFT messages be stored encrypted at rest on the IncomingPayment, or only the parsed fields? (Assumption: parsed fields only, raw not stored.)
- [ ] What is the settlement funding account naming convention? (Proposed: `SETTLEMENT:{currency}` as a LIABILITY.)
- [ ] Should `PENDING_ASSIGNMENT` payments be assignable to any merchant, or only via operator JWT? (Proposed: operator JWT only.)
