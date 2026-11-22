import { Prisma, type PrismaClient, type WebhookDelivery, type WebhookSubscription } from "@prisma/client";
import { AppError, NotFoundError, ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { computeHmacSignature, generateHmacSecret, generateReference } from "../../shared/utils/crypto.js";
import { decryptSecret, encryptSecret } from "../s2s-engine/s2s-crypto.js";
import {
  WEBHOOK_EVENTS,
  type FetchLike,
  type PublicWebhookSubscription,
  type WebhookDeliveryStatus,
  type WebhookEventName,
} from "./webhooks.types.js";

/** Header carrying the signature: `t=<unix>,v1=<hex hmac of "t.body">`. */
export const SIGNATURE_HEADER = "x-primestack-signature";
export const EVENT_HEADER = "x-primestack-event";
export const EVENT_ID_HEADER = "x-primestack-event-id";
export const DELIVERY_HEADER = "x-primestack-delivery";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_BASE_MS = 30_000;
const DEFAULT_BACKOFF_MAX_MS = 3_600_000;

export interface WebhookOptions {
  /** Override the HTTP client (tests inject a stub). */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** Sign a request body: `t=<unix>,v1=<hmac(secret, "t.body")>`. */
export function buildSignature(secret: string, timestamp: string, body: string): string {
  return `t=${timestamp},v1=${computeHmacSignature(secret, `${timestamp}.${body}`)}`;
}

/** Exponential backoff, capped. `attempt` is the number of attempts already made. */
export function backoffMs(
  attempt: number,
  baseMs = DEFAULT_BACKOFF_BASE_MS,
  maxMs = DEFAULT_BACKOFF_MAX_MS,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/**
 * Webhook orchestration service.
 *
 * Subscriptions hold an AES-256-GCM encrypted signing secret; delivery is
 * signed, timed out, and retried with exponential backoff. One delivery row
 * per (subscription, event) means a failed delivery can be replayed without
 * creating duplicates.
 */
export class WebhookService {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(private prisma: PrismaClient, options: WebhookOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  }

  /** Event names a subscriber may register for. */
  describeEvents() {
    return [...WEBHOOK_EVENTS];
  }

  /** Create a subscription. The plaintext secret is returned exactly once. */
  async createSubscription(input: {
    callbackUrl: string;
    eventNames: string[];
    ownerType?: string;
    merchantId?: string | null;
    description?: string | null;
    maxAttempts?: number;
    /** Supply a secret to migrate an existing endpoint; otherwise one is generated. */
    secret?: string;
  }): Promise<{ subscription: PublicWebhookSubscription; secret: string }> {
    const callbackUrl = input.callbackUrl?.trim();
    if (!callbackUrl) throw new ValidationError("callbackUrl is required");
    assertHttpUrl(callbackUrl);

    const eventNames = normalizeEventNames(input.eventNames);
    const secret = input.secret?.trim() || generateHmacSecret();
    const maxAttempts = clampAttempts(input.maxAttempts);

    const row = await this.prisma.webhookSubscription.create({
      data: {
        ownerType: input.ownerType?.trim() || "MERCHANT",
        merchantId: input.merchantId ?? null,
        eventNames,
        callbackUrl,
        description: input.description ?? null,
        secretCipher: encryptSecret(secret),
        secretLast4: secret.slice(-4),
        maxAttempts,
      },
    });

    return { subscription: toPublicSubscription(row), secret };
  }

  async listSubscriptions(filters: {
    merchantId?: string;
    active?: boolean;
    eventName?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.WebhookSubscriptionWhereInput = {};
    if (filters.merchantId) where.merchantId = filters.merchantId;
    if (typeof filters.active === "boolean") where.active = filters.active;
    if (filters.eventName) where.eventNames = { has: filters.eventName };

    const [rows, total] = await Promise.all([
      this.prisma.webhookSubscription.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.webhookSubscription.count({ where }),
    ]);

    return {
      data: rows.map(toPublicSubscription),
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  async getSubscription(id: string): Promise<PublicWebhookSubscription> {
    return toPublicSubscription(await this.requireSubscription(id));
  }

  async updateSubscription(
    id: string,
    patch: { callbackUrl?: string; eventNames?: string[]; description?: string | null; active?: boolean; maxAttempts?: number },
  ): Promise<PublicWebhookSubscription> {
    await this.requireSubscription(id);

    const data: Prisma.WebhookSubscriptionUpdateInput = {};
    if (patch.callbackUrl !== undefined) {
      assertHttpUrl(patch.callbackUrl.trim());
      data.callbackUrl = patch.callbackUrl.trim();
    }
    if (patch.eventNames !== undefined) data.eventNames = normalizeEventNames(patch.eventNames);
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.maxAttempts !== undefined) data.maxAttempts = clampAttempts(patch.maxAttempts);

    const row = await this.prisma.webhookSubscription.update({ where: { id }, data });
    return toPublicSubscription(row);
  }

  /** Issue a new signing secret; the old one stops working immediately. */
  async rotateSecret(id: string): Promise<{ subscription: PublicWebhookSubscription; secret: string }> {
    await this.requireSubscription(id);
    const secret = generateHmacSecret();
    const row = await this.prisma.webhookSubscription.update({
      where: { id },
      data: { secretCipher: encryptSecret(secret), secretLast4: secret.slice(-4) },
    });
    return { subscription: toPublicSubscription(row), secret };
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.requireSubscription(id);
    await this.prisma.webhookSubscription.delete({ where: { id } });
  }

  /** Fan a single event out to every matching subscriber. */
  async dispatch(event: {
    eventName: WebhookEventName;
    reference?: string | null;
    payload?: Record<string, unknown>;
    eventId?: string;
  }) {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(event.eventName)) {
      throw new ValidationError(
        `Unknown webhook event: ${String(event.eventName)} — expected one of ${WEBHOOK_EVENTS.join(", ")}`,
      );
    }

    const eventId = event.eventId?.trim() || generateReference("WHK");
    const subscriptions = await this.prisma.webhookSubscription.findMany({
      where: { active: true, eventNames: { has: event.eventName } },
    });

    let delivered = 0;
    let failed = 0;

    for (const subscription of subscriptions) {
      const payload = (event.payload ?? {}) as Prisma.InputJsonValue;
      const delivery = await this.prisma.webhookDelivery.upsert({
        where: { subscriptionId_eventId: { subscriptionId: subscription.id, eventId } },
        create: {
          subscriptionId: subscription.id,
          eventId,
          eventName: event.eventName,
          reference: event.reference ?? null,
          payload,
          status: "PENDING",
        },
        update: { payload },
      });

      const result = await this.attemptDelivery(delivery.id);
      if (result.status === "DELIVERED") delivered++;
      else failed++;
    }

    return { eventId, eventName: event.eventName, matched: subscriptions.length, delivered, failed };
  }

  /** Attempt (or re-attempt) one delivery. */
  async attemptDelivery(id: string): Promise<WebhookDelivery> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id },
      include: { subscription: true },
    });
    if (!delivery) throw new NotFoundError("Webhook delivery", id);
    if (delivery.status === "DELIVERED") return delivery;

    const subscription = delivery.subscription;
    const secret = decryptSecret(subscription.secretCipher);
    const body = JSON.stringify({
      event: delivery.eventName,
      eventId: delivery.eventId,
      reference: delivery.reference,
      occurredAt: delivery.createdAt.toISOString(),
      data: delivery.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const attempts = delivery.attempts + 1;
    let responseCode: number | null = null;
    let responseBody: string | null = null;
    let lastError: string | null = null;
    let ok = false;

    try {
      const response = await this.post(subscription.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [EVENT_HEADER]: delivery.eventName,
          [EVENT_ID_HEADER]: delivery.eventId,
          [DELIVERY_HEADER]: delivery.id,
          [SIGNATURE_HEADER]: buildSignature(secret, timestamp, body),
        },
        body,
      });
      responseCode = response.status;
      responseBody = (await response.text()).slice(0, 2000);
      ok = response.status >= 200 && response.status < 300;
      if (!ok) lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const status: WebhookDeliveryStatus = ok
      ? "DELIVERED"
      : attempts >= subscription.maxAttempts
        ? "EXHAUSTED"
        : "FAILED";

    const updated = await this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        attempts,
        status,
        responseCode,
        responseBody,
        lastError,
        deliveredAt: ok ? new Date() : null,
        nextAttemptAt: ok || status === "EXHAUSTED" ? null : new Date(Date.now() + backoffMs(attempts, this.backoffBaseMs, this.backoffMaxMs)),
      },
    });

    if (ok) {
      await this.prisma.webhookSubscription.update({
        where: { id: subscription.id },
        data: { lastDeliveryAt: new Date() },
      });
    }

    return updated;
  }

  /** Retry worker entry point: attempt deliveries that are due. */
  async deliverPending(limit = 100): Promise<{ attempted: number; delivered: number; failed: number }> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: "asc" },
      take: Math.max(1, Math.min(limit, 500)),
      select: { id: true },
    });

    let delivered = 0;
    let failed = 0;
    for (const { id } of due) {
      const result = await this.attemptDelivery(id);
      if (result.status === "DELIVERED") delivered++;
      else failed++;
    }

    return { attempted: due.length, delivered, failed };
  }

  async listDeliveries(filters: {
    subscriptionId?: string;
    eventName?: string;
    status?: string;
    reference?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.WebhookDeliveryWhereInput = {};
    if (filters.subscriptionId) where.subscriptionId = filters.subscriptionId;
    if (filters.eventName) where.eventName = filters.eventName;
    if (filters.status) where.status = filters.status as never;
    if (filters.reference) where.reference = filters.reference;

    const [data, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.webhookDelivery.count({ where }),
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

  async getDelivery(id: string): Promise<WebhookDelivery> {
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id } });
    if (!delivery) throw new NotFoundError("Webhook delivery", id);
    return delivery;
  }

  // ── Private helpers ──────────────────────────────

  private async post(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number; text(): Promise<string> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async requireSubscription(id: string): Promise<WebhookSubscription> {
    const row = await this.prisma.webhookSubscription.findUnique({ where: { id } });
    if (!row) throw new NotFoundError("Webhook subscription", id);
    return row;
  }
}

function normalizeEventNames(names: string[]): string[] {
  if (!Array.isArray(names) || names.length === 0) {
    throw new ValidationError("eventNames must be a non-empty array");
  }
  const unknown = names.filter((name) => !(WEBHOOK_EVENTS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown webhook event(s): ${unknown.join(", ")}`);
  }
  return [...new Set(names)];
}

function clampAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new ValidationError("maxAttempts must be an integer between 1 and 20");
  }
  return value;
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("callbackUrl must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ValidationError("callbackUrl must use http or https");
  }
}

function toPublicSubscription(row: WebhookSubscription): PublicWebhookSubscription {
  return {
    id: row.id,
    ownerType: row.ownerType,
    merchantId: row.merchantId,
    eventNames: row.eventNames,
    callbackUrl: row.callbackUrl,
    description: row.description,
    secretLast4: row.secretLast4,
    active: row.active,
    maxAttempts: row.maxAttempts,
    lastDeliveryAt: row.lastDeliveryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function defaultFetch(): FetchLike {
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (!globalFetch) {
    logger.warn("Global fetch is unavailable — webhook delivery will fail");
    return async () => {
      throw new AppError("Fetch API is unavailable in this runtime", 500, "FETCH_UNAVAILABLE");
    };
  }
  return globalFetch;
}
