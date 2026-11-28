import { FastifyInstance } from "fastify";
import { prisma } from "../../core/database.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { StripeService } from "./stripe.service.js";
import { registerStripeRoutes } from "./stripe.routes.js";
import { logger } from "../../core/logger.js";

export const stripeService = new StripeService(prisma, ledgerService);

export function registerStripeModule(app: FastifyInstance): void {
  registerStripeRoutes(app, stripeService);
  logger.info("Stripe SEPA module registered");
}

export { StripeService };