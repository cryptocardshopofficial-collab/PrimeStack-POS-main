import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { hmacAuthPlugin } from "../../plugins/auth.js";
import { registerNetworkRoutes } from "./network.routes.js";
import type { NetworkService } from "./network.service.js";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    hmacKey: { findFirst: vi.fn() },
    hmacNonce: { create: vi.fn() },
  },
}));

vi.mock("../../core/database.js", () => ({ prisma }));

describe("network admin routes", () => {
  it("uses the operator session instead of requiring a merchant HMAC key", async () => {
    const service = {
      listIps: vi.fn().mockResolvedValue({
        data: [],
        meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
      }),
    } as unknown as NetworkService;
    const app = Fastify({ logger: false });
    app.decorate("authenticate", async (request, reply) => {
      const authorization = request.headers.authorization;
      if (authorization !== "Bearer operator-session" && authorization !== "Bearer readonly-session") {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      request.user = {
        id: "operator-id",
        role: authorization === "Bearer operator-session" ? "ADMIN" : "READONLY",
      } as typeof request.user;
    });
    await hmacAuthPlugin(app);
    registerNetworkRoutes(app, service);

    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/network/ip-whitelist",
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(prisma.hmacKey.findFirst).not.toHaveBeenCalled();

      const readonly = await app.inject({
        method: "GET",
        url: "/network/ip-whitelist",
        headers: { authorization: "Bearer readonly-session" },
      });
      expect(readonly.statusCode).toBe(403);
      expect(service.listIps).not.toHaveBeenCalled();

      const authorized = await app.inject({
        method: "GET",
        url: "/network/ip-whitelist",
        headers: { authorization: "Bearer operator-session" },
      });
      expect(authorized.statusCode).toBe(200);
      expect(service.listIps).toHaveBeenCalledOnce();
      expect(prisma.hmacKey.findFirst).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
