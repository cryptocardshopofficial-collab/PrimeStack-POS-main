import { FastifyInstance } from "fastify";
import { prisma } from "../../core/database.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { VaultServerService } from "./vault-server.service.js";
import { registerVaultServerRoutes } from "./vault-server.routes.js";
import { logger } from "../../core/logger.js";

export const vaultServerService = new VaultServerService(prisma, ledgerService);

export function registerVaultServerModule(app: FastifyInstance): void {
  registerVaultServerRoutes(app, vaultServerService);
  logger.info("Vault Server module registered");
}

export { VaultServerService };
