import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../../core/errors.js";
import { sendCreated, sendPaginated, sendSuccess, parsePagination } from "../../shared/utils/response.js";
import {
  agentPortalLoginSchema,
  registerAgentKycSchema,
  updateAgentKycStatusSchema,
} from "./agent-registration.types.js";
import { AgentRegistrationService } from "./agent-registration.service.js";

function assertAgentAdministrator(request: FastifyRequest): { id: string } {
  const user = request.user as { id?: string; role?: string } | undefined;
  if (!user || !["SUPER_ADMIN", "ADMIN"].includes(user.role ?? "")) {
    throw new ForbiddenError("Only administrators can manage agent KYC");
  }
  if (!user.id) throw new UnauthorizedError();
  return { id: user.id };
}

async function authenticateAgentPortal(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw new UnauthorizedError();
  }
  const claims = request.user as { agentId?: string; scope?: string } | undefined;
  if (claims?.scope !== "AGENT_PORTAL" || !claims.agentId) throw new UnauthorizedError();
}

export function registerAgentRegistrationRoutes(
  app: FastifyInstance,
  service: AgentRegistrationService,
): void {
  app.get("/admin/agents", { preHandler: app.authenticate }, async (request, reply) => {
    assertAgentAdministrator(request);
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const result = await service.list(page, pageSize);
    reply.header("Cache-Control", "no-store");
    return sendPaginated(reply, result.data, result.meta);
  });

  app.post(
    "/admin/agents",
    {
      preHandler: app.authenticate,
      bodyLimit: 12 * 1024 * 1024,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const admin = assertAgentAdministrator(request);
      const parsed = registerAgentKycSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid agent KYC registration", {
          errors: parsed.error.errors,
        });
      }
      const result = await service.register(parsed.data, admin.id);
      reply.header("Cache-Control", "no-store");
      return sendCreated(reply, result);
    },
  );

  app.patch(
    "/admin/agents/:id/kyc-status",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const admin = assertAgentAdministrator(request);
      const { id } = request.params as { id: string };
      const parsed = updateAgentKycStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid agent KYC status", {
          errors: parsed.error.errors,
        });
      }
      reply.header("Cache-Control", "no-store");
      return sendSuccess(
        reply,
        await service.updateStatus(id, parsed.data.status, admin.id, parsed.data.reviewNotes),
      );
    },
  );

  app.get(
    "/admin/agents/:id/documents/:kind",
    { preHandler: app.authenticate },
    async (request, reply) => {
      assertAgentAdministrator(request);
      const { id, kind } = request.params as { id: string; kind: string };
      if (kind !== "identity" && kind !== "photo") {
        throw new ValidationError("Document kind must be identity or photo");
      }
      const document = await service.getDocument(id, kind);
      return reply
        .type(document.mimeType)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `attachment; filename="agent-${id}-${kind}"`)
        .send(document.bytes);
    },
  );

  app.post(
    "/public/agent-portal/login",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = agentPortalLoginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid agent login data", {
          errors: parsed.error.errors,
        });
      }
      const agent = await service.authenticateAgent(parsed.data.code, parsed.data.pin);
      const token = await reply.jwtSign(
        { agentId: agent.id, scope: "AGENT_PORTAL" },
        { expiresIn: "30m" },
      );
      reply.header("Cache-Control", "no-store");
      return sendSuccess(reply, { token, code: agent.code });
    },
  );

  app.get(
    "/public/agent-portal/profile",
    { preHandler: authenticateAgentPortal },
    async (request, reply) => {
      const agentId = (request.user as { agentId: string }).agentId;
      reply.header("Cache-Control", "no-store");
      return sendSuccess(reply, await service.getPortalProfile(agentId));
    },
  );
}
