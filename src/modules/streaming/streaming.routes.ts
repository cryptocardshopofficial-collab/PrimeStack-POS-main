import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "../../core/errors.js";
import { sendCreated, sendSuccess } from "../../shared/utils/response.js";
import { StreamingService } from "./streaming.service.js";
import type { StreamTopic } from "./streaming.types.js";

/**
 * Event-streaming routes.
 * Base path: /streaming
 */
export function registerStreamingRoutes(app: FastifyInstance, service: StreamingService): void {
  /** Topics and what each carries. */
  app.get("/streaming/topics", async (_request: FastifyRequest, reply: FastifyReply) =>
    sendSuccess(reply, service.describeTopics()),
  );

  /** Downstream consumers and the topics they read. */
  app.get("/streaming/pipeline", async (_request: FastifyRequest, reply: FastifyReply) =>
    sendSuccess(reply, service.describePipeline()),
  );

  /** Transport, connection state and publish counters. */
  app.get("/streaming/status", async (_request: FastifyRequest, reply: FastifyReply) =>
    sendSuccess(reply, service.status()),
  );

  /** Events retained in-process while Kafka is disabled. */
  app.get("/streaming/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const limit = query.limit === undefined ? 50 : Number.parseInt(String(query.limit), 10);
    if (Number.isNaN(limit)) throw new ValidationError("limit must be a number");
    return sendSuccess(reply, service.listBuffered(limit));
  });

  /** Publish an event to a stream topic. */
  app.post("/streaming/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.topic !== "string") throw new ValidationError("topic is required");
    if (typeof body.eventName !== "string") throw new ValidationError("eventName is required");

    const published = await service.publish({
      topic: body.topic as StreamTopic,
      eventName: body.eventName,
      payload: isRecord(body.payload) ? body.payload : undefined,
      reference: typeof body.reference === "string" ? body.reference : undefined,
      eventId: typeof body.eventId === "string" ? body.eventId : undefined,
    });
    return sendCreated(reply, published);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
