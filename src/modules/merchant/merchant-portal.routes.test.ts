import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerMerchantPortalRoutes, registerMerchantRoutes } from "./merchant.routes.js";
import type { MerchantService } from "./merchant.service.js";

async function createApp(service: MerchantService) {
  const app = Fastify({ logger: false });
  app.decorate("authenticate", async (request) => {
    const header = (name: string) => request.headers[name];
    request.user = {
      id: "test-user",
      role: typeof header("x-test-role") === "string" ? header("x-test-role") : "MERCHANT",
      merchantId:
        typeof header("x-test-merchant-id") === "string"
          ? header("x-test-merchant-id")
          : "merchant-own",
      mustChangePassword: header("x-test-force-password") === "true",
    } as typeof request.user;
  });
  registerMerchantPortalRoutes(app, service);
  registerMerchantRoutes(app, service);
  return app;
}

describe("merchant portal access routes", () => {
  it("blocks merchants from reading another merchant's transactions", async () => {
    const service = {
      listMerchantTransactions: vi.fn(),
    } as unknown as MerchantService;
    const app = await createApp(service);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/merchant-portal/merchants/merchant-other/transactions",
        headers: { "x-test-role": "MERCHANT", "x-test-merchant-id": "merchant-own" },
      });

      expect(response.statusCode).toBe(403);
      expect(service.listMerchantTransactions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("exposes the forced-change state while withholding merchant data", async () => {
    const service = {
      getPortalProfile: vi.fn(),
    } as unknown as MerchantService;
    const app = await createApp(service);

    try {
      const me = await app.inject({
        method: "GET",
        url: "/merchant-portal/me",
        headers: { "x-test-role": "MERCHANT", "x-test-force-password": "true" },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().data.mustChangePassword).toBe(true);

      const profile = await app.inject({
        method: "GET",
        url: "/merchant-portal/merchants/merchant-own",
        headers: { "x-test-role": "MERCHANT", "x-test-force-password": "true" },
      });
      expect(profile.statusCode).toBe(403);
      expect(service.getPortalProfile).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("allows administrators to provision a merchant password only once per response", async () => {
    const service = {
      createPortalCredentials: vi.fn().mockResolvedValue({
        userId: "portal-user",
        email: "merchant@example.com",
        temporaryPassword: "one-time-secret",
        requirePasswordChange: true,
      }),
    } as unknown as MerchantService;
    const app = await createApp(service);

    try {
      const forbidden = await app.inject({
        method: "POST",
        url: "/merchants/merchant-own/portal-credentials",
        headers: { "x-test-role": "OPERATOR" },
      });
      expect(forbidden.statusCode).toBe(403);
      expect(service.createPortalCredentials).not.toHaveBeenCalled();

      const provisioned = await app.inject({
        method: "POST",
        url: "/merchants/merchant-own/portal-credentials",
        headers: { "x-test-role": "ADMIN" },
      });
      expect(provisioned.statusCode).toBe(201);
      expect(provisioned.headers["cache-control"]).toBe("no-store");
      expect(provisioned.json().data.temporaryPassword).toBe("one-time-secret");
      expect(service.createPortalCredentials).toHaveBeenCalledWith(
        "merchant-own",
        "test-user",
        expect.any(String),
        expect.any(String),
      );
    } finally {
      await app.close();
    }
  });
});
