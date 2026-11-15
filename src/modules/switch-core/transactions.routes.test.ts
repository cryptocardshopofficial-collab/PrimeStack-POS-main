import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerTransactionRoutes } from "./transactions.routes.js";
import type { AuthorizationService } from "./authorization.service.js";

describe("transaction routes", () => {
  it("serves the dashboard list through JWT and scopes merchant requests", async () => {
    const listTransactions = vi.fn().mockResolvedValue({
      data: [],
      meta: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
    });
    const getTransaction = vi.fn().mockResolvedValue({ merchantId: "merchant-2" });
    const service = {
      listTransactions,
      getTransaction,
    } as unknown as AuthorizationService;
    const app = Fastify({ logger: false });
    app.decorate("authenticate", async (request, reply) => {
      const authorization = request.headers.authorization;
      if (authorization !== "Bearer readonly-session") {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      request.user = { id: "reader-id", role: "READONLY" } as typeof request.user;
    });
    app.addHook("preValidation", async (request) => {
      request.merchant = {
        id: "merchant-1",
        code: "MERCHANT-1",
        preferredLang: "en",
      };
    });
    registerTransactionRoutes(app, service);

    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/admin/transactions",
      });
      expect(unauthorized.statusCode).toBe(401);

      const dashboardList = await app.inject({
        method: "GET",
        url: "/admin/transactions?merchantId=merchant-2&pageSize=10",
        headers: { authorization: "Bearer readonly-session" },
      });
      expect(dashboardList.statusCode).toBe(200);
      expect(listTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ merchantId: "merchant-2", pageSize: 10 }),
      );

      listTransactions.mockClear();
      const merchantList = await app.inject({
        method: "GET",
        url: "/transactions?merchantId=merchant-2",
      });
      expect(merchantList.statusCode).toBe(200);
      expect(listTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ merchantId: "merchant-1" }),
      );

      const otherMerchantTransaction = await app.inject({
        method: "GET",
        url: "/transactions/other-merchant-stan",
      });
      expect(otherMerchantTransaction.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
