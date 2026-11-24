import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError, NotFoundError } from "../../core/errors.js";
import { sendSuccess } from "../../shared/utils/response.js";
import {
  acknowledgeAlarm,
  getPingState,
  listAlarms,
  raiseTestAlarm,
  recordPing,
} from "./alarms.js";

const readRoles = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "REVIEWER", "READONLY"];
const writeRoles = ["SUPER_ADMIN", "ADMIN", "OPERATOR"];

function actorId(request: FastifyRequest): string {
  return (request.user as { id?: string } | undefined)?.id || "unknown";
}

/**
 * Alarm endpoints.
 *
 * `/alarm/ping` is deliberately public and unauthenticated: it is a
 * dead-man's-switch target for an external uptime monitor. If pings stop, the
 * external monitor (not this process) raises the alert — that is the only way
 * to be told about a total process outage.
 */
export function registerAlarmRoutes(app: FastifyInstance): void {
  app.get("/alarm/ping", async (_request: FastifyRequest, reply: FastifyReply) => {
    const pingedAt = recordPing();
    return sendSuccess(reply, { ok: true, pingedAt, ...getPingState() });
  });

  app.register(async (scope) => {
    scope.addHook("preHandler", async (request, reply) => {
      await scope.authenticate(request, reply);
      const role = (request.user as { role?: string } | undefined)?.role;
      const allowed = request.method === "GET" ? readRoles : writeRoles;
      if (!role || !allowed.includes(role))
        throw new ForbiddenError("Your admin role cannot access alarms");
    });

    scope.get("/admin/alarms", async (_request, reply) => sendSuccess(reply, listAlarms()));

    scope.post("/admin/alarms/test", async (request, reply) =>
      sendSuccess(reply, raiseTestAlarm(actorId(request)), 201),
    );

    scope.post("/admin/alarms/:id/ack", async (request, reply) => {
      const { id } = request.params as { id: string };
      const record = acknowledgeAlarm(id, actorId(request));
      if (!record) throw new NotFoundError("Alarm", id);
      return sendSuccess(reply, record);
    });
  });
}
