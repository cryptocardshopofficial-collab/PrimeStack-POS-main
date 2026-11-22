import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/database.js";
import { logger } from "../../core/logger.js";
import { SupeService } from "./supe.service.js";
import { registerSupeRoutes } from "./supe.routes.js";

/**
 * SUPE module — inbound fund-credit engine and the bank-grade outbound
 * settlement/transmission service.
 *
 * Exports the service singleton so other modules can use it directly:
 *   import { supeService } from "../modules/supe/supe.module.js"
 *
 * Bank API endpoint / key default to env (SUPE_BANK_API_URL / SUPE_BANK_API_KEY)
 * and can be overridden per request on the transmit endpoint.
 */
export const supeService = new SupeService(prisma, {
  bankApiUrl: process.env.SUPE_BANK_API_URL,
  bankApiKey: process.env.SUPE_BANK_API_KEY,
});

export function registerSupeModule(app: FastifyInstance): void {
  registerSupeRoutes(app, supeService);
  logger.info("SUPE module registered");
}

export { SupeService };
