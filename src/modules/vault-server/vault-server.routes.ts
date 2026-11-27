import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { ForbiddenError, ValidationError } from "../../core/errors.js";
import { sendCreated, sendSuccess, parsePagination } from "../../shared/utils/response.js";
import { logger } from "../../core/logger.js";
import { VaultServerService } from "./vault-server.service.js";
import {
  createVaultConnectorSchema,
  updateVaultConnectorSchema,
  vaultReceiveSchema,
  vaultPayoutSchema,
} from "./vault-server.types.js";

const VAULT_SIGNATURE_HEADER = "x-vault-signature";
const VAULT_TIMESTAMP_HEADER = "x-vault-timestamp";
const VAULT_API_KEY_HEADER   = "x-vault-api-key";
const VAULT_EVENT_ID_HEADER  = "x-vault-event-id";

/**
 * Vault Server Routes
 *
 * Public receive endpoint:
 *   POST /vault/receive  — external systems push fund notifications here
 *
 * Admin-only (JWT):
 *   GET  /admin/vault/identity          — server identity & spec sheet
 *   POST /admin/vault/connectors        — register a bank connector
 *   GET  /admin/vault/connectors        — list connectors
 *   GET  /admin/vault/connectors/:id    — get connector
 *   PATCH /admin/vault/connectors/:id   — update connector
 *   POST /admin/vault/connectors/:id/generate-key — generate API key
 *   POST /admin/vault/connectors/:id/poll-balance — call bank API
 *   POST /admin/vault/payout            — move funds from vault
 *   GET  /admin/vault/transactions      — vault ledger history
 */
export function registerVaultServerRoutes(
  app: FastifyInstance,
  service: VaultServerService,
): void {

  // ── Public receive endpoint ──────────────────────────────────────
  // External systems (banks, payment processors, other private servers)
  // POST to this endpoint when funds arrive.
  //
  // Authentication: x-vault-api-key header
  // Optional signature: x-vault-signature = HMAC-SHA256(apiKey, timestamp + body)

  app.post("/vault/receive", async (req: FastifyRequest, reply: FastifyReply) => {
    const apiKey    = req.headers[VAULT_API_KEY_HEADER] as string | undefined;
    const signature = req.headers[VAULT_SIGNATURE_HEADER] as string | undefined;
    const timestamp = req.headers[VAULT_TIMESTAMP_HEADER] as string | undefined;
    const eventId   = req.headers[VAULT_EVENT_ID_HEADER] as string | undefined;

    if (!apiKey) {
      throw new ValidationError(`Missing ${VAULT_API_KEY_HEADER} header`);
    }

    // Verify API key and get connector
    const connector = await service.verifyApiKey(apiKey);

    // Optional timestamp check (± 10 minutes)
    if (timestamp) {
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60 * 1000) {
        throw new ValidationError("Vault timestamp is expired or invalid");
      }

      // Optional HMAC signature verification
      if (signature) {
        const body = req.body ? JSON.stringify(req.body) : "";
        const expected = createHmac("sha256", apiKey)
          .update(`${timestamp}${body}`)
          .digest("hex");
        const sigBuf = Buffer.from(signature.replace(/^0x/, ""), "hex");
        const expBuf = Buffer.from(expected, "hex");
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
          logger.warn({ ip: req.ip, connectorId: connector.id }, "Vault receive: signature mismatch");
          throw new ValidationError("Vault signature is invalid");
        }
      }
    }

    const body = req.body as Record<string, unknown>;

    // Inject eventId from header if not in body
    if (!body.eventId && eventId) {
      (body as Record<string, unknown>).eventId = eventId;
    }

    // Inject vaultAccountCode from connector if not in body
    if (!body.vaultAccountCode) {
      (body as Record<string, unknown>).vaultAccountCode = connector.vaultAccountCode;
    }

    const parsed = vaultReceiveSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid vault receive payload", {
        errors: parsed.error.errors,
      });
    }

    const result = await service.receiveInbound(parsed.data);

    logger.info(
      { connectorId: connector.id, eventId: parsed.data.eventId,
        amount: result.amount, currency: result.currency,
        duplicate: result.duplicate },
      "Vault receive processed",
    );

    return reply.status(result.duplicate ? 200 : 201).send({
      success: true,
      data: {
        ...result,
        connector: { id: connector.id, label: connector.label },
      },
    });
  });

  // ── Admin routes (JWT protected) ─────────────────────────────────

  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", async (request, reply) => {
      await adminApp.authenticate(request, reply);
      const role = (request.user as { role?: string } | undefined)?.role;
      if (!role || !["SUPER_ADMIN", "ADMIN", "OPERATOR"].includes(role)) {
        throw new ForbiddenError("Your admin role cannot access vault server management");
      }
    });

    // Identity
    adminApp.get("/admin/vault/identity", async (_req, reply) => {
      return sendSuccess(reply, service.getIdentity());
    });

    // Create connector
    adminApp.post("/admin/vault/connectors", async (req, reply) => {
      const parsed = createVaultConnectorSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid connector data", { errors: parsed.error.errors });
      }
      const connector = await service.createConnector(parsed.data);
      // Strip encrypted API key from response
      const { apiKey: _, ...safe } = connector as typeof connector & { apiKey?: string };
      return sendCreated(reply, safe);
    });

    // List connectors
    adminApp.get("/admin/vault/connectors", async (_req, reply) => {
      const connectors = await service.listConnectors();
      const safe = connectors.map(({ apiKey: _, ...c }) => c);
      return sendSuccess(reply, safe);
    });

    // Get connector
    adminApp.get("/admin/vault/connectors/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const connector = await service.getConnector(id);
      const { apiKey: _, ...safe } = connector as typeof connector & { apiKey?: string };
      return sendSuccess(reply, safe);
    });

    // Update connector
    adminApp.patch("/admin/vault/connectors/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = updateVaultConnectorSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid update", { errors: parsed.error.errors });
      }
      const updated = await service.updateConnector(id, parsed.data);
      const { apiKey: _, ...safe } = updated as typeof updated & { apiKey?: string };
      return sendSuccess(reply, safe);
    });

    // Generate API key
    adminApp.post("/admin/vault/connectors/:id/generate-key", async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await service.generateApiKey(id);
      // apiKey returned once only — log the key ID
      logger.info({ connectorId: id, keyId: result.keyId }, "Vault API key generated and returned");
      return sendCreated(reply, result);
    });

    // Poll bank balance
    adminApp.post("/admin/vault/connectors/:id/poll-balance", async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await service.pollBankBalance(id);
      return sendSuccess(reply, result);
    });

    // Payout from vault
    adminApp.post("/admin/vault/payout", async (req, reply) => {
      const parsed = vaultPayoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid payout data", { errors: parsed.error.errors });
      }
      const result = await service.payout(parsed.data);
      return sendCreated(reply, result);
    });

    // Transaction history
    adminApp.get("/admin/vault/transactions", async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const { page, pageSize } = parsePagination(query);
      const result = await service.listTransactions({
        vaultAccountCode: query.vaultAccountCode as string | undefined,
        page,
        pageSize,
      });
      return sendSuccess(reply, result);
    });

  }, { prefix: "" });
}
