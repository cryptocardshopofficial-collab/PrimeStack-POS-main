import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { hmacAuthPlugin } from "../../plugins/auth.js";
import { registerT2tRoutes } from "./t2t.routes.js";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    hmacKey: { findFirst: vi.fn() },
    hmacNonce: { create: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("../../core/database.js", () => ({ prisma }));
vi.mock("../../core/redis.js", () => ({ redis: { set: vi.fn() } }));

describe("T2T whitelist ping route", () => {
  it("uses the authenticated operator session without merchant HMAC", async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    const app = Fastify({ logger: false });
    app.decorate("authenticate", async (request, reply) => {
      if (request.headers.authorization !== "Bearer operator-session") {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      request.user = { id: "operator-id", role: "OPERATOR" } as typeof request.user;
    });
    await hmacAuthPlugin(app);
    registerT2tRoutes(app);

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
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledOnce();
      expect(prisma.hmacKey.findFirst).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
