import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, expect, it, vi } from "vitest";
import { registerAdminRoutes } from "./admin.routes.js";
import type { AdminService } from "./admin.service.js";

describe("admin login rate limit", () => {
  it("limits repeated login attempts from one client", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, { global: false });
    app.decorate("authenticate", async () => {});

    const login = vi.fn().mockResolvedValue({
      token: "test-token",
      user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
    });
    registerAdminRoutes(app, { login } as unknown as AdminService);

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/admin/login",
          payload: { email: "admin@example.com", password: "example" },
        });
        expect(response.statusCode).toBe(200);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/admin/login",
        payload: { email: "admin@example.com", password: "example" },
      });

      expect(limited.statusCode).toBe(429);
      expect(login).toHaveBeenCalledTimes(5);
    } finally {
      await app.close();
    }
  });
});
