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
});
