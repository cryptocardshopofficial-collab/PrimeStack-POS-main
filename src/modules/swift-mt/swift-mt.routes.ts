import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "../../core/errors.js";
import { sendSuccess } from "../../shared/utils/response.js";
import { SwiftMtService } from "./swift-mt.service.js";
import type { SwiftMessageType } from "./swift-mt.types.js";

/**
 * SWIFT MT parsing routes.
 * Base path: /swift-mt
 */
export function registerSwiftMtRoutes(app: FastifyInstance, service: SwiftMtService): void {
  /** Parse an MT103/MT202 message into the hub's payment shape. */
  app.post("/swift-mt/parse", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const message = body.message;
    if (typeof message !== "string" || message.trim() === "") {
      throw new ValidationError("message is required");
    }
    const outcome = service.parse(message, readTypeOption(body.messageType));
    return sendSuccess(reply, outcome);
  });

  /** Structural validation only — no hub shape, no persistence. */
  app.post("/swift-mt/validate", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const message = body.message;
    if (typeof message !== "string" || message.trim() === "") {
      throw new ValidationError("message is required");
    }
    const outcome = service.parse(message, readTypeOption(body.messageType));
    return sendSuccess(reply, {
      messageType: outcome.messageType,
      valid: outcome.valid,
      errors: outcome.errors,
      warnings: outcome.warnings,
      reference: outcome.parsed?.reference ?? null,
    });
  });

  /** Supported message types and their mandatory fields. */
  app.get("/swift-mt/types", async (_request: FastifyRequest, reply: FastifyReply) =>
    sendSuccess(reply, service.describeTypes()),
  );
}

function readTypeOption(value: unknown): { messageType?: SwiftMessageType } {
  if (value === "MT103" || value === "MT202") return { messageType: value };
  if (value !== undefined && value !== null && value !== "") {
    throw new ValidationError('messageType must be "MT103" or "MT202"');
  }
  return {};
}
