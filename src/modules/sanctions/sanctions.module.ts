import { FastifyInstance } from "fastify";
import { prisma } from "../../core/database.js";
import { logger } from "../../core/logger.js";
import { registerSanctionsRoutes } from "./sanctions.routes.js";
import { SanctionsService } from "./sanctions.service.js";

/**
 * Sanctions screening module — watchlist import and party screening against
 * OFAC, UN, EU, UK HMT, UAE local and internal lists.
 */
export const sanctionsService = new SanctionsService(prisma);

export function registerSanctionsModule(app: FastifyInstance): void {
  registerSanctionsRoutes(app, sanctionsService);
  logger.info("Sanctions screening module registered");
}

export { SanctionsService };
