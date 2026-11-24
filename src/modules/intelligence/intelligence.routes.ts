import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../../core/errors.js";
import { sendCreated, sendSuccess } from "../../shared/utils/response.js";
import { IntelligenceService } from "./intelligence.service.js";
import {
  createIntelligenceEventSchema,
  intelligenceDashboardQuerySchema,
} from "./intelligence.types.js";
import { intelligenceDashboardHtml } from "./intelligence-dashboard.js";
import { banIp, listBans, unbanIp } from "../../plugins/security-shield.js";

const readRoles = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "REVIEWER", "READONLY"];
const writeRoles = ["SUPER_ADMIN", "ADMIN", "OPERATOR"];

function actorId(request: FastifyRequest): string {
  const id = (request.user as { id?: string } | undefined)?.id;
  if (!id)
    throw new UnauthorizedError("Authenticated user identity is required");
  return id;
}

export function registerIntelligenceRoutes(
  app: FastifyInstance,
  service: IntelligenceService,
): void {
  app.get(
    "/admin/intelligence-dashboard",
    async (_request: FastifyRequest, reply: FastifyReply) =>
      reply
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(intelligenceDashboardHtml),
  );

  app.register(async (intelligenceApp) => {
    intelligenceApp.addHook("preHandler", async (request, reply) => {
      await intelligenceApp.authenticate(request, reply);
      const role = (request.user as { role?: string } | undefined)?.role;
      const allowedRoles = request.method === "GET" ? readRoles : writeRoles;
      if (!role || !allowedRoles.includes(role))
        throw new ForbiddenError(
          "Your admin role cannot access this intelligence operation",
        );
    });

    intelligenceApp.get("/admin/intelligence/dashboard", async (request, reply) => {
      const parsed = intelligenceDashboardQuerySchema.safeParse(request.query);
      if (!parsed.success)
        throw new ValidationError("Invalid intelligence dashboard query", {
          errors: parsed.error.errors,
        });
      return sendSuccess(reply, await service.getDashboard(parsed.data.days));
    });

    intelligenceApp.get("/admin/intelligence/events", async (request, reply) => {
      const query = request.query as { limit?: string };
      const parsedLimit = query.limit === undefined ? 100 : Number(query.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)
        throw new ValidationError("Event limit must be an integer from 1 to 200");
      return sendSuccess(reply, await service.listEvents(parsedLimit));
    });

    intelligenceApp.post(
      "/admin/intelligence/events",
      async (request, reply) => {
        const parsed = createIntelligenceEventSchema.safeParse(request.body);
        if (!parsed.success)
          throw new ValidationError("Invalid intelligence event", {
            errors: parsed.error.errors,
          });
        return sendCreated(
          reply,
          await service.recordEvent(parsed.data, actorId(request)),
        );
      },
    );

    // ── Active defense: block / unblock sources from the intelligence plane ──
    intelligenceApp.get("/admin/intelligence/blocked", async (_request, reply) =>
      sendSuccess(reply, await listBans()),
    );

    intelligenceApp.post("/admin/intelligence/block", async (request, reply) => {
      const body = request.body as { ip?: string; reason?: string; durationSeconds?: number } | null;
      const ip = body?.ip?.trim();
      if (!ip) throw new ValidationError("An IP address is required to block");
      const reason = body?.reason?.trim() || `manual:blocked by ${actorId(request)}`;
      const duration =
        Number.isInteger(body?.durationSeconds) && (body?.durationSeconds ?? 0) > 0
          ? (body!.durationSeconds as number)
          : 7200;
      await banIp(ip, reason, duration);
      return sendCreated(reply, { ip, reason, durationSeconds: duration, banned: true });
    });

    intelligenceApp.post("/admin/intelligence/unblock", async (request, reply) => {
      const body = request.body as { ip?: string } | null;
      const ip = body?.ip?.trim();
      if (!ip) throw new ValidationError("An IP address is required to unblock");
      await unbanIp(ip);
      return sendSuccess(reply, { ip, banned: false });
    });
  });
}
