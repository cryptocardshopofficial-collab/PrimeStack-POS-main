import { FastifyInstance } from "fastify";
import { prisma } from "../../core/database.js";
import { logger } from "../../core/logger.js";
import { registerWebhookRoutes } from "./webhooks.routes.js";
import { WebhookService } from "./webhooks.service.js";

/**
 * Webhook orchestration module — merchant subscriptions, HMAC-signed delivery
 * and retry with exponential backoff.
 */
export const webhookService = new WebhookService(prisma);

export function registerWebhookModule(app: FastifyInstance): void {
  registerWebhookRoutes(app, webhookService);
  logger.info("Webhook orchestration module registered");
}

export { WebhookService };
