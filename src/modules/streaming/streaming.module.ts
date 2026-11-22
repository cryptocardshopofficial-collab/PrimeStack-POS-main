import { FastifyInstance } from "fastify";
import { logger } from "../../core/logger.js";
import { registerStreamingRoutes } from "./streaming.routes.js";
import { StreamingService, streamingOptionsFromConfig } from "./streaming.service.js";

/**
 * Event-streaming module — Kafka producer for the payment lifecycle, plus
 * topic and pipeline metadata for the dashboard.
 */
export const streamingService = new StreamingService(streamingOptionsFromConfig());

export function registerStreamingModule(app: FastifyInstance): void {
  registerStreamingRoutes(app, streamingService);
  logger.info("Event streaming module registered");
}

export { StreamingService, streamingOptionsFromConfig };
