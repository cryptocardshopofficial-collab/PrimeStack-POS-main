# Payment Ingestion Orchestration - Implementation Plan

## Task 1: Add IncomingPayment data model + migration
- **Status**: `completed`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Add `PaymentRail` enum (SWIFT_MT103, SWIFT_MT202, ISO20022, ACH, SEPA, FEDWIRE) and `PaymentStatus` enum (RECEIVED, SCREENING, SCREENED, FRAUD_CHECK, UNDER_REVIEW, PENDING_ASSIGNMENT, POSTING, POSTED, REJECTED, FAILED) to `prisma/schema.prisma`.
  - Add `IncomingPayment` model: id, reference (unique per rail via @@unique), rail, status, amount, currency, valueDate, operationCode, charges, debtorName/Account/Bic/Country, creditorName/Account/Bic/Country, merchantId, walletId, journalEntryRef, sanctionsScreeningIds (String[]), fraudVerdict, fraudRiskScore, failureReason, reviewedBy, reviewNotes, metadata (Json), createdAt, updatedAt, postedAt.
  - Relations to Merchant, Wallet, JournalEntry.
  - Hand-write migration SQL in `prisma/migrations/<ts>_incoming_payments/migration.sql`.
- **Acceptance Criteria Addressed**: AC-1 (persistence foundation), AC-4 (journalEntryRef link), AC-7 (reviewedBy/reviewNotes)
- **Test Requirements**:
  - `rule` TR-1.1: `prisma generate` succeeds and `prisma.incomingPayment.create`/`findUnique` are type-available; `npx tsc --noEmit` passes.
  - `rule` TR-1.2: Migration applies cleanly (`prisma migrate deploy`) and `IncomingPayment` table + 2 enums exist in DB.
- **Completion Evidence**:
  - `prisma generate` succeeded (Prisma Client v5.22.0).
  - `prisma migrate status` reports "Database schema is up to date!" (28 migrations).
  - Direct DB query: `prisma.incomingPayment.count()` returned `0` (table exists).
  - `npx tsc --noEmit` exited 0.

## Task 2: Build PaymentIngestionService
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - Create `src/modules/payments/payment-ingestion.service.ts` with `PaymentIngestionService(prisma)`.
  - Inject singletons: `swiftMtService`, `sanctionsService`, `fraudService`, `ledgerService`, `streamingService`, `webhookService`.
  - Core method `ingest(input)`:
    1. Idempotency check: find by `rail + reference`; if exists return it (200).
    2. Parse (raw SWIFT → `SwiftPaymentSummary`) or use structured payment; on parse failure create row status `FAILED` with failureReason and throw ValidationError.
    3. Create `IncomingPayment` row status `RECEIVED`, publish `payments.received`.
    4. Sanctions screen debtor + creditor → on match set `REJECTED`, publish `payments.failed`, return.
    5. Fraud evaluate → BLOCK → `REJECTED`; REVIEW → `UNDER_REVIEW` (stop); ALLOW → continue.
    6. Resolve destination wallet (merchantId → wallet, else creditor account match); no wallet → `PENDING_ASSIGNMENT` (stop).
    7. Ensure settlement funding account `SETTLEMENT:{currency}` (LIABILITY) exists.
    8. Atomic transaction: `ledgerService.postEntry` (debit SETTLEMENT, credit merchant wallet), update payment to `POSTED` with journalEntryRef + postedAt, create AuditLog action `PAYMENT_POSTED`.
    9. Publish `payments.posted`.
    10. Fire-and-forget `webhookService.dispatch("PAYMENT_SETTLED", reference, payload)`.
  - `getByReference(reference)`, `list(filters, pagination)`, `resolve(reference, {decision, reviewedBy, reviewNotes})` — on APPROVE resume from step 6.
  - Private helpers: `screenParty`, `postLedger`, `ensureSettlementAccount`, `resolveWallet`.
  - Status transitions enforced (no invalid jumps).
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8
- **Test Requirements**:
  - `rule` TR-2.1: Happy path — ingest valid MT103 with seeded clean sanctions + fraud ALLOW + active merchant wallet → returns status POSTED, journalEntryRef non-null, AuditLog created.
  - `rule` TR-2.2: Sanctions block — seed a matching sanctions entry → status REJECTED, no JournalEntry, `payments.failed` in stream buffer.
  - `rule` TR-2.3: Fraud block — configure fraud to BLOCK → status REJECTED, no JournalEntry.
  - `rule` TR-2.4: Idempotency — ingest same reference twice → second returns existing row, single JournalEntry.
  - `rule` TR-2.5: Atomicity — force ledger post failure → payment not POSTED, status FAILED, no JournalEntry.
  - `rule` TR-2.6: Resolve approve — UNDER_REVIEW payment + resolve(APPROVE) → status POSTED, reviewedBy set, JournalEntry created.
  - `rule` TR-2.7: Stream events — happy path emits payments.received, payments.validated, payments.posted (3 distinct events in buffer).
  - `rubric` TR-2.8: Log PII hygiene; scale 1-5; anchors 1=raw message logged, 5=only ref/amount/currency/status; threshold >=4; evidence: captured logger output.

## Task 3: HTTP routes + module registration
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - Create `src/modules/payments/payments.routes.ts` (base `/payments`):
    - `POST /payments/ingest` — body `{ rawMessage? } | { payment? }`, returns 201 on new, 200 on idempotent.
    - `GET /payments/incoming` — paginated list with filters.
    - `GET /payments/incoming/:reference` — single.
    - `POST /payments/incoming/:reference/resolve` — body `{ decision: APPROVE|REJECT, reviewedBy, reviewNotes }`.
  - Create `src/modules/payments/payments.module.ts` exporting `paymentIngestionService` singleton + `registerPaymentsModule(app)`.
  - Reuse `sendSuccess`, `sendCreated`, `sendPaginated`, `parsePagination`.
- **Acceptance Criteria Addressed**: AC-1, AC-10 (FR-10/FR-11)
- **Test Requirements**:
  - `rule` TR-3.1: `registerPaymentsModule` wires all 4 routes without route-conflict errors at boot.
  - `rule` TR-3.2: `GET /payments/incoming/:reference` returns 404 for unknown reference.
  - `rule` TR-3.3: `POST /payments/incoming/:reference/resolve` rejects invalid decision with 422.

## Task 4: Wire into app.ts + add i18n error codes
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - Import + call `registerPaymentsModule(app)` in `src/app.ts`.
  - Add error codes `PAYMENT_ALREADY_PROCESSED`, `PAYMENT_NOT_FOUND`, `PAYMENT_INVALID_TRANSITION`, `PAYMENT_PARSE_FAILED`, `PAYMENT_SCREENING_FAILED`, `PAYMENT_FRAUD_BLOCKED`, `PAYMENT_SANCTIONS_BLOCKED`, `PAYMENT_NO_DESTINATION` to all 5 locale `errors.json` files (en/fr/es/ar/pt).
- **Acceptance Criteria Addressed**: all ACs (routing reachable)
- **Test Requirements**:
  - `rule` TR-4.1: App boots (`tsx src/server.ts`) with "Payments module registered" log line and no errors.
  - `rule` TR-4.2: All 5 locale JSON files are valid JSON and contain the new keys.

## Task 5: End-to-end verification
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4
- **Description**:
  - Run `npx prisma generate`, `npx prisma migrate deploy`, `npx tsc --noEmit`, `npx vitest run`.
  - Smoke test via PowerShell helper against the running dev server: ingest a valid MT103, verify POSTED + journal entry + webhook delivery via `GET /payments/incoming/:reference` and `GET /ledger/entries/:ref`.
- **Acceptance Criteria Addressed**: AC-1 through AC-10
- **Test Requirements**:
  - `rule` TR-5.1: `tsc --noEmit` exits 0.
  - `rule` TR-5.2: `vitest run` all tests pass.
  - `rule` TR-5.3: End-to-end ingest returns 201 and GET shows status POSTED with journalEntryRef.
  - `rubric` TR-5.4: Happy-path latency; scale 1-5; anchors 1=>5s, 5=<2s; threshold >=4; evidence: timed PowerShell request.
