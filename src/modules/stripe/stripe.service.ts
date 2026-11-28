import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "../../core/decimal.js";
import { config } from "../../config/index.js";
import { AppError, ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { LedgerService } from "../ledger/ledger.service.js";
import type { CreateSepaIntentInput } from "./stripe.types.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * Stripe SEPA Direct Debit Service
 *
 * Uses raw fetch against the Stripe REST API — no SDK dependency.
 * Receiving account: LOUIS CALTEN INTERNATIONAL LLP
 *   DE96 2022 0800 0029 3844 95 · SXPYDEHH · Banking Circle
 */
export class StripeService {
  constructor(
    private prisma: PrismaClient,
    private ledgerService: LedgerService,
  ) {}

  // ── Stripe API helpers ────────────────────────────────────────

  private async stripePost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const secretKey = config.stripe.secretKey;
    if (!secretKey) {
      throw new AppError("Stripe is not configured — STRIPE_SECRET_KEY is missing", 503, "STRIPE_NOT_CONFIGURED");
    }

    // Stripe expects application/x-www-form-urlencoded
    const encoded = this.encodeFormData(body);

    const response = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2023-10-16",
      },
      body: encoded,
      signal: AbortSignal.timeout(15000),
    });

    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { error: { message: text } }; }

    if (!response.ok) {
      const err = (parsed as { error?: { message?: string; code?: string } }).error;
      throw new AppError(
        err?.message ?? `Stripe error ${response.status}`,
        response.status >= 500 ? 502 : 422,
        err?.code ?? "STRIPE_ERROR",
      );
    }

    return parsed as T;
  }

  private async stripeGet<T = unknown>(path: string): Promise<T> {
    const secretKey = config.stripe.secretKey;
    if (!secretKey) {
      throw new AppError("Stripe is not configured", 503, "STRIPE_NOT_CONFIGURED");
    }

    const response = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${secretKey}`,
        "Stripe-Version": "2023-10-16",
      },
      signal: AbortSignal.timeout(15000),
    });

    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = {}; }

    if (!response.ok) {
      const err = (parsed as { error?: { message?: string } }).error;
      throw new AppError(err?.message ?? `Stripe error ${response.status}`, 502, "STRIPE_ERROR");
    }

    return parsed as T;
  }

  /** Encode nested object to Stripe's form-encoded format */
  private encodeFormData(obj: Record<string, unknown>, prefix = ""): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null) continue;
      const fullKey = prefix ? `${prefix}[${key}]` : key;
      if (typeof value === "object" && !Array.isArray(value)) {
        parts.push(this.encodeFormData(value as Record<string, unknown>, fullKey));
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(String(item))}`);
        });
      } else {
        parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
      }
    }
    return parts.join("&");
  }

  // ── Create PaymentIntent ──────────────────────────────────────

  /**
   * Create a Stripe PaymentIntent for SEPA Direct Debit.
   * Returns the client_secret needed by the browser to confirm payment.
   */
  async createSepaIntent(input: CreateSepaIntentInput): Promise<{
    paymentIntentId: string;
    clientSecret: string;
    amount: number;
    currency: string;
    receivingAccount: {
      name: string;
      iban: string;
      bic: string;
      bank: string;
    };
  }> {
    if (!config.stripe.secretKey) {
      throw new AppError("Stripe is not configured", 503, "STRIPE_NOT_CONFIGURED");
    }

    // Create or retrieve customer
    const customer = await this.stripePost<{ id: string }>("/customers", {
      name:  input.senderName,
      email: input.senderEmail,
      metadata: { platform: "primestack", reference: input.reference ?? "" },
    });

    // Create PaymentIntent
    const intentBody: Record<string, unknown> = {
      amount:               input.amount,
      currency:             "eur",
      payment_method_types: ["sepa_debit"],
      customer:             customer.id,
      statement_descriptor: config.stripe.statementDescriptor.slice(0, 22),
      description:          input.reference ?? "PRIMESTACK SEPA collection",
      metadata: {
        platform:        "primestack",
        senderName:      input.senderName,
        senderEmail:     input.senderEmail,
        reference:       input.reference ?? "",
        destinationAcct: config.stripe.destinationAccount,
        receivingIban:   config.stripe.receivingIban,
        ...(input.metadata ?? {}),
      },
      payment_method_options: {
        sepa_debit: {
          mandate_options: {
            reference:          `PSTECH-${Date.now()}`,
            notification_method: "email",
          },
        },
      },
    };

    const intent = await this.stripePost<{ id: string; client_secret: string }>(
      "/payment_intents",
      intentBody,
    );

    logger.info(
      { paymentIntentId: intent.id, amount: input.amount, senderName: input.senderName },
      "Stripe SEPA PaymentIntent created",
    );

    return {
      paymentIntentId: intent.id,
      clientSecret:    intent.client_secret,
      amount:          input.amount,
      currency:        "EUR",
      receivingAccount: {
        name: config.stripe.receivingName,
        iban: `DE96 2022 0800 0029 3844 95`,
        bic:  config.stripe.receivingBic,
        bank: config.stripe.receivingBank,
      },
    };
  }

  // ── Webhook handler ───────────────────────────────────────────

  /**
   * Verify Stripe webhook signature and process the event.
   * When payment_intent.succeeded → credit the vault ledger.
   */
  async handleWebhook(rawBody: Buffer, stripeSignature: string): Promise<{
    handled: boolean;
    eventType: string;
    journalEntryRef?: string;
    amount?: string;
    message: string;
  }> {
    // Verify signature
    const event = this.verifyStripeSignature(rawBody, stripeSignature);

    logger.info({ eventType: event.type }, "Stripe webhook received");

    // Only process succeeded payments
    if (event.type !== "payment_intent.succeeded") {
      return { handled: false, eventType: event.type, message: `Event ${event.type} acknowledged` };
    }

    const intent = event.data.object as {
      id:       string;
      amount:   number;
      currency: string;
      metadata: Record<string, string>;
      status:   string;
    };

    if (intent.status !== "succeeded") {
      return { handled: false, eventType: event.type, message: "PaymentIntent not succeeded" };
    }

    // Amount: Stripe uses cents → convert to decimal
    const amountDecimal = new Decimal(intent.amount).div(100).toFixed(4);
    const currency      = intent.currency.toUpperCase();
    const reference     = intent.metadata.reference || intent.id;
    const senderName    = intent.metadata.senderName || "unknown";
    const destAccount   = intent.metadata.destinationAcct || config.stripe.destinationAccount;

    // Idempotency — derive from PaymentIntent ID
    const journalRef = "STRIPE-" + createHash("sha256")
      .update(intent.id)
      .digest("hex")
      .slice(0, 28)
      .toUpperCase();

    // Check for duplicate
    const existing = await this.prisma.journalEntry.findUnique({
      where: { reference: journalRef },
      select: { reference: true },
    });
    if (existing) {
      logger.info({ journalRef, intentId: intent.id }, "Stripe webhook: duplicate — already credited");
      return {
        handled:         true,
        eventType:       event.type,
        journalEntryRef: journalRef,
        amount:          amountDecimal,
        message:         "Already credited",
      };
    }

    // Ensure vault account exists
    await this.ensureVaultAccount(destAccount, currency);
    const fundingCode = `STRIPE:INCOMING:${currency}`;
    await this.ensureVaultAccount(fundingCode, currency, "ASSET", "STRIPE_INCOMING");

    // Post double-entry ledger credit
    await this.ledgerService.postEntry({
      reference:   journalRef,
      entryType:   "TRANSFER",
      description: `Stripe SEPA debit: ${senderName} — €${amountDecimal} — ${reference}`,
      source:      "STRIPE_SEPA",
      postedBy:    `stripe:${intent.id}`,
      metadata: {
        stripePaymentIntentId: intent.id,
        senderName,
        senderEmail:    intent.metadata.senderEmail ?? null,
        reference,
        amountCents:    intent.amount,
        currency,
        receivingIban:  config.stripe.receivingIban,
        destinationAcct: destAccount,
        creditedAt:     new Date().toISOString(),
      },
      lines: [
        { accountCode: fundingCode, debit: amountDecimal, credit: "0" },
        { accountCode: destAccount, debit: "0", credit: amountDecimal },
      ],
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        action:   "STRIPE_SEPA_CREDITED",
        entity:   "JournalEntry",
        entityId: journalRef,
        after: {
          paymentIntentId: intent.id,
          amount:          amountDecimal,
          currency,
          senderName,
          reference,
          destAccount,
        },
      },
    });

    logger.info(
      { journalRef, intentId: intent.id, amount: amountDecimal, currency, destAccount },
      "Stripe SEPA payment credited to vault",
    );

    return {
      handled:         true,
      eventType:       event.type,
      journalEntryRef: journalRef,
      amount:          amountDecimal,
      message:         `${amountDecimal} ${currency} credited from Stripe SEPA — ${senderName}`,
    };
  }

  // ── List recent payments ──────────────────────────────────────

  async listRecentPayments(limit = 20) {
    const intents = await this.stripeGet<{ data: unknown[] }>(
      `/payment_intents?limit=${limit}&expand[]=data.payment_method`,
    );
    return (intents.data ?? []).map((pi) => {
      const p = pi as Record<string, unknown>;
      const meta = (p.metadata ?? {}) as Record<string, string>;
      return {
        id:          p.id,
        amount:      new Decimal(Number(p.amount)).div(100).toFixed(2),
        currency:    String(p.currency ?? "").toUpperCase(),
        status:      p.status,
        senderName:  meta.senderName  ?? null,
        senderEmail: meta.senderEmail ?? null,
        reference:   meta.reference   ?? null,
        created:     new Date(Number(p.created) * 1000).toISOString(),
      };
    });
  }

  // ── Private helpers ───────────────────────────────────────────

  private verifyStripeSignature(rawBody: Buffer, signature: string): {
    type: string;
    data: { object: unknown };
  } {
    const webhookSecret = config.stripe.webhookSecret;
    if (!webhookSecret) {
      throw new AppError("STRIPE_WEBHOOK_SECRET is not configured", 503, "STRIPE_NOT_CONFIGURED");
    }

    // Parse t= and v1= from signature header
    const parts = Object.fromEntries(
      signature.split(",").map((p) => p.split("=")),
    ) as Record<string, string>;

    const timestamp = parts["t"];
    const v1        = parts["v1"];

    if (!timestamp || !v1) {
      throw new ValidationError("Invalid Stripe signature header format");
    }

    // Check timestamp freshness (± 5 minutes)
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      throw new ValidationError("Stripe webhook timestamp expired");
    }

    // Compute expected signature
    const payload  = `${timestamp}.${rawBody.toString("utf8")}`;
    const expected = createHmac("sha256", webhookSecret).update(payload).digest("hex");

    const v1Buf  = Buffer.from(v1, "hex");
    const expBuf = Buffer.from(expected, "hex");

    if (v1Buf.length !== expBuf.length || !timingSafeEqual(v1Buf, expBuf)) {
      throw new ValidationError("Stripe webhook signature mismatch");
    }

    return JSON.parse(rawBody.toString("utf8")) as { type: string; data: { object: unknown } };
  }

  private async ensureVaultAccount(
    code: string,
    currency: string,
    type: "ASSET" | "LIABILITY" = "ASSET",
    subtype = "VAULT",
  ): Promise<void> {
    const existing = await this.prisma.account.findUnique({
      where: { code }, select: { code: true },
    });
    if (existing) return;
    try {
      await this.prisma.account.create({
        data: { code, name: `Stripe: ${code}`, type, subtype, currency, balance: 0 },
      });
    } catch { /* race condition — already created */ }
  }
}
