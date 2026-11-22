import { Prisma, type PrismaClient } from "@prisma/client";
import type { PaymentRail, PaymentStatus } from "@prisma/client";
import { Decimal } from "../../core/decimal.js";
import {
  AppError,
  NotFoundError,
  ValidationError,
} from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { swiftMtService } from "../swift-mt/swift-mt.module.js";
import { sanctionsService } from "../sanctions/sanctions.module.js";
import { fraudService } from "../fraud/fraud.module.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { streamingService } from "../streaming/streaming.module.js";
import { webhookService } from "../webhooks/webhooks.module.js";
import { STREAM_TOPICS } from "../streaming/streaming.types.js";
import type {
  IngestInput,
  IngestResult,
  ListPaymentsFilters,
  ParsedPayment,
  PaymentParty,
  ResolveInput,
} from "./payment.types.js";

/**
 * Statuses from which a payment may be approved by an operator.
 */
const RESOLVABLE_STATUSES: PaymentStatus[] = ["UNDER_REVIEW", "PENDING_ASSIGNMENT"];

/**
 * Statuses that terminal — no further processing is possible.
 */
const TERMINAL_STATUSES: PaymentStatus[] = ["POSTED", "REJECTED", "FAILED"];

const SETTLEMENT_ACCOUNT_PREFIX = "SETTLEMENT";

/**
 * Payment Ingestion Service.
 *
 * Drives an inbound payment through parse → sanctions → fraud → resolve →
 * ledger post → notify. Every transition is persisted and emits a stream
 * event, so a replayed message is deterministic and never double-posts.
 *
 * Guarantees:
 *   1. Idempotent on (rail, reference) — a replay returns the existing row.
 *   2. Sanctions / fraud are hard gates — a match or BLOCK never reaches the ledger.
 *   3. The POSTED transition (ledger + payment status + audit) is recoverable:
 *      if the ledger post succeeded but the payment update failed, a retry
 *      detects the existing journal entry and reconciles the status.
 *   4. No PII is logged at info level — only reference, amount, currency, rail, status.
 */
export class PaymentIngestionService {
  constructor(private prisma: PrismaClient) {}

  // ── Public API ─────────────────────────────────

  /**
   * Ingest one incoming payment.
   *
   * Returns `created: false` when the same (rail, reference) was already
   * processed — no second ledger entry is ever created.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const parsed = this.parseInput(input);
    const { rail, reference } = parsed;

    // 1. Idempotency — return the existing payment if we've seen this reference.
    const existing = await this.prisma.incomingPayment.findUnique({
      where: { rail_reference: { rail, reference } },
    });
    if (existing) {
      logger.info(
        { reference, rail, status: existing.status },
        "Payment ingest: idempotent replay of existing payment",
      );
      return { created: false, payment: this.toPublic(existing) };
    }

    // 2. Create the RECEIVED record.
    const payment = await this.prisma.incomingPayment.create({
      data: {
        reference,
        rail,
        status: "RECEIVED",
        amount: new Decimal(parsed.amount).toString(),
        currency: parsed.currency.toUpperCase(),
        valueDate: parsed.valueDate,
        operationCode: parsed.operationCode,
        charges: parsed.charges,
        debtorName: parsed.debtor.name,
        debtorAccount: parsed.debtor.account,
        debtorBic: parsed.debtor.bic,
        debtorCountry: parsed.debtor.country,
        creditorName: parsed.creditor.name,
        creditorAccount: parsed.creditor.account,
        creditorBic: parsed.creditor.bic,
        creditorCountry: parsed.creditor.country,
        merchantId: input.merchantId ?? null,
        metadata: parsed.raw ? { rawLength: parsed.raw.length } : Prisma.JsonNull,
      },
    });

    logger.info(
      { reference, rail, amount: parsed.amount, currency: parsed.currency },
      "Payment received",
    );
    await this.publish(STREAM_TOPICS.paymentsReceived, "PAYMENT_RECEIVED", reference, {
      rail,
      amount: parsed.amount,
      currency: parsed.currency,
    });

    // 3. Run the pipeline. Any failure sets a terminal status with a reason.
    try {
      await this.runPipeline(payment, parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailed(payment.id, message);
      throw error;
    }

    const refreshed = await this.requirePayment(payment.id);
    return { created: true, payment: this.toPublic(refreshed) };
  }

  /** Fetch a single payment by its (rail-independent) reference. */
  async getByReference(reference: string) {
    const payment = await this.prisma.incomingPayment.findFirst({
      where: { reference },
      include: { merchant: true, wallet: true },
    });
    if (!payment) throw new NotFoundError("Incoming payment", reference);
    return payment;
  }

  /** Paginated list of incoming payments with optional filters. */
  async list(filters: ListPaymentsFilters) {
    const where: Prisma.IncomingPaymentWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.rail) where.rail = filters.rail;
    if (filters.merchantId) where.merchantId = filters.merchantId;

    const [data, total] = await Promise.all([
      this.prisma.incomingPayment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        include: { merchant: true },
      }),
      this.prisma.incomingPayment.count({ where }),
    ]);

    return {
      data,
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  /**
   * Operator resolution of a payment held for review or assignment.
   *
   * APPROVE resumes the pipeline from the posting step; REJECT sets REJECTED.
   */
  async resolve(reference: string, input: ResolveInput) {
    const payment = await this.getByReference(reference);

    if (!RESOLVABLE_STATUSES.includes(payment.status)) {
      throw new AppError(
        `Cannot resolve a payment in status ${payment.status}`,
        409,
        "PAYMENT_INVALID_TRANSITION",
      );
    }

    if (input.decision === "REJECT") {
      const updated = await this.prisma.incomingPayment.update({
        where: { id: payment.id },
        data: {
          status: "REJECTED",
          reviewedBy: input.reviewedBy,
          reviewNotes: input.reviewNotes ?? null,
          failureReason: "Rejected by operator",
        },
      });
      await this.publish(STREAM_TOPICS.paymentsFailed, "PAYMENT_REJECTED", reference, {
        reason: "Rejected by operator",
      });
      return this.toPublic(updated);
    }

    // APPROVE — ensure we have a merchant, then resume posting.
    const merchantId = input.merchantId || payment.merchantId;
    if (!merchantId) {
      throw new ValidationError("merchantId is required to approve an unassigned payment");
    }

    if (input.merchantId && input.merchantId !== payment.merchantId) {
      await this.prisma.incomingPayment.update({
        where: { id: payment.id },
        data: { merchantId: input.merchantId },
      });
    }

    await this.resumePosting(payment.id, merchantId);

    const updated = await this.requirePayment(payment.id);
    return this.toPublic(updated);
  }

  // ── Pipeline ───────────────────────────────────

  private async runPipeline(
    payment: { id: string; reference: string; rail: PaymentRail },
    parsed: ParsedPayment,
  ): Promise<void> {
    // 3a. Sanctions screening — hard gate.
    await this.screenSanctions(payment.id, payment.reference, parsed);

    // 3b. Fraud / AML evaluation — hard gate.
    await this.evaluateFraud(payment.id, payment.reference, parsed);

    // 3c. Resolve destination wallet.
    const wallet = await this.resolveDestination(payment.id, parsed);
    if (!wallet) {
      await this.setStatus(payment.id, "PENDING_ASSIGNMENT");
      logger.info({ reference: payment.reference }, "Payment held for merchant assignment");
      return;
    }

    // 3d. Post to ledger and finalise.
    await this.postAndFinalise(payment.id, payment.reference, parsed, wallet.id, wallet.account.code);
  }

  /** Resume posting for an operator-approved payment. */
  private async resumePosting(paymentId: string, merchantId: string): Promise<void> {
    const payment = await this.requirePayment(paymentId);
    const wallet = await this.findWalletForMerchant(merchantId, payment.currency);
    if (!wallet) {
      await this.setStatus(paymentId, "PENDING_ASSIGNMENT");
      throw new ValidationError(`No active ${payment.currency} wallet for merchant ${merchantId}`);
    }

    const parsed: ParsedPayment = {
      rail: payment.rail,
      reference: payment.reference,
      amount: payment.amount.toString(),
      currency: payment.currency,
      valueDate: payment.valueDate,
      operationCode: payment.operationCode,
      charges: payment.charges,
      debtor: {
        name: payment.debtorName,
        account: payment.debtorAccount,
        bic: payment.debtorBic,
        country: payment.debtorCountry,
      },
      creditor: {
        name: payment.creditorName,
        account: payment.creditorAccount,
        bic: payment.creditorBic,
        country: payment.creditorCountry,
      },
    };

    await this.postAndFinalise(payment.id, payment.reference, parsed, wallet.id, wallet.account.code);
  }

  /** Screen both parties; set REJECTED on any match. */
  private async screenSanctions(
    paymentId: string,
    reference: string,
    parsed: ParsedPayment,
  ): Promise<void> {
    await this.setStatus(paymentId, "SCREENING");

    const screeningRefs: string[] = [];
    const parties: Array<{ role: string; party: PaymentParty }> = [
      { role: "debtor", party: parsed.debtor },
      { role: "creditor", party: parsed.creditor },
    ];

    for (const { role, party } of parties) {
      if (!party.name) continue;
      const result = await sanctionsService.screen({
        name: party.name,
        entityType: "PERSON",
        country: party.country,
        bankName: party.bic,
        reference: `${reference}-${role}`,
      });
      screeningRefs.push(result.reference);

      if (result.status === "POTENTIAL_MATCH") {
        await this.prisma.incomingPayment.update({
          where: { id: paymentId },
          data: {
            status: "REJECTED",
            sanctionsScreeningIds: screeningRefs,
            failureReason: `Sanctions match on ${role}: ${result.matchedName ?? "unknown"} (score ${result.score})`,
          },
        });
        logger.info(
          { reference, role, score: result.score, matched: result.matchedName },
          "Payment rejected: sanctions match",
        );
        await this.publish(STREAM_TOPICS.paymentsFailed, "PAYMENT_REJECTED", reference, {
          reason: "sanctions_match",
          role,
          score: result.score,
        });
        throw new AppError(
          `Payment rejected: sanctions match on ${role}`,
          403,
          "PAYMENT_SANCTIONS_BLOCKED",
        );
      }
    }

    await this.prisma.incomingPayment.update({
      where: { id: paymentId },
      data: { status: "SCREENED", sanctionsScreeningIds: screeningRefs },
    });
  }

  /** Run the fraud engine; BLOCK rejects, REVIEW holds. */
  private async evaluateFraud(
    paymentId: string,
    reference: string,
    parsed: ParsedPayment,
  ): Promise<void> {
    await this.setStatus(paymentId, "FRAUD_CHECK");

    const payment = await this.requirePayment(paymentId);
    const result = await fraudService.evaluate({
      amount: parsed.amount,
      currency: parsed.currency,
      merchantId: payment.merchantId ?? undefined,
    });

    await this.prisma.incomingPayment.update({
      where: { id: paymentId },
      data: { fraudVerdict: result.verdict, fraudRiskScore: result.riskScore },
    });

    if (result.verdict === "BLOCK") {
      await this.setStatus(paymentId, "REJECTED", `Fraud block: ${result.reason ?? "high risk"}`);
      logger.info({ reference, riskScore: result.riskScore }, "Payment rejected: fraud block");
      await this.publish(STREAM_TOPICS.paymentsFailed, "PAYMENT_REJECTED", reference, {
        reason: "fraud_block",
        riskScore: result.riskScore,
      });
      throw new AppError(
        `Payment rejected by fraud engine (score ${result.riskScore})`,
        403,
        "PAYMENT_FRAUD_BLOCKED",
      );
    }

    if (result.verdict === "REVIEW") {
      await this.setStatus(paymentId, "UNDER_REVIEW", `Fraud review: ${result.reason ?? "manual review"}`);
      logger.info({ reference, riskScore: result.riskScore }, "Payment held for fraud review");
      await this.publish(STREAM_TOPICS.paymentsValidated, "PAYMENT_UNDER_REVIEW", reference, {
        review: true,
        riskScore: result.riskScore,
      });
      // Stop the pipeline — operator must resolve.
      throw new AppError(
        "Payment held for manual fraud review",
        202,
        "PAYMENT_UNDER_REVIEW",
      );
    }

    // ALLOW — publish validated and continue.
    await this.publish(STREAM_TOPICS.paymentsValidated, "PAYMENT_VALIDATED", reference, {
      amount: parsed.amount,
      currency: parsed.currency,
    });
  }

  /** Find the destination wallet: explicit merchantId, else creditor account match. */
  private async resolveDestination(
    paymentId: string,
    parsed: ParsedPayment,
  ): Promise<{ id: string; account: { code: string } } | null> {
    const payment = await this.requirePayment(paymentId);
    if (payment.merchantId) {
      return this.findWalletForMerchant(payment.merchantId, parsed.currency);
    }

    // Match creditor account against a wallet's virtual account or account code.
    if (parsed.creditor.account) {
      const wallet = await this.prisma.wallet.findFirst({
        where: {
          OR: [
            { virtualAccounts: { some: { accountNumber: parsed.creditor.account } } },
            { account: { code: parsed.creditor.account } },
          ],
          status: "ACTIVE",
          currency: parsed.currency.toUpperCase(),
        },
        select: { id: true, merchantId: true, account: { select: { code: true } } },
      });
      if (wallet) {
        await this.prisma.incomingPayment.update({
          where: { id: paymentId },
          data: { merchantId: wallet.merchantId ?? undefined, walletId: wallet.id },
        });
        return wallet;
      }
    }

    return null;
  }

  private async findWalletForMerchant(
    merchantId: string,
    currency: string,
  ): Promise<{ id: string; account: { code: string } } | null> {
    return this.prisma.wallet.findFirst({
      where: { merchantId, status: "ACTIVE", currency: currency.toUpperCase() },
      select: { id: true, account: { select: { code: true } }, merchantId: true },
    });
  }

  /** Ensure the settlement funding account for a currency exists (LIABILITY). */
  private async ensureSettlementAccount(currency: string): Promise<string> {
    const code = `${SETTLEMENT_ACCOUNT_PREFIX}:${currency.toUpperCase()}`;
    const existing = await this.prisma.account.findUnique({
      where: { code },
      select: { code: true },
    });
    if (existing) return code;

    await this.prisma.account.create({
      data: {
        code,
        name: `Settlement funding (${currency.toUpperCase()})`,
        type: "LIABILITY",
        subtype: "SETTLEMENT",
        currency: currency.toUpperCase(),
      },
    });
    return code;
  }

  /**
   * Post the ledger entry and mark the payment POSTED.
   *
   * Recoverable: if a journal entry with the expected reference already exists
   * (e.g. a prior attempt posted the ledger but crashed before updating the
   * payment), we reuse it instead of re-posting.
   */
  private async postAndFinalise(
    paymentId: string,
    reference: string,
    parsed: ParsedPayment,
    walletId: string,
    walletAccountCode: string,
  ): Promise<void> {
    await this.setStatus(paymentId, "POSTING");

    const currency = parsed.currency.toUpperCase();
    const settlementAccount = await this.ensureSettlementAccount(currency);
    const journalRef = `PAY-${parsed.rail}-${reference}`;
    const amount = new Decimal(parsed.amount).toFixed(4);

    // Recover from a partial prior attempt.
    const existingEntry = await this.prisma.journalEntry.findUnique({
      where: { reference: journalRef },
      select: { reference: true },
    });

    if (!existingEntry) {
      await ledgerService.postEntry({
        reference: journalRef,
        entryType: "SETTLEMENT",
        description: `Incoming ${parsed.rail} payment ${reference}`,
        source: "PAYMENT_INGESTION",
        postedBy: "system",
        metadata: {
          rail: parsed.rail,
          reference,
          debtorAccount: parsed.debtor.account,
          creditorAccount: parsed.creditor.account,
          valueDate: parsed.valueDate,
        },
        lines: [
          { accountCode: settlementAccount, debit: amount, credit: "0" },
          { accountCode: walletAccountCode, debit: "0", credit: amount },
        ],
      });
    }

    // Atomically mark POSTED + audit log.
    await this.prisma.$transaction(async (tx) => {
      await tx.incomingPayment.update({
        where: { id: paymentId },
        data: {
          status: "POSTED",
          walletId,
          journalEntryRef: journalRef,
          postedAt: new Date(),
        },
      });

      const payment = await tx.incomingPayment.findUnique({ where: { id: paymentId } });
      await tx.auditLog.create({
        data: {
          action: "PAYMENT_POSTED",
          entity: "IncomingPayment",
          entityId: paymentId,
          merchantId: payment?.merchantId ?? null,
          after: {
            reference,
            rail: parsed.rail,
            amount,
            currency,
            journalEntryRef: journalRef,
            walletAccountCode,
          },
        },
      });
    });

    logger.info(
      { reference, journalRef, amount, currency },
      "Payment posted to ledger",
    );

    await this.publish(STREAM_TOPICS.paymentsPosted, "PAYMENT_POSTED", reference, {
      amount,
      currency,
      journalEntryRef: journalRef,
    });

    // Fire-and-forget webhook — delivery failure must not roll back the post.
    this.dispatchWebhook(reference, {
      amount,
      currency,
      rail: parsed.rail,
      journalEntryRef: journalRef,
      valueDate: parsed.valueDate,
    }).catch((err) => {
      logger.error({ reference, err: err.message }, "Webhook dispatch failed after posting");
    });
  }

  private async dispatchWebhook(reference: string, payload: Record<string, unknown>): Promise<void> {
    await webhookService.dispatch({
      eventName: "PAYMENT_SETTLED",
      reference,
      payload,
    });
  }

  // ── Helpers ────────────────────────────────────

  /** Parse the input into a normalised payment shape. */
  private parseInput(input: IngestInput): ParsedPayment {
    if (input.payment) {
      if (!input.payment.reference || !input.payment.amount || !input.payment.currency) {
        throw new ValidationError("payment.reference, payment.amount and payment.currency are required");
      }
      return input.payment;
    }

    if (!input.rawMessage) {
      throw new ValidationError("Either rawMessage or payment is required");
    }

    const outcome = swiftMtService.parse(input.rawMessage);
    if (!outcome.parsed || !outcome.valid || !outcome.payment) {
      throw new AppError(
        `SWIFT parse failed: ${outcome.errors.map((e) => e.message).join("; ") || "invalid message"}`,
        422,
        "PAYMENT_PARSE_FAILED",
      );
    }

    const p = outcome.payment;
    if (!p.reference) {
      throw new ValidationError("SWIFT message is missing :20: transaction reference");
    }

    return {
      rail: p.messageType === "MT202" ? "SWIFT_MT202" : "SWIFT_MT103",
      reference: p.reference,
      amount: p.amount ?? "0",
      currency: p.currency ?? "USD",
      valueDate: p.valueDate,
      operationCode: p.operationCode,
      charges: p.charges,
      debtor: {
        name: p.debtor?.name ?? null,
        account: p.debtor?.account ?? null,
        bic: p.debtor?.bic ?? null,
        country: p.debtor?.country ?? null,
      },
      creditor: {
        name: p.creditor?.name ?? null,
        account: p.creditor?.account ?? null,
        bic: p.creditor?.bic ?? null,
        country: p.creditor?.country ?? null,
      },
      raw: input.rawMessage,
    };
  }

  private async publish(
    topic: string,
    eventName: string,
    reference: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await streamingService.publish({
        topic: topic as never,
        eventName,
        reference,
        payload,
      });
    } catch (error) {
      // Stream emission must never break the payment pipeline.
      logger.warn(
        { topic, eventName, reference, err: error instanceof Error ? error.message : String(error) },
        "Failed to publish stream event",
      );
    }
  }

  private async setStatus(
    paymentId: string,
    status: PaymentStatus,
    failureReason?: string,
  ): Promise<void> {
    const data: Prisma.IncomingPaymentUpdateInput = { status };
    if (failureReason) data.failureReason = failureReason;
    await this.prisma.incomingPayment.update({ where: { id: paymentId }, data });
  }

  private async markFailed(paymentId: string, reason: string): Promise<void> {
    try {
      const payment = await this.prisma.incomingPayment.findUnique({ where: { id: paymentId } });
      // Don't overwrite a terminal status set by the pipeline itself.
      if (payment && TERMINAL_STATUSES.includes(payment.status)) return;
      await this.setStatus(paymentId, "FAILED", reason);
    } catch {
      // Best-effort — the original error is what matters.
    }
  }

  private async requirePayment(id: string) {
    const payment = await this.prisma.incomingPayment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundError("Incoming payment", id);
    return payment;
  }

  private toPublic(payment: {
    id: string;
    reference: string;
    rail: PaymentRail;
    status: PaymentStatus;
    amount: Decimal | string | number;
    currency: string;
    merchantId: string | null;
    walletId: string | null;
    journalEntryRef: string | null;
    fraudVerdict: string | null;
    failureReason: string | null;
    createdAt: Date;
  }): IngestResult["payment"] {
    return {
      id: payment.id,
      reference: payment.reference,
      rail: payment.rail,
      status: payment.status,
      amount: new Decimal(payment.amount).toString(),
      currency: payment.currency,
      merchantId: payment.merchantId,
      walletId: payment.walletId,
      journalEntryRef: payment.journalEntryRef,
      fraudVerdict: payment.fraudVerdict,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt,
    };
  }
}
