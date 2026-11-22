import { FastifyInstance } from "fastify";
import { logger } from "../../core/logger.js";
import { registerSwiftMtRoutes } from "./swift-mt.routes.js";
import { SwiftMtService } from "./swift-mt.service.js";

/**
 * SWIFT MT module — MT103 / MT202 parsing and validation.
 * Stateless: no database access.
 */
export const swiftMtService = new SwiftMtService();

export function registerSwiftMtModule(app: FastifyInstance): void {
  registerSwiftMtRoutes(app, swiftMtService);
  logger.info("SWIFT MT module registered");
}

export { SwiftMtService };
