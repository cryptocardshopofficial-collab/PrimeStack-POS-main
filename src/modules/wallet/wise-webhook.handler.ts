import type { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { Decimal } from "../../core/decimal.js";
import { ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import {
  verifyWiseWebhookSignature,
  fetchWiseIncomingTransfer,
} from "./wise-virtual-account.js";

/**
 * Platform's own Wise IBAN — PRIMESTACK TECHNOLOGIES LLC
 * BE19 9058 6159 3312 · TRWIBEB1XXX · Wise, Brussels
 *
 * Any inbound credit to this IBAN is automatically credited to
 * VAULT:LOUIS-CALTEN:EUR (or the appropriate vault account by currency).
 */
const PLATFORM_WISE_IBAN = "BE19905861593312"; // stripped of spaces
const PLATFORM_WISE_BIC  = "TRWIBEB1XXX";

/**
 * Maps the currency of an inbound Wise payment to the vault account
 * it should credit. Falls back to PLATFORM:RESERVE if unmapped.
 */
function resolveVaultAccountByIban(iban: string, currency: string): string {
  // If it hits our platform IBAN, route by currency into the vault
  const normalizedIban = iban.replace(/\s/g, "").toUpperCase();
  if (normalizedIban === PLATFORM_WISE_IBAN) {
    const vaultMap: Record<string, string> = {
      EUR: "VAULT:LOUIS-CALTEN:EUR",
      USD: "VAULT:LOUIS-CALTEN:USD",
      GBP: "VAULT:LOUIS-CALTEN:GBP",
      SGD: "VAULT:LOUIS-CALTEN:SGD",
      INR: "VAULT:LOUIS-CALTEN:INR",
    };
    return vaultMap[currency.toUpperCase()] ?? `PLATFORM:RESERVE:${currency.toUpperCase()}`;
  }
  return `PLATFORM:RESERVE:${currency.toUpperCase()}`;
}

/**
 * Wise `balances#update` event shape (schema_version 4.0.0).
 */
interface WiseBalanceUpdateEvent {
  event_type: string;
  schema_version: string;
  subscription_id: string;
  profile_id: number | string;
  data: {
    resource: {
      id: number | string;
      type: string;
      profile_id: number | string;
    };
    current_state: {
      id: number | string;
      currency: string;
      amount: { value: number; currency: string };
    };
    transaction_type: "CREDIT" | "DEBIT" | string;
    amount: { value: number; currency: string };
    post_transaction_balance_amount: { value: number; currency: string };
    occurred_at: string;
    cause: string;
    sender_name?: string;
    sender_account?: string;
    reference?: string;
  };
}

/**
 * Wise `incoming-transfer#credited` event shape (2026Q4 API).
 * This is the new unified event covering SEPA, SWIFT, ACH, Faster Payments.
 */
interface WiseIncomingTransferCreditedEvent {
  event_type: string;    // "incoming-transfer#credited"
  schema_version: string;
  subscription_id: string;
  profile_id: number | string;
  data: {
    incoming_transfer_id: string;
    occurred_at: string;
    resource?: {
      id?: string;
      type?: string;
    };
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function safeText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

const SUPE_FUNDING_PREFIX = "SYSTEM-FUNDING";

export async function ensureSupeFundingAccount(prisma: PrismaClient, currency: string): Promise<string> {
  const code = `${SUPE_FUNDING_PREFIX}-${currency}`;
  const existing = await prisma.account.findUnique({ where: { code }, select: { code: true } });
  if (existing) return existing.code;
  await prisma.account.create({
    data: { code, name: `System funding (${currency})`, type: "ASSET", subtype: "FUNDING", currency },
  });
  return code;
}

export async function ensurePlatformReserve(prisma: PrismaClient, currency: string): Promise<string> {
  const code = `PLATFORM:RESERVE:${currency}`;
  const existing = await prisma.account.findUnique({ where: { code }, select: { type: true, subtype: true } });
  if (existing) {
    if (existing.type !== "LIABILITY" || existing.subtype !== "RESERVE") {
      await prisma.account.update({
        where: { code },
        data: { type: "LIABILITY", subtype: "RESERVE" },
      });
    }
    return code;
  }
  await prisma.account.create({
    data: { code, name: `Platform Reserve (${currency})`, type: "LIABILITY", subtype: "RESERVE", currency },
  });
  return code;
}

export interface WiseWebhookResult {
  received: boolean;
  credited: boolean;
  status: "CREDITED" | "IGNORED" | "DUPLICATE" | "NO_MATCHING_ACCOUNT";
  journalEntryRef?: string;
  amount?: string;
  currency?: string;
  message: string;
}

/**
 * Verifies a Wise webhook delivery and, when it represents a real balance
 * credit that maps to one of our virtual accounts, posts the double-entry
 * ledger entry and upserts an InboundPayment tracking record.
 *
 * Returns a structured result so the route handler can log and respond.
 */
export async function handleWiseBalanceWebhook(
  prisma: PrismaClient,
  rawBody: Buffer,
  signature: string | undefined,
  ip: string | undefined,
): Promise<WiseWebhookResult> {

  // ── 1. Signature verification ────────────────
  if (!signature) {
    logger.warn({ ip }, "Wise webhook: missing X-Signature-SHA256 — rejected");
    throw new ValidationError("Missing X-Signature-SHA256 header");
  }
  if (!verifyWiseWebhookSignature(rawBody, signature)) {
    logger.warn({ ip }, "Wise webhook: RSA-SHA256 signature verification failed");
    throw new ValidationError("Wise webhook signature is invalid");
  }

  // ── 2. Parse the event ───────────────────────
  let event: WiseBalanceUpdateEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as WiseBalanceUpdateEvent;
  } catch {
    throw new ValidationError("Wise webhook body is not valid JSON");
  }

  logger.info(
    { eventType: event.event_type, cause: event.data?.cause, transactionType: event.data?.transaction_type },
    "Wise webhook received",
  );

  // ── 3. Only act on balance credits ──────────
  const data = asRecord(event.data);
  const transactionType = safeText(data.transaction_type).toUpperCase();
  const cause = safeText(data.cause);

  if (event.event_type !== "balances#update") {
    return { received: true, credited: false, status: "IGNORED", message: `Event type ${event.event_type} ignored` };
  }
  if (transactionType === "DEBIT") {
    return { received: true, credited: false, status: "IGNORED", message: "Debit event ignored" };
  }

  // ── 4. Extract the amount ────────────────────
  const amountBlock = asRecord(data.amount);
  const rawAmount = typeof amountBlock.value === "number" ? amountBlock.value : parseFloat(safeText(amountBlock.value));
  const currency = safeText(amountBlock.currency || asRecord(data.current_state).currency).toUpperCase();

  if (!rawAmount || rawAmount <= 0 || !currency) {
    return { received: true, credited: false, status: "IGNORED", message: "Zero or missing amount — ignored" };
  }
  const normalizedAmount = new Decimal(rawAmount).toFixed(4);

  // ── 5. Build a stable end-to-end reference ──
  // Wise provides occurred_at + cause + amount. We use the balance ID + occurred_at
  // as a deterministic dedup key — Wise can retry the same event multiple times.
  const resource = asRecord(data.resource);
  const balanceId = safeText(resource.id);
  const occurredAt = safeText(data.occurred_at) || new Date().toISOString();
  const senderName = safeText(data.sender_name);
  const senderAccount = safeText(data.sender_account);
  const reference = safeText(data.reference);

  const endToEndId =
    "WISE-" +
    createHash("sha256")
      .update(`${balanceId}:${occurredAt}:${normalizedAmount}:${currency}`)
      .digest("hex")
      .slice(0, 32)
      .toUpperCase();

  // ── 6. Find the matching virtual account ────
  // VirtualAccount stores the Wise balance ID in externalId.
  const virtualAccount = balanceId
    ? await prisma.virtualAccount.findFirst({
        where: { externalId: balanceId, currency, active: true },
        include: {
          wallet: {
            include: { account: true, merchant: { select: { id: true } } },
          },
        },
      })
    : null;

  // ── 7. Idempotency check ─────────────────────
  const journalRef =
    "SUPE-" +
    createHash("sha256")
      .update(`wise:${endToEndId}`)
      .digest("hex")
      .slice(0, 32)
      .toUpperCase();

  const existingJournal = await prisma.journalEntry.findUnique({
    where: { reference: journalRef },
    select: { reference: true },
  });
  if (existingJournal) {
    logger.info({ journalRef, endToEndId }, "Wise webhook: duplicate event — already credited");
    // Update the InboundPayment status to CREDITED if it somehow got missed.
    await prisma.inboundPayment.upsert({
      where: { endToEndId },
      create: {
        endToEndId,
        status: "CREDITED",
        amount: normalizedAmount,
        currency,
        sender: senderName || null,
        sourceFormat: "WISE_WEBHOOK",
        source: "BANK_FEED",
        journalEntryRef: journalRef,
        creditedAt: new Date(),
      },
      update: { status: "CREDITED", journalEntryRef: journalRef },
    });
    return {
      received: true,
      credited: true,
      status: "DUPLICATE",
      journalEntryRef: journalRef,
      message: `Already credited (journal: ${journalRef})`,
    };
  }

  // ── 8. Resolve destination account ──────────
  let destAccountCode: string;
  let merchantId: string | undefined;

  if (virtualAccount?.wallet) {
    destAccountCode = virtualAccount.wallet.account.code;
    merchantId = virtualAccount.wallet.merchant?.id;
  } else {
    // No matching virtual account — park in platform reserve.
    destAccountCode = await ensurePlatformReserve(prisma, currency);
    logger.warn(
      { balanceId, currency, endToEndId },
      "Wise webhook: no virtual account matched — parking in platform reserve",
    );
  }

  const fundingCode = await ensureSupeFundingAccount(prisma, currency);

  // ── 9. Post the double-entry ledger credit ──
  await ledgerService.postEntry({
    reference: journalRef,
    entryType: "TRANSFER",
    description: `Wise inbound: ${cause || "INCOMING_PAYMENT"} — ${senderName || "unknown sender"} — ${reference || endToEndId}`,
    source: "WISE_WEBHOOK",
    postedBy: `wise:${balanceId || "unknown"}`,
    metadata: {
      supeFormat: "WISE_WEBHOOK",
      originalReference: reference || endToEndId,
      endToEndId,
      sender: senderName || null,
      senderAccount: senderAccount || null,
      currency,
      balanceId,
      occurredAt,
      cause,
      transactionType,
      destination: destAccountCode,
      ingestedAt: new Date().toISOString(),
    },
    lines: [
      { accountCode: fundingCode, debit: normalizedAmount, credit: "0" },
      { accountCode: destAccountCode, debit: "0", credit: normalizedAmount },
    ],
  });

  // ── 10. Upsert the InboundPayment tracking record ──
  await prisma.inboundPayment.upsert({
    where: { endToEndId },
    create: {
      endToEndId,
      status: "CREDITED",
      amount: normalizedAmount,
      currency,
      sender: senderName || null,
      senderAccount: senderAccount || null,
      sourceFormat: "WISE_WEBHOOK",
      source: "BANK_FEED",
      journalEntryRef: journalRef,
      merchantId: merchantId ?? null,
      creditedAt: new Date(),
      confirmedAt: new Date(),
    },
    update: {
      status: "CREDITED",
      journalEntryRef: journalRef,
      creditedAt: new Date(),
    },
  });

  // ── 11. Audit log ────────────────────────────
  if (merchantId) {
    await prisma.auditLog.create({
      data: {
        merchantId,
        action: "WISE_INBOUND_CREDITED",
        entity: "InboundPayment",
        entityId: journalRef,
        ipAddress: ip,
        after: {
          amount: normalizedAmount,
          currency,
          endToEndId,
          balanceId,
          cause,
          senderName: senderName || null,
        } as unknown as Parameters<typeof prisma.auditLog.create>[0]["data"]["after"],
      },
    });
  }

  logger.info(
    { journalRef, endToEndId, amount: normalizedAmount, currency, cause, destAccountCode },
    "Wise webhook: balance credit posted to ledger",
  );

  return {
    received: true,
    credited: true,
    status: "CREDITED",
    journalEntryRef: journalRef,
    amount: normalizedAmount,
    currency,
    message: `${normalizedAmount} ${currency} credited from Wise (${cause || "INCOMING_PAYMENT"})`,
  };
}

/**
 * Handle the new `incoming-transfer#credited` event (Wise 2026Q4 API).
 *
 * Flow:
 *   1. Verify RSA signature
 *   2. Extract incoming_transfer_id from payload
 *   3. Fetch full transfer resource from Wise API
 *   4. Resolve destination vault account from creditor IBAN + currency
 *   5. Post double-entry ledger entry (idempotent on transfer ID)
 *   6. Upsert InboundPayment tracking record
 */
export async function handleWiseIncomingTransferWebhook(
  prisma: PrismaClient,
  rawBody: Buffer,
  signature: string | undefined,
  ip: string | undefined,
): Promise<WiseWebhookResult> {

  // ── 1. Signature verification ────────────────
  if (!signature) {
    logger.warn({ ip }, "Wise incoming-transfer webhook: missing X-Signature-SHA256");
    throw new ValidationError("Missing X-Signature-SHA256 header");
  }
  if (!verifyWiseWebhookSignature(rawBody, signature)) {
    logger.warn({ ip }, "Wise incoming-transfer webhook: RSA signature invalid");
    throw new ValidationError("Wise webhook signature is invalid");
  }

  // ── 2. Parse event ───────────────────────────
  let event: WiseIncomingTransferCreditedEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as WiseIncomingTransferCreditedEvent;
  } catch {
    throw new ValidationError("Wise webhook body is not valid JSON");
  }

  const incomingTransferId = event.data?.incoming_transfer_id;
  if (!incomingTransferId) {
    return {
      received: true,
      credited: false,
      status: "IGNORED",
      message: "incoming_transfer_id missing from payload",
    };
  }

  logger.info(
    { incomingTransferId, eventType: event.event_type },
    "Wise incoming-transfer webhook received",
  );

  // ── 3. Idempotency — check before fetching ───
  const journalRef = "WISE-IT-" + createHash("sha256")
    .update(incomingTransferId)
    .digest("hex")
    .slice(0, 28)
    .toUpperCase();

  const existingJournal = await prisma.journalEntry.findUnique({
    where: { reference: journalRef },
    select: { reference: true },
  });
  if (existingJournal) {
    logger.info({ journalRef, incomingTransferId }, "Wise incoming-transfer: duplicate — already credited");
    return {
      received: true,
      credited: true,
      status: "DUPLICATE",
      journalEntryRef: journalRef,
      message: `Already credited (journal: ${journalRef})`,
    };
  }

  // ── 4. Fetch full transfer resource from Wise ─
  const transfer = await fetchWiseIncomingTransfer(incomingTransferId);
  if (!transfer) {
    logger.warn({ incomingTransferId }, "Wise: could not fetch incoming transfer — will retry on next delivery");
    return {
      received: true,
      credited: false,
      status: "IGNORED",
      message: "Could not fetch transfer details from Wise — will retry",
    };
  }

  const currency  = (transfer.currency ?? "EUR").toUpperCase();
  const rawAmount = transfer.amount ?? "0";
  const amount    = new Decimal(rawAmount);

  if (!amount.isFinite() || amount.lte(0)) {
    return {
      received: true,
      credited: false,
      status: "IGNORED",
      message: `Invalid amount ${rawAmount} on incoming transfer ${incomingTransferId}`,
    };
  }

  const normalizedAmount = amount.toFixed(4);

  // ── 5. Resolve destination vault account ─────
  // If creditor IBAN matches our platform IBAN → route to vault by currency.
  // Otherwise fall back to platform reserve.
  const creditorIban = transfer.creditorAccount ?? "";
  let destAccountCode = resolveVaultAccountByIban(creditorIban, currency);

  // Also try to match against a registered virtual account by IBAN
  if (transfer.balanceId) {
    const virtualAccount = await prisma.virtualAccount.findFirst({
      where: { externalId: transfer.balanceId, currency, active: true },
      include: { wallet: { include: { account: true } } },
    });
    if (virtualAccount?.wallet) {
      destAccountCode = virtualAccount.wallet.account.code;
    }
  }

  const fundingCode = await ensureSupeFundingAccount(prisma, currency);

  // Ensure vault account exists
  const destExists = await prisma.account.findUnique({
    where: { code: destAccountCode },
    select: { code: true },
  });
  if (!destExists) {
    await prisma.account.create({
      data: {
        code: destAccountCode,
        name: `Vault: ${destAccountCode}`,
        type: "ASSET",
        subtype: "VAULT",
        currency,
        balance: 0,
      },
    });
  }

  // ── 6. Post double-entry ledger entry ────────
  await ledgerService.postEntry({
    reference:   journalRef,
    entryType:   "TRANSFER",
    description: `Wise ${transfer.scheme ?? "inbound"}: ${transfer.debtorName ?? "unknown sender"} → ${currency} ${normalizedAmount} — ${transfer.reconciliationReference ?? incomingTransferId}`,
    source:      "WISE_INCOMING_TRANSFER",
    postedBy:    `wise:${incomingTransferId}`,
    metadata: {
      incomingTransferId,
      scheme:                  transfer.scheme,
      state:                   transfer.state,
      uetr:                    transfer.uetr,
      endToEndId:              transfer.endToEndId,
      reconciliationReference: transfer.reconciliationReference,
      debtorName:              transfer.debtorName,
      debtorAccount:           transfer.debtorAccount,
      debtorBic:               transfer.debtorBic,
      creditorIban:            transfer.creditorAccount,
      creditedTime:            transfer.creditedTime,
      reference:               transfer.reference,
      currency,
      destination:             destAccountCode,
      platformIban:            PLATFORM_WISE_IBAN,
      platformBic:             PLATFORM_WISE_BIC,
    },
    lines: [
      { accountCode: fundingCode,    debit: normalizedAmount, credit: "0" },
      { accountCode: destAccountCode, debit: "0", credit: normalizedAmount },
    ],
  });

  // ── 7. Upsert InboundPayment tracking ────────
  const endToEndId = transfer.endToEndId ?? `WISE-${incomingTransferId}`;
  await prisma.inboundPayment.upsert({
    where:  { endToEndId },
    create: {
      endToEndId,
      status:        "CREDITED",
      amount:        normalizedAmount,
      currency,
      sender:        transfer.debtorName  ?? null,
      senderAccount: transfer.debtorAccount ?? null,
      sourceFormat:  "WISE_INCOMING_TRANSFER",
      source:        "BANK_FEED",
      journalEntryRef: journalRef,
      creditedAt:    new Date(),
      confirmedAt:   new Date(),
    },
    update: {
      status:          "CREDITED",
      journalEntryRef: journalRef,
      creditedAt:      new Date(),
    },
  });

  logger.info(
    {
      journalRef,
      incomingTransferId,
      scheme:        transfer.scheme,
      amount:        normalizedAmount,
      currency,
      debtorName:    transfer.debtorName,
      destAccount:   destAccountCode,
    },
    "Wise incoming-transfer credited to vault",
  );

  return {
    received:        true,
    credited:        true,
    status:          "CREDITED",
    journalEntryRef: journalRef,
    amount:          normalizedAmount,
    currency,
    message:         `${normalizedAmount} ${currency} credited via Wise ${transfer.scheme ?? "inbound"} from ${transfer.debtorName ?? "unknown"}`,
  };
}

/**
 * Main webhook dispatcher — routes to the correct handler based on event_type.
 * Handles both legacy `balances#update` and new `incoming-transfer#credited`.
 */
export async function handleWiseWebhook(
  prisma: PrismaClient,
  rawBody: Buffer,
  signature: string | undefined,
  ip: string | undefined,
): Promise<WiseWebhookResult> {
  // Peek at event_type without full verification first
  let eventType = "unknown";
  try {
    const preview = JSON.parse(rawBody.toString("utf8")) as { event_type?: string };
    eventType = preview.event_type ?? "unknown";
  } catch {
    throw new ValidationError("Wise webhook body is not valid JSON");
  }

  if (eventType === "incoming-transfer#credited") {
    return handleWiseIncomingTransferWebhook(prisma, rawBody, signature, ip);
  }

  // Default: legacy balances#update handler
  return handleWiseBalanceWebhook(prisma, rawBody, signature, ip);
}
