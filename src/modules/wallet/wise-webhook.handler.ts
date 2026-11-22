import type { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { Decimal } from "../../core/decimal.js";
import { ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { verifyWiseWebhookSignature } from "./wise-virtual-account.js";

/**
 * Wise `balances#update` event shape (schema_version 4.0.0).
 *
 * Wise fires this whenever a balance is credited or debited. We only act on
 * credits (amount > 0 or occurrence_type = "CREDIT").
 *
 * https://docs.wise.com/guides/developer/webhooks/event-handling
 */
interface WiseBalanceUpdateEvent {
  event_type: string;        // "balances#update"
  schema_version: string;    // "4.0.0"
  subscription_id: string;
  profile_id: number | string;
  data: {
    resource: {
      id: number | string;   // Wise balance ID
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
    occurred_at: string;      // ISO 8601
    cause: string;            // "INCOMING_PAYMENT", "CONVERSION", etc.
    sender_name?: string;
    sender_account?: string;
    reference?: string;
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

async function ensureSupeFundingAccount(prisma: PrismaClient, currency: string): Promise<string> {
  const code = `${SUPE_FUNDING_PREFIX}-${currency}`;
  const existing = await prisma.account.findUnique({ where: { code }, select: { code: true } });
  if (existing) return existing.code;
  await prisma.account.create({
    data: { code, name: `System funding (${currency})`, type: "ASSET", subtype: "FUNDING", currency },
  });
  return code;
}

async function ensurePlatformReserve(prisma: PrismaClient, currency: string): Promise<string> {
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
