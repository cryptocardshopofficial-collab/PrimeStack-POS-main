import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { hmacAuthPlugin } from "../../plugins/auth.js";
import { registerLedgerRoutes } from "./ledger.routes.js";
import type { LedgerService } from "./ledger.service.js";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    hmacKey: { findFirst: vi.fn() },
    hmacNonce: { create: vi.fn() },
  },
}));

vi.mock("../../core/database.js", () => ({ prisma }));

describe("ledger routes", () => {
  it("uses admin sessions and restricts ledger writes to administrators", async () => {
    const listAccounts = vi.fn().mockResolvedValue([]);
    const createAccount = vi.fn().mockResolvedValue({ code: "USD-CLEARING" });
    const postEntry = vi.fn().mockResolvedValue({ reference: "WALLET-TEST" });
    const service = {
      listAccounts,
      createAccount,
      postEntry,
    } as unknown as LedgerService;
    const app = Fastify({ logger: false });
    app.decorate("authenticate", async (request, reply) => {
      const authorization = request.headers.authorization;
      if (
        authorization !== "Bearer admin-session" &&
        authorization !== "Bearer readonly-session"
      ) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      request.user = {
        id: "operator-id",
        role: authorization === "Bearer admin-session" ? "ADMIN" : "READONLY",
      } as typeof request.user;
    });
    await hmacAuthPlugin(app);
    registerLedgerRoutes(app, service);

    try {
      const unauthenticated = await app.inject({
        method: "GET",
        url: "/ledger/accounts",
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(prisma.hmacKey.findFirst).not.toHaveBeenCalled();

      const readable = await app.inject({
        method: "GET",
        url: "/ledger/accounts",
        headers: { authorization: "Bearer readonly-session" },
      });
      expect(readable.statusCode).toBe(200);
      expect(listAccounts).toHaveBeenCalledOnce();

      const readonlyWrite = await app.inject({
        method: "POST",
        url: "/ledger/accounts",
        headers: { authorization: "Bearer readonly-session" },
        payload: { code: "USD-CLEARING", name: "USD Clearing", type: "ASSET" },
      });
      expect(readonlyWrite.statusCode).toBe(403);
      expect(createAccount).not.toHaveBeenCalled();

      const adminWrite = await app.inject({
        method: "POST",
        url: "/ledger/accounts",
        headers: { authorization: "Bearer admin-session" },
        payload: { code: "USD-CLEARING", name: "USD Clearing", type: "ASSET" },
      });
      expect(adminWrite.statusCode).toBe(201);
      expect(createAccount).toHaveBeenCalledOnce();

      const adminEntry = await app.inject({
        method: "POST",
        url: "/ledger/entries",
        headers: { authorization: "Bearer admin-session" },
        payload: {
          reference: "WALLET-TEST",
          entryType: "ADJUSTMENT",
          description: "Manual credit",
          source: "MANUAL CREDIT",
          lines: [
            { accountCode: "USD-SOURCE", debit: 10, credit: 0 },
            { accountCode: "USD-DESTINATION", debit: 0, credit: 10 },
          ],
        },
      });
      expect(adminEntry.statusCode).toBe(201);
      expect(postEntry).toHaveBeenCalledOnce();
      expect(prisma.hmacKey.findFirst).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
