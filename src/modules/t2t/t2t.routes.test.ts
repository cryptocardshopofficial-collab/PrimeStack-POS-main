import Fastify from "fastify";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import rateLimit from "@fastify/rate-limit";
import { hmacAuthPlugin } from "../../plugins/auth.js";
import { errorHandlerPlugin } from "../../plugins/error-handler.js";
import { registerT2tRoutes } from "./t2t.routes.js";

const { prisma, postEntry } = vi.hoisted(() => {
  // Read by the real config module, which is imported before the mocks resolve.
  process.env.INBOUND_WEBHOOK_SECRET = "test-inbound-webhook-secret";
  return {
    prisma: {
      hmacKey: { findFirst: vi.fn() },
      hmacNonce: { create: vi.fn() },
      account: { findUnique: vi.fn(), create: vi.fn() },
      journalEntry: { findUnique: vi.fn() },
      auditLog: { create: vi.fn() },
      $queryRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    },
    postEntry: vi.fn(),
  };
});

vi.mock("../../core/database.js", () => ({ prisma }));
vi.mock("../../core/redis.js", () => ({ redis: { set: vi.fn() } }));
vi.mock("../ledger/ledger.module.js", () => ({
  ledgerService: { postEntry },
}));

const INBOUND_BODY = {
  eventId: "evt-inbound-0001",
  amount: "250.0000",
  currency: "USD",
  target: { type: "TERMINAL" as const, id: "PS12345678" },
  payerName: "M/S. UNITED SOLAR AND WIND POWER TECHNOLOGIES",
  payerReference: "UPI-9876543210",
};

function signInbound(body: unknown, timestamp: number): string {
  return createHmac("sha256", "test-inbound-webhook-secret")
    .update(`${timestamp}${JSON.stringify(body)}`)
    .digest("hex");
}

const TERMINAL_TID = "PS12345678";
const TERMINAL_ACCOUNT = `TERMINAL-${TERMINAL_TID}-USD`;

/** Wires the Prisma/ledger mocks a successful inbound credit needs. */
function mockInboundCredit() {
  prisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM "Terminal"')) {
      return [{ tid: TERMINAL_TID, merchantId: "merchant-1" }];
    }
    if (sql.includes("balance")) {
      return [{ balance: "1250.0000" }];
    }
    return [];
  });
  prisma.account.findUnique.mockImplementation(
    async (args: { where: { code: string } }) => ({ code: args.where.code }),
  );
  prisma.journalEntry.findUnique.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({});
  postEntry.mockResolvedValue({});
}

async function createTestApp() {
  vi.clearAllMocks();
  const app = Fastify({ logger: false });
  app.decorate("authenticate", async (request, reply) => {
    if (request.headers.authorization === "Bearer admin-session") {
      request.user = { id: "admin-id", role: "SUPER_ADMIN" } as typeof request.user;
      return;
    }
    if (request.headers.authorization !== "Bearer operator-session") {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.user = {
      id: "operator-id",
      role: "OPERATOR",
    } as typeof request.user;
  });
  await app.register(rateLimit, { global: false });
  await errorHandlerPlugin(app);
  await hmacAuthPlugin(app);
  registerT2tRoutes(app);
  return app;
}

describe("T2T whitelist ping route", () => {
  it("uses the authenticated operator session without merchant HMAC", async () => {
    const app = await createTestApp();
    prisma.$queryRaw.mockResolvedValue([]);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/t2t/whitelist/ping",
        headers: { authorization: "Bearer operator-session" },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.summary).toMatchObject({
        total: 0,
        reachable: 0,
        unreachable: 0,
      });
      expect(response.json().data.summary.portsChecked).toEqual([443, 80]);
      expect(prisma.$queryRaw).toHaveBeenCalledOnce();
      expect(prisma.hmacKey.findFirst).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects non-public probe targets before querying the whitelist", async () => {
    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/t2t/whitelist/ping",
        headers: { authorization: "Bearer operator-session" },
        payload: { ip: "127.0.0.1" },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects a whitelist larger than the probe cap without opening probes", async () => {
    const app = await createTestApp();
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({
        ip: `8.8.8.${index + 1}`,
        note: null,
      })),
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/t2t/whitelist/ping",
        headers: { authorization: "Bearer operator-session" },
        payload: {},
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.message).toContain("Maximum allowed is 50");
    } finally {
      await app.close();
    }
  });

  it("does not accept caller-selected ports or unknown sender ping fields", async () => {
    const keyId = "test-merchant-key";
    const timestamp = String(Date.now());
    const nonce = "unique-test-nonce-123";
    const body = { terminalId: "TERM-1", host: "127.0.0.1" };
    const secret = "test-secret";
    const signature = createHmac("sha256", secret)
      .update(`${keyId}${timestamp}${nonce}${JSON.stringify(body)}`)
      .digest("hex");
    const app = await createTestApp();
    prisma.hmacKey.findFirst.mockResolvedValue({
      keyId,
      secret,
      expiresAt: null,
      merchant: { id: "merchant-1", code: "merchant-1", preferredLang: "en" },
      agent: null,
    });

    try {
      const whitelistResponse = await app.inject({
        method: "POST",
        url: "/t2t/whitelist/ping",
        headers: { authorization: "Bearer operator-session" },
        payload: { ip: "1.1.1.1", port: 22 },
      });
      const senderResponse = await app.inject({
        method: "POST",
        url: "/t2t/ping",
        headers: {
          "x-primestack-key-id": keyId,
          "x-primestack-timestamp": timestamp,
          "x-primestack-nonce": nonce,
          "x-primestack-signature": signature,
        },
        payload: body,
      });

      expect(whitelistResponse.statusCode).toBe(422);
      expect(senderResponse.statusCode).toBe(422);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("delivers a signed notice to the sender callback URL and reports delivery", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const app = await createTestApp();
    // 192.0.2.0/24 is reserved (RFC 5737), so no TCP probe is attempted and
    // the test stays offline while still exercising the notice delivery.
    prisma.$queryRaw.mockResolvedValue([
      {
        ip: "192.0.2.10",
        note: "sender",
        callback_url: "https://sender.example/t2t/notice",
      },
    ]);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/t2t/whitelist/ping",
        headers: { authorization: "Bearer operator-session" },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      expect(data.summary).toMatchObject({
        total: 1,
        notified: 1,
        callbacksConfigured: 1,
      });
      expect(data.results[0]).toMatchObject({
        ip: "192.0.2.10",
        callbackUrl: "https://sender.example/t2t/notice",
        notified: true,
        notifyStatus: 202,
        notifyError: null,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://sender.example/t2t/notice");
      expect(init.method).toBe("POST");
      const timestamp = init.headers["x-primestack-timestamp"];
      const expectedSignature = createHmac(
        "sha256",
        "test-inbound-webhook-secret",
      )
        .update(`${timestamp}${init.body}`)
        .digest("hex");
      expect(init.headers["x-primestack-signature"]).toBe(expectedSignature);
      expect(JSON.parse(init.body)).toMatchObject({
        event: "t2t.whitelist.ping",
        ip: "192.0.2.10",
      });
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it("skips the notice when a sender has no callback URL configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await createTestApp();
    prisma.$queryRaw.mockResolvedValue([
      { ip: "192.0.2.11", note: null, callback_url: null },
    ]);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/t2t/whitelist/ping",
        headers: { authorization: "Bearer operator-session" },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      expect(data.summary).toMatchObject({
        total: 1,
        notified: 0,
        callbacksConfigured: 0,
      });
      expect(data.results[0]).toMatchObject({
        notified: false,
        notifyError: "NO_CALLBACK_URL",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});

describe("Inbound real-funds webhook", () => {
  function signedHeaders(timestamp: number) {
    return {
      "x-primestack-timestamp": String(timestamp),
      "x-primestack-signature": signInbound(INBOUND_BODY, timestamp),
    };
  }

  it("accepts a custom HMAC header prefix regardless of case", async () => {
    const app = await createTestApp();
    mockInboundCredit();
    const timestamp = Date.now();
    const signature = signInbound(INBOUND_BODY, timestamp);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/inbound",
        headers: {
          "X-Primestack-timestamp": String(timestamp),
          "X-Primestack-signature": signature,
        },
        payload: INBOUND_BODY,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data).toMatchObject({
        eventId: INBOUND_BODY.eventId,
        targetId: INBOUND_BODY.target.id,
        duplicate: false,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a payload without a signature", async () => {
    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/inbound",
        payload: INBOUND_BODY,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHORIZED");
      expect(prisma.journalEntry.findUnique).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects a payload with an invalid signature", async () => {
    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/inbound",
        headers: {
          "x-primestack-timestamp": String(Date.now()),
          "x-primestack-signature": "deadbeef",
        },
        payload: INBOUND_BODY,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHORIZED");
      expect(postEntry).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects a signature whose timestamp has expired", async () => {
    const app = await createTestApp();
    const timestamp = Date.now() - 10 * 60 * 1000;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/inbound",
        headers: signedHeaders(timestamp),
        payload: INBOUND_BODY,
      });

      expect(response.statusCode).toBe(401);
      expect(postEntry).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("credits a terminal account for a correctly signed payload", async () => {
    const app = await createTestApp();
    mockInboundCredit();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/inbound",
        headers: signedHeaders(Date.now()),
        payload: INBOUND_BODY,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data).toMatchObject({
        eventId: INBOUND_BODY.eventId,
        targetType: "TERMINAL",
        targetId: TERMINAL_TID,
        accountCode: TERMINAL_ACCOUNT,
        currency: "USD",
        balance: "1250.0000",
        duplicate: false,
      });
      expect(postEntry).toHaveBeenCalledOnce();
      expect(postEntry.mock.calls[0][0].lines).toEqual([
        { accountCode: "SYSTEM-FUNDING-USD", debit: "250.0000", credit: "0" },
        { accountCode: TERMINAL_ACCOUNT, debit: "0", credit: "250.0000" },
      ]);
      expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("treats a replayed event as a duplicate without posting again", async () => {
    const app = await createTestApp();
    mockInboundCredit();
    prisma.journalEntry.findUnique.mockResolvedValue({ reference: "INB-replay" });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/inbound",
        headers: signedHeaders(Date.now()),
        payload: INBOUND_BODY,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.duplicate).toBe(true);
      expect(postEntry).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("Manual T2T inbound credit", () => {
  const BODY = {
    tid: TERMINAL_TID,
    amount: "100.0000",
    currency: "USD",
    reference: "MANUAL-INBOUND-0001",
    note: "bank settlement",
  };

  it("rejects a non-administrator session", async () => {
    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/t2t/inbound",
        headers: { authorization: "Bearer operator-session" },
        payload: BODY,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
      expect(postEntry).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated call", async () => {
    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/t2t/inbound",
        payload: BODY,
      });

      expect(response.statusCode).toBe(401);
      expect(postEntry).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("credits the terminal account for an administrator", async () => {
    const app = await createTestApp();
    mockInboundCredit();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/t2t/inbound",
        headers: { authorization: "Bearer admin-session" },
        payload: BODY,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data).toMatchObject({
        terminalId: TERMINAL_TID,
        accountCode: TERMINAL_ACCOUNT,
        currency: "USD",
        reference: BODY.reference,
        duplicate: false,
      });
      expect(postEntry).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
