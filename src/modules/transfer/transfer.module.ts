import { FastifyInstance } from "fastify";
import { prisma } from "../../core/database.js";
import { TransferService } from "./transfer.service.js";
import { registerTransferRoutes, registerMerchantPayoutRoutes } from "./transfer.routes.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { walletService } from "../wallet/wallet.module.js";
import { logger } from "../../core/logger.js";
import { ForbiddenError } from "../../core/errors.js";

/**
 * Transfer module — registers the service and routes.
 *
 * Exports the TransferService instance for use by other modules
 * (settlement, payouts, wallet transfers).
 */
export const transferService = new TransferService(prisma, ledgerService, walletService);

export function registerTransferModule(app: FastifyInstance): void {
  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", async (request, reply) => {
      await adminApp.authenticate(request, reply);
      const role = (request.user as { role?: string } | undefined)?.role;
      if (!role || !["SUPER_ADMIN", "ADMIN", "OPERATOR"].includes(role)) {
        throw new ForbiddenError("Your admin role cannot perform transfer operations");
      }
    });
    registerTransferRoutes(adminApp, transferService);
  }, { prefix: "/admin" });

  // Merchant-facing payouts: every submission is held for administrator approval.
  app.register(async (merchantApp) => {
    merchantApp.addHook("preHandler", async (request, reply) => {
      await merchantApp.authenticate(request, reply);
      const role = (request.user as { role?: string } | undefined)?.role;
      if (role !== "MERCHANT") {
        throw new ForbiddenError("Only merchant logins can submit payouts");
      }
    });
    registerMerchantPayoutRoutes(merchantApp, transferService);
  }, { prefix: "/merchant-portal" });

  logger.info("Transfer module registered");
}

export { TransferService };
