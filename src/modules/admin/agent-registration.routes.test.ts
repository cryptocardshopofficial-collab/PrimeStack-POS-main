import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, expect, it, vi } from "vitest";
import { registerAgentRegistrationRoutes } from "./agent-registration.routes.js";
import type { AgentRegistrationService } from "./agent-registration.service.js";

const payload = {
  fullName: "Example Agent",
  email: "agent@example.com",
  mobileNumber: "+1 555 0100",
  residentialAddress: "10 Example Street",
  dateOfBirth: "1990-01-01",
  nationality: "Example",
  country: "Example",
  governmentIdType: "PASSPORT",
  governmentIdNumber: "EXAMPLE-1234",
  governmentIdIssuingCountry: "Example",
  idDocument: {
    fileName: "passport.pdf",
    mimeType: "application/pdf",
    contentBase64: "JVBERi0xLjQ=",
  },
  profilePhoto: {
    fileName: "profile.png",
    mimeType: "image/png",
    contentBase64: "iVBORw0KGgo=",
  },
};

async function createApp(service: AgentRegistrationService) {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { global: false });
  app.decorate("authenticate", async (request) => {
    const role = request.headers["x-test-role"];
    request.user = {
      id: "admin-id",
      role: typeof role === "string" ? role : undefined,
    } as typeof request.user;
  });
  app.addHook("onRequest", async (request) => {
    request.jwtVerify = async () => {
      const scope = request.headers["x-agent-scope"];
      const agentId = request.headers["x-agent-id"];
      request.user = {
        scope: typeof scope === "string" ? scope : undefined,
        agentId: typeof agentId === "string" ? agentId : "agent-id",
      } as typeof request.user;
    };
  });
  registerAgentRegistrationRoutes(app, service);
  return app;
}

describe("agent registration routes", () => {
  it("restricts KYC registration to administrators and sends the PIN without caching", async () => {
    const service = {
      register: vi.fn().mockResolvedValue({
        agent: { id: "agent-id", code: "AGT-123456789ABC", status: "PENDING" },
        loginPin: "123456789012",
      }),
    } as unknown as AgentRegistrationService;
    const app = await createApp(service);

    try {
      const forbidden = await app.inject({
        method: "POST",
        url: "/admin/agents",
        headers: { "x-test-role": "READONLY" },
        payload,
      });
      expect(forbidden.statusCode).toBe(403);
      expect(service.register).not.toHaveBeenCalled();

      const registered = await app.inject({
        method: "POST",
        url: "/admin/agents",
        headers: { "x-test-role": "ADMIN" },
        payload,
      });

      expect(registered.statusCode).toBe(201);
      expect(registered.headers["cache-control"]).toBe("no-store");
      expect(registered.json().data.loginPin).toBe("123456789012");
      expect(service.register).toHaveBeenCalledWith(
        expect.objectContaining({ email: "agent@example.com" }),
        "admin-id",
      );
    } finally {
      await app.close();
    }
  });

  it("authenticates agent dashboard reads and merchant state changes with the agent token", async () => {
    const service = {
      getPortalDashboard: vi.fn().mockResolvedValue({
        profile: { code: "AGT-1" },
        merchants: [],
        transactions: [],
        meta: { page: 2, pageSize: 10, total: 0, totalPages: 0 },
      }),
      setAssignedMerchantStatus: vi.fn().mockResolvedValue({
        id: "merchant-id",
        status: "SUSPENDED",
      }),
    } as unknown as AgentRegistrationService;
    const app = await createApp(service);

    try {
      const forbidden = await app.inject({
        method: "GET",
        url: "/public/agent-portal/dashboard?page=2&pageSize=10",
        headers: { "x-agent-scope": "OTHER" },
      });
      expect(forbidden.statusCode).toBe(401);
      expect(service.getPortalDashboard).not.toHaveBeenCalled();

      const dashboard = await app.inject({
        method: "GET",
        url: "/public/agent-portal/dashboard?page=2&pageSize=10",
        headers: { "x-agent-scope": "AGENT_PORTAL", "x-agent-id": "agent-7" },
      });
      expect(dashboard.statusCode).toBe(200);
      expect(service.getPortalDashboard).toHaveBeenCalledWith("agent-7", 2, 10);

      const paused = await app.inject({
        method: "POST",
        url: "/public/agent-portal/merchants/merchant-id/pause",
        headers: {
          "x-agent-scope": "AGENT_PORTAL",
          "x-agent-id": "agent-7",
          "user-agent": "agent-browser",
        },
      });
      expect(paused.statusCode).toBe(200);
      expect(service.setAssignedMerchantStatus).toHaveBeenCalledWith(
        "agent-7",
        "merchant-id",
        "pause",
        expect.any(String),
        "agent-browser",
      );
    } finally {
      await app.close();
    }
  });
});
