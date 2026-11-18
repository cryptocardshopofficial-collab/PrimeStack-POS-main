import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../../core/errors.js";
import { sendCreated, sendPaginated, sendSuccess, parsePagination } from "../../shared/utils/response.js";
import {
  agentPortalLoginSchema,
  agentTransactionControlReasonSchema,
  agentTransactionControlResponseSchema,
  registerAgentKycSchema,
  reviewAgentTransactionControlSchema,
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
  app.get(
    "/admin/agent-transaction-requests",
    { preHandler: app.authenticate },
    async (request, reply) => {
      assertAgentAdministrator(request);
      const query = request.query as Record<string, unknown>;
      const { page, pageSize } = parsePagination(query);
      const status = query.status;
      if (
        status !== undefined &&
        !["PENDING", "INFO_REQUESTED", "APPROVED", "REJECTED"].includes(String(status))
      ) {
        throw new ValidationError("Invalid transaction control request status");
      }
      reply.header("Cache-Control", "no-store");
      const result = await service.listTransactionControlRequests(
        status as "PENDING" | "INFO_REQUESTED" | "APPROVED" | "REJECTED" | undefined,
        page,
        pageSize,
      );
      return sendPaginated(reply, result.data, result.meta);
    },
  );

  app.post(
    "/admin/agent-transaction-requests/:id/review",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const admin = assertAgentAdministrator(request);
      const { id } = request.params as { id: string };
      const parsed = reviewAgentTransactionControlSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid transaction control review", {
          errors: parsed.error.errors,
        });
      }
      reply.header("Cache-Control", "no-store");
      return sendSuccess(
        reply,
        await service.reviewTransactionControlRequest(
          id,
          parsed.data.decision,
          parsed.data.adminRemarks,
          admin.id,
          request.ip,
          request.headers["user-agent"],
        ),
      );
    },
  );

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

  app.get(
    "/public/agent-portal/dashboard",
    { preHandler: authenticateAgentPortal },
    async (request, reply) => {
      const agentId = (request.user as { agentId: string }).agentId;
      const { page, pageSize } = parsePagination(
        request.query as Record<string, unknown>,
      );
      reply.header("Cache-Control", "no-store");
      return sendSuccess(
        reply,
        await service.getPortalDashboard(agentId, page, pageSize),
      );
    },
  );

  app.post(
    "/public/agent-portal/transactions/:transactionId/hold-request",
    { preHandler: authenticateAgentPortal },
    async (request, reply) => {
      const agentId = (request.user as { agentId: string }).agentId;
      const { transactionId } = request.params as { transactionId: string };
      const parsed = agentTransactionControlReasonSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("A valid hold reason is required", {
          errors: parsed.error.errors,
        });
      }
      reply.header("Cache-Control", "no-store");
      return sendCreated(
        reply,
        await service.requestTransactionControl(
          agentId,
          transactionId,
          "HOLD",
          parsed.data.reason,
          request.ip,
          request.headers["user-agent"],
        ),
      );
    },
  );

  app.post(
    "/public/agent-portal/transactions/:transactionId/resume-request",
    { preHandler: authenticateAgentPortal },
    async (request, reply) => {
      const agentId = (request.user as { agentId: string }).agentId;
      const { transactionId } = request.params as { transactionId: string };
      const parsed = agentTransactionControlReasonSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("A valid resume reason is required", {
          errors: parsed.error.errors,
        });
      }
      reply.header("Cache-Control", "no-store");
      return sendCreated(
        reply,
        await service.requestTransactionControl(
          agentId,
          transactionId,
          "RESUME",
          parsed.data.reason,
          request.ip,
          request.headers["user-agent"],
        ),
      );
    },
  );

  app.post(
    "/public/agent-portal/transaction-control-requests/:id/respond",
    { preHandler: authenticateAgentPortal },
    async (request, reply) => {
      const agentId = (request.user as { agentId: string }).agentId;
      const { id } = request.params as { id: string };
      const parsed = agentTransactionControlResponseSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("A valid response is required", {
          errors: parsed.error.errors,
        });
      }
      reply.header("Cache-Control", "no-store");
      return sendSuccess(
        reply,
        await service.respondToTransactionControlRequest(
          agentId,
          id,
          parsed.data.response,
        ),
      );
    },
  );

  app.post(
    "/public/agent-portal/merchants/:id/pause",
    { preHandler: authenticateAgentPortal },
    async (request, reply) => {
      const agentId = (request.user as { agentId: string }).agentId;
      const { id } = request.params as { id: string };
      reply.header("Cache-Control", "no-store");
      return sendSuccess(
        reply,
        await service.setAssignedMerchantStatus(
          agentId,
          id,
          "pause",
          request.ip,
          request.headers["user-agent"],
        ),
      );
    },
  );

  app.post(
    "/public/agent-portal/merchants/:id/resume",
    { preHandler: authenticateAgentPortal },
    async (request, reply) => {
      const agentId = (request.user as { agentId: string }).agentId;
      const { id } = request.params as { id: string };
      reply.header("Cache-Control", "no-store");
      return sendSuccess(
        reply,
        await service.setAssignedMerchantStatus(
          agentId,
          id,
          "resume",
          request.ip,
          request.headers["user-agent"],
        ),
      );
    },
  );
}
