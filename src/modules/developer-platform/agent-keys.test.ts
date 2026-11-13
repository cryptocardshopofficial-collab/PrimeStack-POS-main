import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { decryptSecret } from "../s2s-engine/s2s-crypto.js";
import { ConflictError, ValidationError } from "../../core/errors.js";
import { DeveloperPlatformService } from "./developer-platform.service.js";

function createPrismaMock(status = "APPROVED") {
  const keys: Array<Record<string, unknown>> = [];
  const agent = {
    findUnique: vi.fn(async () => ({
      id: "agent-1",
      code: "AGENT-100",
      name: "Example Agent",
      status,
    })),
  };
  const hmacKey = {
    findFirst: vi.fn(async ({ where }: { where: { agentId?: string; status?: string; keyId?: string } }) =>
      keys.find((key) =>
        (!where.agentId || key.agentId === where.agentId) &&
        (!where.status || key.status === where.status) &&
        (!where.keyId || key.keyId === where.keyId),
      ) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: { agentId: string } }) =>
      keys
        .filter((key) => key.agentId === where.agentId)
        .map(({ keyId, algorithm, status, rotatedFrom, expiresAt, createdAt }) => ({
          keyId,
          algorithm,
          status,
          rotatedFrom,
          expiresAt,
          createdAt,
        })),
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const key = { id: `row-${keys.length + 1}`, createdAt: new Date(), ...data };
      keys.push(key);
      return key;
    }),
    updateMany: vi.fn(async ({
      where,
      data,
    }: {
      where: { keyId: string; agentId: string; status: string };
      data: Record<string, unknown>;
    }) => {
      const key = keys.find((item) =>
        item.keyId === where.keyId &&
        item.agentId === where.agentId &&
        item.status === where.status,
      );
      if (!key) return { count: 0 };
      Object.assign(key, data);
      return { count: 1 };
    }),
  };
  const tx = { hmacKey };
  const prisma = {
    agent,
    hmacKey,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    keys,
  };
}

describe("Agent HMAC key management", () => {
  it("issues an encrypted key once and lists metadata without its secret", async () => {
    const mock = createPrismaMock();
    const service = new DeveloperPlatformService(mock.prisma);

    const issued = await service.createAgentKey("agent-1");

    expect(issued.keyId).toMatch(/^psk_agent_[a-f0-9]{32}$/);
    expect(issued.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(issued).not.toHaveProperty("encryptedSecret");
    expect(mock.keys[0].secret).not.toBe(issued.secret);
    expect(decryptSecret(String(mock.keys[0].secret))).toBe(issued.secret);

    const listed = await service.listAgentKeys("agent-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("secret");
    expect(listed[0]).not.toHaveProperty("agentId");
  });

  it("only issues keys to approved agents", async () => {
    const mock = createPrismaMock("PENDING");
    const service = new DeveloperPlatformService(mock.prisma);

    await expect(service.createAgentKey("agent-1")).rejects.toBeInstanceOf(ValidationError);
    expect(mock.keys).toHaveLength(0);
  });

  it("requires rotation instead of creating a second active key", async () => {
    const mock = createPrismaMock();
    const service = new DeveloperPlatformService(mock.prisma);
    await service.createAgentKey("agent-1");

    await expect(service.createAgentKey("agent-1")).rejects.toBeInstanceOf(ConflictError);
    expect(mock.keys).toHaveLength(1);
  });

  it("rotates the active credential and preserves the previous key as rotated", async () => {
    const mock = createPrismaMock();
    const service = new DeveloperPlatformService(mock.prisma);
    const first = await service.createAgentKey("agent-1");

    const second = await service.rotateAgentKey("agent-1", first.keyId);

    expect(mock.keys).toHaveLength(2);
    expect(mock.keys[0].status).toBe("ROTATED");
    expect(mock.keys[1].status).toBe("ACTIVE");
    expect(mock.keys[1].rotatedFrom).toBe(first.keyId);
    expect(decryptSecret(String(mock.keys[1].secret))).toBe(second.secret);
  });

  it("revokes a key only for its owning agent", async () => {
    const mock = createPrismaMock();
    const service = new DeveloperPlatformService(mock.prisma);
    const key = await service.createAgentKey("agent-1");

    await expect(service.revokeAgentKey("other-agent", key.keyId)).rejects.toThrow();
    expect(mock.keys[0].status).toBe("ACTIVE");
    await service.revokeAgentKey("agent-1", key.keyId);
    expect(mock.keys[0].status).toBe("REVOKED");
  });

  it("binds authenticated agent terminal registrations to the key owner", async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const prisma = {
      agent: {
        findUnique: vi.fn(async () => ({
          code: "AGENT-100",
          name: "Example Agent",
          status: "APPROVED",
        })),
      },
      terminalRegistrationRequest: { create },
    } as unknown as PrismaClient;
    const service = new DeveloperPlatformService(prisma);

    await service.createAgentTerminalRegistration("agent-1", {
      customerName: "Example Customer",
      country: "GB",
      senderPublicIp: "203.0.113.10",
      senderTerminalId: "TERM-100",
      senderServerUrl: "https://sender.example.com",
      operatingCurrency: "GBP",
      businessPurpose: "Terminal connectivity test",
      customerMessage: "",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentCode: "AGENT-100",
        agentName: "Example Agent",
        senderTerminalId: "TERM-100",
      }),
    });
  });
});
