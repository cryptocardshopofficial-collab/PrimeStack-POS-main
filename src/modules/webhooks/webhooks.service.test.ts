import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { computeHmacSignature } from "../../shared/utils/crypto.js";
import { encryptSecret } from "../s2s-engine/s2s-crypto.js";
import { backoffMs, buildSignature, SIGNATURE_HEADER, WebhookService } from "./webhooks.service.js";

/** All URLs, references and payloads below are synthetic test fixtures. */

const SECRET = "a".repeat(64);

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    ownerType: "MERCHANT",
    merchantId: null,
    eventNames: ["PAYMENT_SETTLED"],
    callbackUrl: "https://merchant.example/webhook",
    description: null,
    secretCipher: encryptSecret(SECRET),
    secretLast4: SECRET.slice(-4),
    active: true,
    maxAttempts: 3,
    lastDeliveryAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function deliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dlv-1",
    subscriptionId: "sub-1",
    eventId: "EVT-1",
    eventName: "PAYMENT_SETTLED",
    reference: "ABC123",
    payload: { amount: "100000" },
    status: "PENDING",
    attempts: 0,
    responseCode: null,
    responseBody: null,
    lastError: null,
    nextAttemptAt: null,
    deliveredAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function stubFetch(status: number, text = "ok") {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    return { status, text: async () => text };
  });
  return { fetchImpl, calls };
}

describe("buildSignature / backoffMs", () => {
  it("produces a verifiable t=…,v1=… signature", () => {
    const header = buildSignature(SECRET, "1700000000", "{\"a\":1}");
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(header.split(",")[1]).toBe(`v1=${computeHmacSignature(SECRET, "1700000000.{\"a\":1}")}`);
  });

  it("doubles the backoff and caps it", () => {
    expect(backoffMs(1, 1000, 100000)).toBe(1000);
    expect(backoffMs(2, 1000, 100000)).toBe(2000);
    expect(backoffMs(3, 1000, 100000)).toBe(4000);
    expect(backoffMs(20, 1000, 100000)).toBe(100000);
  });
});

describe("WebhookService.createSubscription", () => {
  it("returns the secret once and never exposes the cipher", async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "sub-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      lastDeliveryAt: null,
      ...data,
    }));
    const prisma = { webhookSubscription: { create } } as unknown as PrismaClient;

    const created = await new WebhookService(prisma).createSubscription({
      callbackUrl: "https://merchant.example/webhook",
      eventNames: ["PAYMENT_SETTLED", "PAYMENT_REJECTED"],
    });

    expect(created.secret).toHaveLength(64);
    expect(created.subscription.secretLast4).toBe(created.secret.slice(-4));
    expect("secretCipher" in created.subscription).toBe(false);
    expect(created.subscription.eventNames).toEqual(["PAYMENT_SETTLED", "PAYMENT_REJECTED"]);
  });

  it("rejects a non-http callback URL", async () => {
    const prisma = {} as unknown as PrismaClient;
    await expect(
      new WebhookService(prisma).createSubscription({ callbackUrl: "ftp://x/y", eventNames: ["PAYMENT_SETTLED"] }),
    ).rejects.toThrow(/http/);
  });

  it("rejects unknown event names", async () => {
    const prisma = {} as unknown as PrismaClient;
    await expect(
      new WebhookService(prisma).createSubscription({
        callbackUrl: "https://merchant.example/webhook",
        eventNames: ["NOT_AN_EVENT"],
      }),
    ).rejects.toThrow(/Unknown webhook event/);
  });

  it("rejects an out-of-range maxAttempts", async () => {
    const prisma = {} as unknown as PrismaClient;
    await expect(
      new WebhookService(prisma).createSubscription({
        callbackUrl: "https://merchant.example/webhook",
        eventNames: ["PAYMENT_SETTLED"],
        maxAttempts: 0,
      }),
    ).rejects.toThrow(/maxAttempts/);
  });
});

describe("WebhookService.dispatch", () => {
  it("signs and delivers to every matching subscriber", async () => {
    const subscription = subscriptionRow();
    const delivery = deliveryRow();
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...delivery, ...data }));

    const prisma = {
      webhookSubscription: {
        findMany: vi.fn().mockResolvedValue([subscription]),
        update: vi.fn().mockResolvedValue(subscription),
      },
      webhookDelivery: {
        upsert: vi.fn().mockResolvedValue(delivery),
        findUnique: vi.fn().mockResolvedValue({ ...delivery, subscription }),
        update,
      },
    } as unknown as PrismaClient;

    const { fetchImpl, calls } = stubFetch(200);
    const service = new WebhookService(prisma, { fetchImpl });

    const result = await service.dispatch({
      eventName: "PAYMENT_SETTLED",
      reference: "ABC123",
      payload: { amount: "100000" },
      eventId: "EVT-1",
    });

    expect(result).toEqual({ eventId: "EVT-1", eventName: "PAYMENT_SETTLED", matched: 1, delivered: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(subscription.callbackUrl);

    const header = calls[0].init.headers[SIGNATURE_HEADER];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const timestamp = header.slice(2, header.indexOf(","));
    expect(header.endsWith(`v1=${computeHmacSignature(SECRET, `${timestamp}.${calls[0].init.body}`)}`)).toBe(true);

    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({ event: "PAYMENT_SETTLED", eventId: "EVT-1", reference: "ABC123" });
    expect(body.data).toEqual({ amount: "100000" });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "DELIVERED", attempts: 1 }),
    }));
  });

  it("rejects an unknown event name before touching the database", async () => {
    const findMany = vi.fn();
    const prisma = { webhookSubscription: { findMany } } as unknown as PrismaClient;
    await expect(
      new WebhookService(prisma).dispatch({ eventName: "NOPE" as never }),
    ).rejects.toThrow(/Unknown webhook event/);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("WebhookService.attemptDelivery", () => {
  it("marks a failed attempt FAILED and schedules a retry", async () => {
    const subscription = subscriptionRow({ maxAttempts: 3 });
    const delivery = deliveryRow({ attempts: 0 });
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...delivery, ...data }));

    const prisma = {
      webhookDelivery: { findUnique: vi.fn().mockResolvedValue({ ...delivery, subscription }), update },
      webhookSubscription: { update: vi.fn() },
    } as unknown as PrismaClient;

    const { fetchImpl } = stubFetch(500, "boom");
    const result = await new WebhookService(prisma, { fetchImpl, backoffBaseMs: 1000 }).attemptDelivery("dlv-1");

    expect(result.status).toBe("FAILED");
    expect(result.attempts).toBe(1);
    expect(result.responseCode).toBe(500);
    expect(result.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("marks the delivery EXHAUSTED once the attempt budget is spent", async () => {
    const subscription = subscriptionRow({ maxAttempts: 3 });
    const delivery = deliveryRow({ attempts: 2 });
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...delivery, ...data }));

    const prisma = {
      webhookDelivery: { findUnique: vi.fn().mockResolvedValue({ ...delivery, subscription }), update },
      webhookSubscription: { update: vi.fn() },
    } as unknown as PrismaClient;

    const { fetchImpl } = stubFetch(503, "still down");
    const result = await new WebhookService(prisma, { fetchImpl }).attemptDelivery("dlv-1");

    expect(result.status).toBe("EXHAUSTED");
    expect(result.nextAttemptAt).toBeNull();
  });
});
