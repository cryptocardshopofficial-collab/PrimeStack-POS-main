import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { PrismaClient, Prisma, InboundPayment } from "@prisma/client";
import { Decimal } from "../../core/decimal.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import {
  createInstructionSchema,
  type CreateInstructionInput,
  type SupeInboundStatus,
  type SupeInstructionStatus,
  type SupeSettlementFormat,
  type SupeTransmissionChannel,
} from "./types.js";
import {
  detectIso20022MessageType,
  formatExtension,
  formatMime,
  parseCamt054CreditNotification,
  parseInitiationMessage,
  parsePacs002StatusReport,
  renderInstructionPayload,
  type InstructionRenderInput,
  type ParsedPacs002,
} from "./supe.formats.js";

/** Minimal fetch shape (mirrors the webhooks module so tests can inject a stub). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Caller context passed into service methods (from the authenticated request). */
export interface SupeContext {
  userId?: string;
  merchantId?: string;
  role?: string;
  ip?: string;
}

export interface SupeServiceOptions {
  fetchImpl?: FetchLike;
  /** Default bank API endpoint, overridable per request. */
  bankApiUrl?: string;
  /** Default bank API bearer key, overridable per request. */
  bankApiKey?: string;
}

const SUPE_FUNDING_PREFIX = "SYSTEM-FUNDING";
const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN", "OPERATOR"];
const TRANSMIT_TIMEOUT_MS = 30_000;

function defaultFetch(): FetchLike {
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (!globalFetch) {
    logger.warn("Global fetch is unavailable — SUPE BANK_API transmission will fail");
    return async () => {
      throw new AppError("Fetch API is unavailable in this runtime", 500, "FETCH_UNAVAILABLE");
    };
  }
  return globalFetch;
}

/**
 * SUPE — the inbound fund-credit engine *and* the bank-grade outbound
 * settlement/transmission service.
 *
 * Outbound lifecycle: DRAFT → SUBMITTED → ACCEPTED → EXECUTED (or
 * REJECTED / CANCELLED). The ledger is the source of truth; an instruction
 * exports ledger data to a bank in a format the bank accepts and records the
 * bank's validation/execution response with a full audit trail.
 */
export class SupeService {
  private readonly fetchImpl: FetchLike;
  private readonly bankApiUrl: string | undefined;
  private readonly bankApiKey: string | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    options: SupeServiceOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch();
    this.bankApiUrl = options.bankApiUrl;
    this.bankApiKey = options.bankApiKey;
  }

  // ════════════════════════════════════════════════
  // Inbound — fund upload credit
  // ════════════════════════════════════════════════

  private async ensureSupeFundingAccount(currency: string): Promise<string> {
    const code = `${SUPE_FUNDING_PREFIX}-${currency}`;
    const existing = await this.prisma.account.findUnique({ where: { code }, select: { code: true } });
    if (existing) return existing.code;
    await this.prisma.account.create({
      data: { code, name: `System funding (${currency})`, type: "ASSET", subtype: "FUNDING", currency },
    });
    return code;
  }

  private async ensurePlatformReserve(currency: string): Promise<string> {
    const code = `PLATFORM:RESERVE:${currency}`;
    const existing = await this.prisma.account.findUnique({
      where: { code },
      select: { type: true, subtype: true },
    });
    if (existing) {
      // A reserve must be a LIABILITY so an inbound credit increases its
      // balance. Legacy rows created as ASSET would make the ledger reject the
      // posting as insufficient funds, so self-heal the type on every use.
      if (existing.type !== "LIABILITY" || existing.subtype !== "RESERVE") {
        await this.prisma.account.update({
          where: { code },
          data: { type: "LIABILITY", subtype: "RESERVE" },
        });
        logger.warn({ code }, "SUPE: platform reserve re-typed to LIABILITY");
      }
      return code;
    }
    await this.prisma.account.create({
      data: { code, name: `Platform Reserve (${currency})`, type: "LIABILITY", subtype: "RESERVE", currency },
    });
    return code;
  }

  async processFundUpload(body: Record<string, unknown>, ctx: SupeContext) {
    const b = body as {
      format?: string;
      amount?: string;
      currency?: string;
      reference?: string;
      sender?: string;
      senderAccount?: string;
      date?: string;
      description?: string;
      destination?: string;
      note?: string;
      fileName?: string;
    };

    if (!b.amount || !b.currency || !b.reference) {
      throw new ValidationError("amount, currency and reference are required");
    }

    const amount = new Decimal(String(b.amount).replace(",", "."));
    if (!amount.isFinite() || amount.lte(0)) throw new ValidationError("amount must be positive");
    if (amount.gt("50000000")) throw new ValidationError("amount exceeds maximum limit");

    const currency = b.currency.toUpperCase();
    const reference = b.reference.trim();
    const normalizedAmount = amount.toFixed(4);

    const journalRef =
      "SUPE-" +
      createHash("sha256")
        .update(`${ctx.merchantId || ctx.userId || "admin"}:${reference}`)
        .digest("hex")
        .slice(0, 32)
        .toUpperCase();

    const existing = await this.prisma.journalEntry.findUnique({
      where: { reference: journalRef },
      select: { reference: true },
    });
    if (existing) throw new ConflictError(`Reference ${reference} has already been processed`);

    let destAccountCode: string;
    let destinationLabel: string;
    if (b.destination === "platform-reserve") {
      destAccountCode = await this.ensurePlatformReserve(currency);
      destinationLabel = "Platform Reserve";
    } else {
      const merchantId = ctx.merchantId;
      const wallet = merchantId
        ? await this.prisma.wallet.findFirst({
            where: { merchantId, status: "ACTIVE" },
            include: { account: true },
          })
        : null;
      if (wallet) {
        destAccountCode = wallet.account.code;
        destinationLabel = "Merchant wallet";
      } else {
        destAccountCode = await this.ensurePlatformReserve(currency);
        destinationLabel = merchantId
          ? "Platform Reserve (no active wallet for this currency)"
          : "Platform Reserve (no merchant context on this session)";
      }
    }

    const fundingAccount = await this.ensureSupeFundingAccount(currency);

    await ledgerService.postEntry({
      reference: journalRef,
      entryType: "TRANSFER",
      description: `SUPE: ${b.format || "fund upload"} — ${reference} — ${b.sender || "unknown sender"}`,
      source: "SUPE",
      postedBy: ctx.userId || "system",
      metadata: {
        supeFormat: b.format,
        originalReference: reference,
        sender: b.sender,
        senderAccount: b.senderAccount,
        valueDate: b.date,
        fileName: b.fileName,
        note: b.note,
        destination: b.destination,
        destinationAccount: destAccountCode,
        currency,
      },
      lines: [
        { accountCode: fundingAccount, debit: normalizedAmount, credit: "0" },
        { accountCode: destAccountCode, debit: "0", credit: normalizedAmount },
      ],
    });

    await this.prisma.auditLog.create({
      data: {
        userId: ctx.userId,
        merchantId: ctx.merchantId,
        action: "SUPE_FUND_UPLOAD",
        entity: "JournalEntry",
        entityId: journalRef,
        ipAddress: ctx.ip,
        after: {
          amount: normalizedAmount,
          currency,
          reference,
          format: b.format,
          destination: b.destination,
          destinationAccount: destAccountCode,
        },
      },
    });

    logger.info({ journalRef, amount: normalizedAmount, currency, reference }, "SUPE fund upload credited");

    return {
      journalEntryRef: journalRef,
      fileName: b.fileName || null,
      amount: normalizedAmount,
      currency,
      reference,
      format: b.format,
      destination: destAccountCode,
      destinationLabel,
      status: "CREDITED",
      message: `${normalizedAmount} ${currency} credited to ${destinationLabel}`,
    };
  }

  async listUploads(ctx: SupeContext, limit: number) {
    const isAdmin = ctx.role && ADMIN_ROLES.includes(ctx.role);
    const uploads = await this.prisma.journalEntry.findMany({
      where: { source: "SUPE", ...(isAdmin ? {} : { postedBy: ctx.userId || "" }) },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        reference: true,
        description: true,
        createdAt: true,
        status: true,
        metadata: true,
        lines: { select: { credit: true, account: { select: { code: true } } }, where: { credit: { not: "0" } }, take: 1 },
      },
    });

    return uploads.map((u) => {
      const meta = u.metadata as Record<string, unknown> | null;
      const creditLine = u.lines[0];
      return {
        reference: meta?.originalReference || u.reference,
        journalRef: u.reference,
        amount: creditLine?.credit || "0",
        currency: (meta?.currency as string) || "USD",
        format: (meta?.supeFormat as string) || "Unknown",
        sender: (meta?.sender as string) || "",
        fileName: (meta?.fileName as string) || "",
        status: u.status === "POSTED" ? "CREDITED" : u.status,
        createdAt: u.createdAt,
        destination: creditLine?.account.code || "",
      };
    });
  }

  async getUploadForPdf(reference: string, ctx: SupeContext) {
    const isAdmin = ctx.role && ADMIN_ROLES.includes(ctx.role);
    const entry = await this.prisma.journalEntry.findFirst({
      where: {
        source: "SUPE",
        OR: [{ reference }, { metadata: { path: ["originalReference"], equals: reference } }],
      },
      include: { lines: { include: { account: true } } },
    });
    if (!entry) throw new NotFoundError("Incoming payment", reference);
    if (!isAdmin && entry.postedBy !== ctx.userId) throw new NotFoundError("Incoming payment", reference);
    return entry;
  }

  // ════════════════════════════════════════════════
  // HMAC verification (shared by XML ingest + bank callback)
  // ════════════════════════════════════════════════

  /**
   * Verifies an inbound HMAC signature against the HmacKey table and returns
   * the merchant the key belongs to. Throws on any failure.
   */
  async verifyInboundHmac(payload: Buffer, headers: Record<string, string | string[] | undefined>) {
    const keyId = headers["x-primestack-key-id"] as string | undefined;
    const signature = headers["x-primestack-signature"] as string | undefined;
    if (!keyId || !signature) {
      throw new UnauthorizedError("Missing X-PrimeStack-Key-Id or X-PrimeStack-Signature header");
    }
    const hmacKey = await this.prisma.hmacKey.findFirst({
      where: { keyId, status: "ACTIVE" },
      include: { merchant: { select: { id: true } } },
    });
    if (!hmacKey) throw new UnauthorizedError("Unknown or inactive key ID");
    const expected = createHmac("sha256", hmacKey.secret).update(payload).digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new UnauthorizedError("HMAC signature verification failed");
    }
    return { keyId, merchantId: hmacKey.merchant?.id };
  }

  // ════════════════════════════════════════════════
  // Inbound — ISO 20022 / XML ingest (server-to-server)
  // ════════════════════════════════════════════════

  /**
   * Two-phase inbound bank-feed handler (replaces the old instant-credit ingest).
   *
   * Phase 1 — INITIATION (pacs.008 / pain.001):
   *   The bank sends a payment initiation. SUPE records it as PENDING in the
   *   InboundPayment table. The ledger is NOT touched yet.
   *
   * Phase 2 — CONFIRMATION (camt.054 credit notification OR pacs.002 ACSC):
   *   The bank confirms the funds have settled. SUPE promotes the PENDING
   *   record to CREDITED, then posts the double-entry ledger entry. This is
   *   the moment the merchant wallet balance increases.
   *
   * pacs.002 non-ACSC (RJCT, ACSP, etc.) → REJECTED or left as PENDING.
   * Unknown / unroutable message → ACKNOWLEDGED, no DB change.
   */
  async ingestXml(
    payload: Buffer,
    headers: Record<string, string | string[] | undefined>,
    ip?: string,
  ) {
    const bodyStr = payload.toString("utf8");
    if (!bodyStr || bodyStr.length < 10) {
      throw new ValidationError("Empty or invalid XML body");
    }

    // ── Checksum verification ────────────────────
    const providedChecksum = headers["x-checksum-sha256"] as string | undefined;
    if (providedChecksum) {
      const actualChecksum = createHash("sha256").update(payload).digest("hex");
      if (actualChecksum !== providedChecksum) {
        throw new ValidationError("SHA256 checksum mismatch — file may be corrupted");
      }
    }

    const { keyId, merchantId } = await this.verifyInboundHmac(payload, headers);
    const msgType = detectIso20022MessageType(bodyStr);

    // ── Route by message type ────────────────────
    if (msgType === "pacs.008" || msgType === "pain.001") {
      return this._handleInitiation(bodyStr, msgType, keyId, merchantId, providedChecksum, ip);
    }
    if (msgType === "camt.054") {
      return this._handleCamt054Confirmation(bodyStr, keyId, merchantId, ip);
    }
    if (msgType === "pacs.002") {
      return this._handlePacs002StatusReport(bodyStr, keyId, merchantId, ip);
    }

    // All other message types are acknowledged but do not change state.
    logger.info({ msgType, keyId }, "SUPE bank feed: acknowledged non-fund message");
    return {
      format: msgType,
      status: "ACKNOWLEDGED",
      credited: false,
      message: `${msgType} received and acknowledged — no ledger entry created`,
    };
  }

  /** Phase 1: record an initiation message as PENDING — no ledger credit yet. */
  private async _handleInitiation(
    xml: string,
    msgType: string,
    keyId: string,
    merchantId: string | undefined,
    checksum: string | undefined,
    ip: string | undefined,
  ) {
    const parsed = parseInitiationMessage(xml);
    if (!parsed.endToEndId) throw new ValidationError("Could not extract EndToEndId from initiation message");
    if (!parsed.amount || !parsed.currency) throw new ValidationError("Could not extract amount/currency from initiation message");

    const existing = await this.prisma.inboundPayment.findUnique({
      where: { endToEndId: parsed.endToEndId },
    });
    if (existing) {
      // Idempotent: same initiation seen again — return current state without error.
      logger.info({ endToEndId: parsed.endToEndId, status: existing.status }, "SUPE: duplicate initiation ignored");
      return {
        format: msgType,
        status: existing.status,
        credited: existing.status === "CREDITED",
        endToEndId: parsed.endToEndId,
        amount: existing.amount?.toFixed(4) ?? parsed.amount,
        currency: existing.currency ?? parsed.currency,
        message: `Payment ${parsed.endToEndId} already recorded (status: ${existing.status})`,
      };
    }

    const record = await this.prisma.inboundPayment.create({
      data: {
        endToEndId: parsed.endToEndId,
        status: "PENDING",
        amount: parsed.amount,   // stored as string; Prisma casts to Decimal(20,4)
        currency: parsed.currency,
        sender: parsed.sender ?? null,
        valueDate: parsed.valueDate ?? null,
        sourceFormat: msgType,
        source: "BANK_FEED",
        merchantId: merchantId ?? null,
        keyId: keyId ?? null,
      },
    });

    if (merchantId) {
      await this.prisma.auditLog.create({
        data: {
          merchantId,
          action: "SUPE_INBOUND_PENDING",
          entity: "InboundPayment",
          entityId: record.id,
          ipAddress: ip,
          after: {
            endToEndId: parsed.endToEndId,
            amount: parsed.amount,
            currency: parsed.currency,
            msgType,
            checksum: checksum ?? null,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    logger.info({ endToEndId: parsed.endToEndId, amount: parsed.amount, currency: parsed.currency, msgType }, "SUPE bank feed: initiation recorded as PENDING");

    return {
      format: msgType,
      status: "PENDING" as SupeInboundStatus,
      credited: false,
      endToEndId: parsed.endToEndId,
      amount: parsed.amount,
      currency: parsed.currency,
      message: `Payment ${parsed.endToEndId} recorded as PENDING — awaiting bank confirmation`,
    };
  }

  /** Phase 2a: camt.054 credit notification — finalise and credit the ledger. */
  private async _handleCamt054Confirmation(
    xml: string,
    keyId: string,
    merchantId: string | undefined,
    ip: string | undefined,
  ) {
    const parsed = parseCamt054CreditNotification(xml);
    if (!parsed.endToEndId) throw new ValidationError("Could not extract EndToEndId from camt.054");

    if (!parsed.isCredit) {
      logger.info({ endToEndId: parsed.endToEndId }, "SUPE: camt.054 is a debit notification — ignored");
      return {
        format: "camt.054",
        status: "ACKNOWLEDGED",
        credited: false,
        endToEndId: parsed.endToEndId,
        message: "camt.054 debit notification acknowledged — no credit action",
      };
    }

    const record = await this.prisma.inboundPayment.findUnique({
      where: { endToEndId: parsed.endToEndId },
    });

    // If no PENDING record exists (bank sent confirmation without prior initiation),
    // create one and credit in a single step — this handles straight-through feeds.
    const amount = parsed.amount ?? record?.amount?.toFixed(4);
    const currency = parsed.currency ?? record?.currency;
    if (!amount || !currency) throw new ValidationError(`camt.054 for ${parsed.endToEndId}: cannot determine amount/currency`);

    if (record?.status === "CREDITED") {
      logger.info({ endToEndId: parsed.endToEndId }, "SUPE: camt.054 confirmation already applied");
      return {
        format: "camt.054",
        status: "CREDITED" as SupeInboundStatus,
        credited: true,
        endToEndId: parsed.endToEndId,
        journalEntryRef: record.journalEntryRef,
        message: `Payment ${parsed.endToEndId} already credited`,
      };
    }

    return this._creditInboundPayment({
      record: record ?? null,
      endToEndId: parsed.endToEndId,
      amount,
      currency,
      sender: parsed.sender ?? record?.sender ?? null,
      valueDate: parsed.valueDate ?? record?.valueDate ?? null,
      sourceFormat: "camt.054",
      keyId,
      merchantId: merchantId ?? record?.merchantId ?? undefined,
      ip,
    });
  }

  /** Phase 2b: pacs.002 status report — ACSC finalises credit, RJCT rejects. */
  private async _handlePacs002StatusReport(
    xml: string,
    keyId: string,
    merchantId: string | undefined,
    ip: string | undefined,
  ) {
    const report = parsePacs002StatusReport(xml);
    const endToEndId = report.orgnlEndToEndId;
    if (!endToEndId) throw new ValidationError("Could not extract OrgnlEndToEndId from pacs.002");

    const record = await this.prisma.inboundPayment.findUnique({ where: { endToEndId } });

    if (report.status === "REJECTED") {
      const updated = await this.prisma.inboundPayment.upsert({
        where: { endToEndId },
        create: {
          endToEndId,
          status: "REJECTED",
          sourceFormat: "pacs.002",
          source: "BANK_FEED",
          rejectionReason: report.rejectionReason ?? "Rejected by bank",
          merchantId: merchantId ?? null,
          keyId: keyId ?? null,
        },
        update: {
          status: "REJECTED",
          rejectionReason: report.rejectionReason ?? "Rejected by bank",
        },
      });
      logger.warn({ endToEndId, reason: report.rejectionReason }, "SUPE: bank rejected inbound payment");
      return {
        format: "pacs.002",
        status: "REJECTED" as SupeInboundStatus,
        credited: false,
        endToEndId,
        rejectionReason: updated.rejectionReason,
        message: `Payment ${endToEndId} rejected by bank: ${updated.rejectionReason ?? "unknown reason"}`,
      };
    }

    if (report.status === "EXECUTED") {
      if (record?.status === "CREDITED") {
        return {
          format: "pacs.002",
          status: "CREDITED" as SupeInboundStatus,
          credited: true,
          endToEndId,
          journalEntryRef: record.journalEntryRef,
          message: `Payment ${endToEndId} already credited`,
        };
      }

      const amount = record?.amount?.toFixed(4);
      const currency = record?.currency;
      if (!amount || !currency) {
        throw new ValidationError(
          `pacs.002 ACSC for ${endToEndId}: no pending record with amount/currency — send initiation (pacs.008) first`,
        );
      }

      return this._creditInboundPayment({
        record: record ?? null,
        endToEndId,
        amount,
        currency,
        sender: record?.sender ?? null,
        valueDate: record?.valueDate ?? null,
        sourceFormat: "pacs.002",
        keyId,
        merchantId: merchantId ?? record?.merchantId ?? undefined,
        ip,
      });
    }

    // ACCEPTED / PENDING — update status but do not credit yet.
    if (record) {
      await this.prisma.inboundPayment.update({
        where: { endToEndId },
        data: { status: "CONFIRMED", confirmedAt: new Date() },
      });
    }
    return {
      format: "pacs.002",
      status: "CONFIRMED" as SupeInboundStatus,
      credited: false,
      endToEndId,
      message: `Payment ${endToEndId} accepted by bank — awaiting settlement`,
    };
  }

  /** Shared credit finaliser: post the double-entry and mark CREDITED. */
  private async _creditInboundPayment(opts: {
    record: InboundPayment | null;
    endToEndId: string;
    amount: string;
    currency: string;
    sender: string | null;
    valueDate: string | null;
    sourceFormat: string;
    keyId: string;
    merchantId: string | undefined;
    ip: string | undefined;
  }) {
    const { endToEndId, amount, currency, sender, valueDate, sourceFormat, keyId, merchantId, ip } = opts;
    const normalizedAmount = new Decimal(amount).toFixed(4);

    const journalRef =
      "SUPE-" +
      createHash("sha256")
        .update(`${merchantId ?? keyId ?? "ingest"}:${endToEndId}`)
        .digest("hex")
        .slice(0, 32)
        .toUpperCase();

    const existingJournal = await this.prisma.journalEntry.findUnique({
      where: { reference: journalRef },
      select: { reference: true },
    });
    if (existingJournal) {
      // Credit already posted — idempotent response.
      await this.prisma.inboundPayment.update({
        where: { endToEndId },
        data: { status: "CREDITED", journalEntryRef: journalRef, creditedAt: new Date() },
      }).catch(() => {});
      return {
        format: sourceFormat,
        status: "CREDITED" as SupeInboundStatus,
        credited: true,
        endToEndId,
        journalEntryRef: journalRef,
        amount: normalizedAmount,
        currency,
        message: `Payment ${endToEndId} already credited (journal: ${journalRef})`,
      };
    }

    // Resolve destination account.
    let destCode: string;
    if (merchantId) {
      const wallet = await this.prisma.wallet.findFirst({
        where: { merchantId, status: "ACTIVE" },
        include: { account: true },
      });
      destCode = wallet?.account.code ?? (await this.ensurePlatformReserve(currency));
    } else {
      destCode = await this.ensurePlatformReserve(currency);
    }

    const fundingCode = await this.ensureSupeFundingAccount(currency);

    await ledgerService.postEntry({
      reference: journalRef,
      entryType: "TRANSFER",
      description: `SUPE bank feed: ${sourceFormat} — ${endToEndId} — ${sender ?? "unknown sender"}`,
      source: "SUPE",
      postedBy: keyId ?? "ingest",
      metadata: {
        supeFormat: sourceFormat,
        originalReference: endToEndId,
        externalReference: endToEndId,
        sender,
        valueDate,
        currency,
        keyId,
        destination: destCode,
        ingestedAt: new Date().toISOString(),
      },
      lines: [
        { accountCode: fundingCode, debit: normalizedAmount, credit: "0" },
        { accountCode: destCode, debit: "0", credit: normalizedAmount },
      ],
    });

    // Promote the InboundPayment record to CREDITED (upsert in case camt.054
    // arrived before any initiation message — straight-through feeds).
    await this.prisma.inboundPayment.upsert({
      where: { endToEndId },
      create: {
        endToEndId,
        status: "CREDITED",
        amount: normalizedAmount,  // stored as string; Prisma casts to Decimal(20,4)
        currency,
        sender: sender ?? null,
        valueDate: valueDate ?? null,
        sourceFormat,
        source: "BANK_FEED",
        journalEntryRef: journalRef,
        merchantId: merchantId ?? null,
        keyId: keyId ?? null,
        creditedAt: new Date(),
      },
      update: {
        status: "CREDITED",
        journalEntryRef: journalRef,
        creditedAt: new Date(),
        confirmedAt: new Date(),
      },
    });

    if (merchantId) {
      await this.prisma.auditLog.create({
        data: {
          merchantId,
          action: "SUPE_INBOUND_CREDITED",
          entity: "InboundPayment",
          entityId: journalRef,
          ipAddress: ip,
          after: { amount: normalizedAmount, currency, endToEndId, format: sourceFormat, keyId } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    logger.info({ journalRef, amount: normalizedAmount, currency, endToEndId, sourceFormat }, "SUPE bank feed: payment credited");

    return {
      format: sourceFormat,
      status: "CREDITED" as SupeInboundStatus,
      credited: true,
      endToEndId,
      journalEntryRef: journalRef,
      amount: normalizedAmount,
      currency,
      destination: destCode,
      message: `${normalizedAmount} ${currency} credited from bank feed (${sourceFormat})`,
    };
  }

  // ── List and get InboundPayments ─────────────────

  async listInboundPayments(
    filters: { status?: string; limit: number },
    ctx: SupeContext,
  ) {
    const isAdmin = ctx.role && ADMIN_ROLES.includes(ctx.role);
    const where: Prisma.InboundPaymentWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (!isAdmin) where.merchantId = ctx.merchantId ?? null;

    const rows = await this.prisma.inboundPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: filters.limit,
    });

    return rows.map((r) => ({
      id: r.id,
      endToEndId: r.endToEndId,
      status: r.status as SupeInboundStatus,
      amount: r.amount?.toFixed(4) ?? null,
      currency: r.currency,
      sender: r.sender,
      sourceFormat: r.sourceFormat,
      journalEntryRef: r.journalEntryRef,
      rejectionReason: r.rejectionReason,
      valueDate: r.valueDate,
      receivedAt: r.receivedAt,
      confirmedAt: r.confirmedAt,
      creditedAt: r.creditedAt,
    }));
  }

  async getInboundPayment(endToEndId: string, ctx: SupeContext) {
    const isAdmin = ctx.role && ADMIN_ROLES.includes(ctx.role);
    const record = await this.prisma.inboundPayment.findUnique({ where: { endToEndId } });
    if (!record) throw new NotFoundError("Inbound payment", endToEndId);
    if (!isAdmin && record.merchantId && record.merchantId !== ctx.merchantId) {
      throw new NotFoundError("Inbound payment", endToEndId);
    }
    return {
      id: record.id,
      endToEndId: record.endToEndId,
      status: record.status as SupeInboundStatus,
      amount: record.amount?.toFixed(4) ?? null,
      currency: record.currency,
      sender: record.sender,
      sourceFormat: record.sourceFormat,
      journalEntryRef: record.journalEntryRef,
      rejectionReason: record.rejectionReason,
      valueDate: record.valueDate,
      receivedAt: record.receivedAt,
      confirmedAt: record.confirmedAt,
      creditedAt: record.creditedAt,
    };
  }

  // ════════════════════════════════════════════════
  // Outbound — bank-grade settlement instruction
  // ════════════════════════════════════════════════

  private requireAdmin(ctx: SupeContext): void {
    if (!ctx.role || !ADMIN_ROLES.includes(ctx.role)) {
      throw new ForbiddenError("Your role cannot manage settlement instructions");
    }
  }

  /** Sum the gross movement (total debits) of referenced ledger entries. */
  private async deriveAmountFromJournal(
    refs: string[],
    expectedCurrency: string,
  ): Promise<{ amount: string; currency: string }> {
    const entries = await this.prisma.journalEntry.findMany({
      where: { reference: { in: refs } },
      include: { lines: { include: { account: { select: { currency: true } } } } },
    });

    if (entries.length !== refs.length) {
      const found = new Set(entries.map((e) => e.reference));
      const missing = refs.filter((r) => !found.has(r));
      throw new ValidationError(`Referenced ledger entries not found: ${missing.join(", ")}`);
    }

    let total = new Decimal(0);
    let currency: string | null = null;
    for (const entry of entries) {
      if (entry.status !== "POSTED") {
        throw new ValidationError(`Referenced ledger entry ${entry.reference} is not POSTED (status: ${entry.status})`);
      }
      for (const line of entry.lines) {
        const debit = new Decimal(line.debit);
        if (debit.gt(0)) {
          total = total.plus(debit);
          const lineCurrency = line.account.currency;
          if (!currency) currency = lineCurrency;
          else if (currency !== lineCurrency) {
            throw new ValidationError("Referenced ledger entries span multiple currencies");
          }
        }
      }
    }

    if (total.lte(0)) throw new ValidationError("Referenced ledger entries have no debit value to settle");
    const derivedCurrency = currency ?? expectedCurrency;
    if (derivedCurrency !== expectedCurrency) {
      throw new ValidationError(
        `Derived currency ${derivedCurrency} does not match instruction currency ${expectedCurrency}`,
      );
    }
    return { amount: total.toFixed(4), currency: derivedCurrency };
  }

  async createInstruction(raw: unknown, ctx: SupeContext) {
    this.requireAdmin(ctx);
    const input = createInstructionSchema.parse(raw) as CreateInstructionInput;

    // Resolve amount: explicit, or derived from referenced ledger entries.
    let amount = input.amount;
    let derivedFromLedger = false;
    if (!amount) {
      const refs = input.sourceJournalRefs!;
      const derived = await this.deriveAmountFromJournal(refs, input.currency);
      amount = derived.amount;
      derivedFromLedger = true;
    }
    const normalizedAmount = new Decimal(amount).toFixed(4);

    const messageId = `PSI${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const paymentInfoId = `${messageId}-PMT`;
    const endToEndId = input.endToEndId || messageId;
    const uetr = randomUUID();
    const createdAt = new Date().toISOString();

    const reference =
      "SUPE-SI-" +
      createHash("sha256")
        .update(`${messageId}:${input.debtor.iban}:${normalizedAmount}:${input.currency}`)
        .digest("hex")
        .slice(0, 24)
        .toUpperCase();

    const existing = await this.prisma.settlementInstruction.findUnique({
      where: { reference },
      select: { reference: true },
    });
    if (existing) throw new ConflictError("Settlement instruction already exists for these details");

    const renderInput: InstructionRenderInput = {
      reference,
      messageId,
      paymentInfoId,
      endToEndId,
      uetr,
      createdAt,
      valueDate: input.valueDate ?? null,
      amount: normalizedAmount,
      currency: input.currency,
      debtor: input.debtor,
      creditor: input.creditor,
      remittanceInformation: input.remittanceInformation ?? null,
    };
    const payload = renderInstructionPayload(input.format, renderInput);

    const created = await this.prisma.settlementInstruction.create({
      data: {
        reference,
        status: "DRAFT",
        format: input.format,
        channel: input.channel,
        amount: normalizedAmount,
        currency: input.currency,
        valueDate: input.valueDate ?? null,
        messageId,
        endToEndId,
        uetr,
        debtor: input.debtor as unknown as Prisma.InputJsonValue,
        creditor: input.creditor as unknown as Prisma.InputJsonValue,
        remittanceInfo: input.remittanceInformation ?? null,
        sourceJournalRefs: input.sourceJournalRefs ?? [],
        payload,
        merchantId: ctx.merchantId ?? null,
        createdByUserId: ctx.userId ?? null,
      },
    });

    await this.audit(ctx, "SUPE_INSTRUCTION_CREATE", reference, {
      amount: normalizedAmount,
      currency: input.currency,
      format: input.format,
      channel: input.channel,
      derivedFromLedger,
      sourceJournalRefs: input.sourceJournalRefs ?? [],
    });

    logger.info({ reference, amount: normalizedAmount, currency: input.currency, format: input.format }, "SUPE settlement instruction created");

    return this.toInstructionDto(created);
  }

  async transmit(
    reference: string,
    raw: unknown,
    ctx: SupeContext,
  ): Promise<{ reference: string; status: SupeInstructionStatus; channel: SupeTransmissionChannel; transmitted: boolean; bankResponse?: unknown; message: string }> {
    this.requireAdmin(ctx);
    const instruction = await this.getOwnInstruction(reference, ctx);
    if (instruction.status !== "DRAFT") {
      throw new ConflictError(`Settlement instruction ${reference} is ${instruction.status} and cannot be transmitted`);
    }

    const overrides = (raw ?? {}) as { bankApiUrl?: string; bankApiKey?: string };
    const channel = instruction.channel as SupeTransmissionChannel;
    const format = instruction.format as SupeSettlementFormat;

    let bankResponse: Record<string, unknown> | undefined;
    let accepted = false;

    if (channel === "BANK_API") {
      const url = overrides.bankApiUrl ?? this.bankApiUrl;
      const key = overrides.bankApiKey ?? this.bankApiKey;
      if (!url) {
        throw new ValidationError("Bank API endpoint is not configured (set SUPE_BANK_API_URL or pass bankApiUrl)");
      }
      const headers: Record<string, string> = {
        "Content-Type": formatMime(format),
        "X-PrimeStack-Reference": reference,
      };
      if (key) headers.Authorization = `Bearer ${key}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSMIT_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: instruction.payload ?? "",
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        bankResponse = { httpStatus: res.status, body: parsed };
        accepted = res.status >= 200 && res.status < 300;
      } catch (err) {
        bankResponse = { error: err instanceof Error ? err.message : "transmission failed" };
        logger.warn({ reference, err: err instanceof Error ? err.message : String(err) }, "SUPE BANK_API transmission failed");
      } finally {
        clearTimeout(timer);
      }
    }

    // SFTP / FILE_UPLOAD / MANUAL need no live network — the payload is
    // delivered out of band and the bank reports back via the callback.
    const newStatus: SupeInstructionStatus = accepted ? "ACCEPTED" : "SUBMITTED";
    const now = new Date();
    await this.prisma.settlementInstruction.update({
      where: { reference },
      data: {
        status: newStatus,
        submittedAt: now,
        ...(accepted ? { acceptedAt: now } : {}),
        ...(bankResponse ? { bankResponse: bankResponse as Prisma.InputJsonValue } : {}),
      },
    });

    await this.audit(ctx, "SUPE_INSTRUCTION_TRANSMIT", reference, {
      channel,
      status: newStatus,
      bankResponse: bankResponse ?? null,
    });

    logger.info({ reference, channel, status: newStatus }, "SUPE settlement instruction transmitted");

    return {
      reference,
      status: newStatus,
      channel,
      transmitted: channel !== "MANUAL",
      ...(bankResponse ? { bankResponse } : {}),
      message:
        channel === "BANK_API"
          ? accepted
            ? "Transmitted to bank API and accepted"
            : "Transmitted to bank API — awaiting bank confirmation"
          : `Instruction ready for ${channel} delivery (download the ${formatExtension(format).toUpperCase()} file)`,
    };
  }

  /** Automated bank callback — applies a parsed pacs.002 status report.
   *  The bank references the original EndToEndId / InstrId we sent, so the
   *  instruction is located by those IDs, not by our internal reference. */
  async applyBankStatusReport(report: ParsedPacs002, ctx: SupeContext) {
    if (!report.status) {
      throw new ValidationError("pacs.002 report has no mappable TxSts code");
    }

    // Locate the instruction the bank is reporting on.
    const or: Prisma.SettlementInstructionWhereInput[] = [];
    if (report.orgnlEndToEndId) or.push({ endToEndId: report.orgnlEndToEndId });
    if (report.orgnlInstrId) or.push({ messageId: report.orgnlInstrId });
    if (or.length === 0) throw new ValidationError("pacs.002 report carries no original reference");

    const instruction = await this.prisma.settlementInstruction.findFirst({ where: { OR: or } });
    if (!instruction) throw new NotFoundError("Settlement instruction", report.orgnlEndToEndId ?? report.orgnlInstrId ?? "");
    if (!["SUBMITTED", "ACCEPTED"].includes(instruction.status)) {
      throw new ConflictError(
        `Settlement instruction ${instruction.reference} is ${instruction.status} and cannot receive a bank callback`,
      );
    }

    const now = new Date();
    const data: Prisma.SettlementInstructionUpdateInput = {
      bankResponse: {
        txSts: report.txSts,
        acctSvcrRef: report.acctSvcrRef,
        reason: report.reason,
        orgnlEndToEndId: report.orgnlEndToEndId,
        orgnlInstrId: report.orgnlInstrId,
      } as Prisma.InputJsonValue,
    };

    if (report.status === "ACCEPTED") {
      data.status = "ACCEPTED";
      data.acceptedAt = now;
    } else if (report.status === "REJECTED") {
      data.status = "REJECTED";
      data.rejectionReason = report.rejectionReason;
    } else {
      // EXECUTED
      data.status = "EXECUTED";
      data.executedAt = now;
      data.bankTransactionRef = report.bankTransactionRef ?? instruction.bankTransactionRef;
    }

    const updated = await this.prisma.settlementInstruction.update({
      where: { reference: instruction.reference },
      data,
    });

    await this.audit(
      ctx,
      "SUPE_INSTRUCTION_CALLBACK",
      instruction.reference,
      { txSts: report.txSts, status: report.status, bankTransactionRef: report.bankTransactionRef },
    );

    logger.info(
      { reference: instruction.reference, txSts: report.txSts, status: report.status },
      "SUPE bank pacs.002 status report processed",
    );

    return this.toInstructionDto(updated);
  }

  /** Admin manually confirms the bank executed the transaction. */
  async confirmExecution(reference: string, raw: unknown, ctx: SupeContext) {
    this.requireAdmin(ctx);
    const input = (raw ?? {}) as { bankTransactionRef: string };
    if (!input.bankTransactionRef || input.bankTransactionRef.trim() === "") {
      throw new ValidationError("bankTransactionRef is required to confirm execution");
    }

    const instruction = await this.getOwnInstruction(reference, ctx);
    if (!["SUBMITTED", "ACCEPTED"].includes(instruction.status)) {
      throw new ConflictError(`Settlement instruction ${reference} is ${instruction.status} and cannot be executed`);
    }

    const now = new Date();
    const updated = await this.prisma.settlementInstruction.update({
      where: { reference },
      data: { status: "EXECUTED", executedAt: now, bankTransactionRef: input.bankTransactionRef.trim() },
    });

    await this.audit(ctx, "SUPE_INSTRUCTION_EXECUTE", reference, { bankTransactionRef: input.bankTransactionRef });
    logger.info({ reference, bankTransactionRef: input.bankTransactionRef }, "SUPE settlement instruction executed");

    return this.toInstructionDto(updated);
  }

  async rejectInstruction(reference: string, raw: unknown, ctx: SupeContext) {
    this.requireAdmin(ctx);
    const input = (raw ?? {}) as { reason: string };
    if (!input.reason || input.reason.trim() === "") {
      throw new ValidationError("reason is required to reject an instruction");
    }

    const instruction = await this.getOwnInstruction(reference, ctx);
    if (instruction.status === "EXECUTED" || instruction.status === "CANCELLED") {
      throw new ConflictError(`Settlement instruction ${reference} is ${instruction.status} and cannot be rejected`);
    }

    const updated = await this.prisma.settlementInstruction.update({
      where: { reference },
      data: { status: "REJECTED", rejectionReason: input.reason.trim() },
    });

    await this.audit(ctx, "SUPE_INSTRUCTION_REJECT", reference, { reason: input.reason });
    logger.info({ reference, reason: input.reason }, "SUPE settlement instruction rejected");

    return this.toInstructionDto(updated);
  }

  async cancelInstruction(reference: string, ctx: SupeContext) {
    this.requireAdmin(ctx);
    const instruction = await this.getOwnInstruction(reference, ctx);
    if (instruction.status !== "DRAFT") {
      throw new ConflictError(`Settlement instruction ${reference} is ${instruction.status} and can only be cancelled from DRAFT`);
    }

    const updated = await this.prisma.settlementInstruction.update({
      where: { reference },
      data: { status: "CANCELLED" },
    });

    await this.audit(ctx, "SUPE_INSTRUCTION_CANCEL", reference, {});
    logger.info({ reference }, "SUPE settlement instruction cancelled");

    return this.toInstructionDto(updated);
  }

  async getInstruction(reference: string, ctx: SupeContext) {
    const instruction = await this.getOwnInstruction(reference, ctx);
    return this.toInstructionDto(instruction);
  }

  async listInstructions(
    filters: { status?: string; currency?: string; limit: number },
    ctx: SupeContext,
  ) {
    const isAdmin = ctx.role && ADMIN_ROLES.includes(ctx.role);
    const where: Prisma.SettlementInstructionWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.currency) where.currency = filters.currency;
    if (!isAdmin) where.merchantId = ctx.merchantId ?? null;

    const rows = await this.prisma.settlementInstruction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: filters.limit,
    });

    return rows.map((r) => this.toInstructionDto(r));
  }

  async getPayload(reference: string, ctx: SupeContext) {
    const instruction = await this.getOwnInstruction(reference, ctx);
    const format = instruction.format as SupeSettlementFormat;
    return {
      mime: formatMime(format),
      extension: formatExtension(format),
      reference,
      payload: instruction.payload ?? "",
    };
  }

  // ── helpers ─────────────────────────────────────

  private async getOwnInstruction(reference: string, ctx: SupeContext) {
    const instruction = await this.prisma.settlementInstruction.findUnique({ where: { reference } });
    if (!instruction) throw new NotFoundError("Settlement instruction", reference);
    const isAdmin = ctx.role && ADMIN_ROLES.includes(ctx.role);
    if (!isAdmin && instruction.merchantId && instruction.merchantId !== ctx.merchantId) {
      throw new NotFoundError("Settlement instruction", reference);
    }
    return instruction;
  }

  private async audit(
    ctx: SupeContext,
    action: string,
    reference: string,
    after: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        userId: ctx.userId,
        merchantId: ctx.merchantId,
        action,
        entity: "SettlementInstruction",
        entityId: reference,
        ipAddress: ctx.ip,
        after: after as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private toInstructionDto(r: Prisma.SettlementInstructionGetPayload<{}>) {
    return {
      reference: r.reference,
      status: r.status as SupeInstructionStatus,
      format: r.format as SupeSettlementFormat,
      channel: r.channel as SupeTransmissionChannel,
      amount: r.amount.toFixed(4),
      currency: r.currency,
      valueDate: r.valueDate,
      messageId: r.messageId,
      endToEndId: r.endToEndId,
      uetr: r.uetr,
      debtor: r.debtor,
      creditor: r.creditor,
      remittanceInfo: r.remittanceInfo,
      sourceJournalRefs: r.sourceJournalRefs,
      bankTransactionRef: r.bankTransactionRef,
      rejectionReason: r.rejectionReason,
      submittedAt: r.submittedAt,
      acceptedAt: r.acceptedAt,
      executedAt: r.executedAt,
      bankResponse: r.bankResponse,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      hasPayload: !!r.payload,
    };
  }
}
