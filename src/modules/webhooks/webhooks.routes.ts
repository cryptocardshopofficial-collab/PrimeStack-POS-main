import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "../../core/errors.js";
import { parsePagination, sendCreated, sendNoContent, sendPaginated, sendSuccess } from "../../shared/utils/response.js";
import { WebhookService } from "./webhooks.service.js";
import type { WebhookEventName } from "./webhooks.types.js";

/**
 * Webhook orchestration routes.
 * Base path: /webhooks
 */
export function registerWebhookRoutes(app: FastifyInstance, service: WebhookService): void {
  /** Event names a subscriber can register for. */
  app.get("/webhooks/events", async (_request: FastifyRequest, reply: FastifyReply) =>
    sendSuccess(reply, service.describeEvents()),
  );

  /** Create a subscription — the signing secret is returned once. */
  app.post("/webhooks/subscriptions", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.callbackUrl !== "string") throw new ValidationError("callbackUrl is required");
    if (!Array.isArray(body.eventNames)) throw new ValidationError("eventNames must be an array");

    const created = await service.createSubscription({
      callbackUrl: body.callbackUrl,
      eventNames: body.eventNames as string[],
      ownerType: typeof body.ownerType === "string" ? body.ownerType : undefined,
      merchantId: typeof body.merchantId === "string" ? body.merchantId : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      maxAttempts: typeof body.maxAttempts === "number" ? body.maxAttempts : undefined,
      secret: typeof body.secret === "string" ? body.secret : undefined,
    });
    return sendCreated(reply, created);
  });

  /** List subscriptions (secrets masked). */
  app.get("/webhooks/subscriptions", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = parsePagination(query);
    const result = await service.listSubscriptions({
      merchantId: query.merchantId as string | undefined,
      eventName: query.eventName as string | undefined,
      active: query.active === undefined ? undefined : String(query.active) !== "false",
      page,
      pageSize,
    });
    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/webhooks/subscriptions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sendSuccess(reply, await service.getSubscription(id));
  });

  app.patch("/webhooks/subscriptions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const updated = await service.updateSubscription(id, {
      callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
      eventNames: Array.isArray(body.eventNames) ? (body.eventNames as string[]) : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      maxAttempts: typeof body.maxAttempts === "number" ? body.maxAttempts : undefined,
    });
    return sendSuccess(reply, updated);
  });

  app.post("/webhooks/subscriptions/:id/rotate-secret", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sendSuccess(reply, await service.rotateSecret(id));
  });

  app.delete("/webhooks/subscriptions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    await service.deleteSubscription(id);
    return sendNoContent(reply);
  });

  /** Fan an event out to every matching subscriber. */
  app.post("/webhooks/dispatch", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.eventName !== "string") throw new ValidationError("eventName is required");

    const result = await service.dispatch({
      eventName: body.eventName as WebhookEventName,
      reference: typeof body.reference === "string" ? body.reference : undefined,
      payload: isRecord(body.payload) ? body.payload : undefined,
      eventId: typeof body.eventId === "string" ? body.eventId : undefined,
    });
    return sendCreated(reply, result);
  });

  /** Delivery history. */
  app.get("/webhooks/deliveries", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = parsePagination(query);
    const result = await service.listDeliveries({
      subscriptionId: query.subscriptionId as string | undefined,
      eventName: query.eventName as string | undefined,
      status: query.status as string | undefined,
      reference: query.reference as string | undefined,
      page,
      pageSize,
    });
    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/webhooks/deliveries/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sendSuccess(reply, await service.getDelivery(id));
  });

  /** Manually re-attempt one delivery. */
  app.post("/webhooks/deliveries/:id/retry", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sendSuccess(reply, await service.attemptDelivery(id));
  });

  /** Run the retry worker once for every delivery that is due. */
  app.post("/webhooks/deliveries/deliver-pending", async (_request: FastifyRequest, reply: FastifyReply) =>
    sendSuccess(reply, await service.deliverPending()),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
