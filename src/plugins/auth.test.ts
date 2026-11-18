import Fastify from "fastify";
import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../modules/s2s-engine/s2s-crypto.js";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    hmacKey: { findFirst: vi.fn() },
    hmacNonce: { create: vi.fn() },
  },
}));

vi.mock("../core/database.js", () => ({ prisma }));

import { hmacAuthPlugin } from "./auth.js";

const secret = "agent-hmac-test-secret";
const agentKey = {
  keyId: "psk_agent_test",
  secret: encryptSecret(secret),
  status: "ACTIVE",
  expiresAt: null,
  merchant: null,
  agent: {
    id: "agent-1",
    code: "AGENT-100",
    name: "Example Agent",
    status: "APPROVED",
  },
};

function headers(keyId: string, keySecret: string) {
  const timestamp = Date.now().toString();
  const nonce = "agent-test-nonce-123456";
  const signature = createHmac("sha256", keySecret)
    .update(`${keyId}${timestamp}${nonce}`)
    .digest("hex");
  return {
    "x-primestack-key-id": keyId,
    "x-primestack-timestamp": timestamp,
    "x-primestack-nonce": nonce,
    "x-primestack-signature": signature,
  };
}

describe("Agent HMAC authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.hmacKey.findFirst.mockResolvedValue(agentKey);
    prisma.hmacNonce.create.mockResolvedValue({});
  });

  it("authenticates approved agent keys on agent routes and attaches agent context", async () => {
    const app = Fastify({ logger: false });
    await hmacAuthPlugin(app);
    app.get("/agent/profile", async (request) => request.agent);

    const response = await app.inject({
      method: "GET",
      url: "/agent/profile",
      headers: headers(agentKey.keyId, secret),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "agent-1", code: "AGENT-100" });
    expect(prisma.hmacNonce.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects agent credentials on non-agent routes", async () => {
    const app = Fastify({ logger: false });
    await hmacAuthPlugin(app);
    app.get("/merchant/resource", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/merchant/resource",
      headers: headers(agentKey.keyId, secret),
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.hmacNonce.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows the website registration endpoint to validate its approved agent code", async () => {
    const app = Fastify({ logger: false });
    await hmacAuthPlugin(app);
    app.post("/public/terminal-registration", async () => ({ accepted: true }));

    const response = await app.inject({
      method: "POST",
      url: "/public/terminal-registration",
      payload: { agentCode: "AGENT-100" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(prisma.hmacKey.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts custom HMAC header prefixes regardless of letter case", async () => {
    const { config } = await import("../config/index.js");
    const previousPrefix = config.hmac.headerPrefix;
    config.hmac.headerPrefix = "X-Primestack";

    try {
      prisma.hmacKey.findFirst.mockResolvedValue({
        keyId: "merchant-hmac-key",
        secret,
        status: "ACTIVE",
        expiresAt: null,
        merchant: { id: "merchant-1", code: "MERCHANT-1", preferredLang: "en" },
        agent: null,
      });

      const app = Fastify({ logger: false });
      await hmacAuthPlugin(app);
      app.get("/merchant/resource", async () => ({ ok: true }));

      const timestamp = Date.now().toString();
      const nonce = "merchant-case-test-nonce-123";
      const signature = createHmac("sha256", secret)
        .update(`merchant-hmac-key${timestamp}${nonce}`)
        .digest("hex");

      const response = await app.inject({
        method: "GET",
        url: "/merchant/resource",
        headers: {
          "X-Primestack-key-id": "merchant-hmac-key",
          "X-Primestack-timestamp": timestamp,
          "X-Primestack-nonce": nonce,
          "X-Primestack-signature": signature,
        },
      });

      expect(config.hmac.headerPrefix).toBe("X-Primestack");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      await app.close();
    } finally {
      config.hmac.headerPrefix = previousPrefix;
    }
  });

  it("rejects merchant credentials on agent routes", async () => {
    prisma.hmacKey.findFirst.mockResolvedValue({
      ...agentKey,
      secret,
      merchant: { id: "merchant-1", code: "MERCHANT-1", preferredLang: "en" },
      agent: null,
    });
    const app = Fastify({ logger: false });
    await hmacAuthPlugin(app);
    app.get("/agent/profile", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/agent/profile",
      headers: headers(agentKey.keyId, secret),
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.hmacNonce.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects agent credentials when the agent is no longer approved", async () => {
    prisma.hmacKey.findFirst.mockResolvedValue({
      ...agentKey,
      agent: { ...agentKey.agent, status: "SUSPENDED" },
    });
    const app = Fastify({ logger: false });
    await hmacAuthPlugin(app);
    app.get("/agent/profile", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/agent/profile",
      headers: headers(agentKey.keyId, secret),
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.hmacNonce.create).not.toHaveBeenCalled();
    await app.close();
  });
});
