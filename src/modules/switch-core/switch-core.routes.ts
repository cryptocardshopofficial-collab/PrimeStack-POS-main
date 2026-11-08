import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SwitchCoreService } from "./switch-core.service.js";
import { sendSuccess, sendCreated, sendPaginated, parsePagination } from "../../shared/utils/response.js";
import { ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";

/**
 * Switch Core REST routes — settlement, reconciliation, chargebacks.
 * Base path: /settlement, /reconciliation, /chargebacks
 */
export function registerSwitchCoreRoutes(
  app: FastifyInstance,
  switchCoreService: SwitchCoreService,
): void {
  app.post("/acquirers", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      code?: string;
      name?: string;
      host?: string;
      port?: number;
      protocol?: string;
    };
    if (!body?.code?.trim()) throw new ValidationError("code is required");
    if (!body?.name?.trim()) throw new ValidationError("name is required");
    if (!body?.host?.trim()) throw new ValidationError("host is required");
    const acquirer = await switchCoreService.createAcquirer({
      code: body.code,
      name: body.name,
      host: body.host,
      port: body.port ?? 8583,
      protocol: body.protocol,
    });
    return sendCreated(reply, acquirer);
  });

  app.get("/acquirers", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const acquirers = await switchCoreService.listAcquirers();
      return sendSuccess(reply, acquirers);
    } catch (error) {
      logger.error({ err: error }, "Could not load acquirers; database unavailable or schema not migrated");
      return sendSuccess(reply, [], 200, {
        warning: "Acquirer data is temporarily unavailable",
        degraded: true,
      });
    }
  });

  app.get("/settlement-queue", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    try {
      const queue = await switchCoreService.listSettlementQueue(
        typeof query.status === "string" ? query.status : undefined,
      );
      return sendSuccess(reply, queue);
    } catch (error) {
      logger.error({ err: error }, "Could not load settlement queue; database unavailable or schema not migrated");
      return sendSuccess(reply, [], 200, {
        warning: "Settlement queue is temporarily unavailable",
        degraded: true,
      });
    }
  });

  app.get("/routing-rules", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const acquirers = await switchCoreService.listAcquirers();
      const rules = acquirers.map((acquirer, index) => ({
        id: acquirer.id,
        rule_name: acquirer.name,
        name: acquirer.name,
        acquirer_id: acquirer.id,
        acquirer_code: acquirer.code,
        match_tx_type: "Any",
        match_currency: "Any",
        priority: index + 1,
        status: acquirer.status,
      }));
      return sendSuccess(reply, rules);
    } catch (error) {
      logger.error({ err: error }, "Could not load routing rules; database unavailable or schema not migrated");
      return sendSuccess(reply, [], 200, {
        warning: "Routing rules are temporarily unavailable",
        degraded: true,
      });
    }
  });

  // ── Settlement ───────────────────────────────────

  app.post("/settlement/batches", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { merchantId: string; period?: string; currency?: string };
    if (!body?.merchantId) {
      throw new ValidationError("merchantId is required");
    }
    const result = await switchCoreService.createSettlementBatch(body.merchantId, body.period, body.currency);
    return sendCreated(reply, result);
  });

  app.get("/settlement/batches", async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const query = request.query as Record<string, unknown>;
    const result = await switchCoreService.listSettlementBatches({
      merchantId: query.merchantId as string | undefined,
      status: query.status as string | undefined,
      page,
      pageSize,
    });
    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/settlement/batches/:batchNumber", async (request: FastifyRequest, reply: FastifyReply) => {
    const { batchNumber } = request.params as { batchNumber: string };
    const batch = await switchCoreService.getSettlementBatch(batchNumber);
    return sendSuccess(reply, batch);
  });

  // ── Reconciliation ──────────────────────────────

  app.post("/reconciliation", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    if (!body?.source || !body?.reference || body?.expectedAmount === undefined || body?.actualAmount === undefined) {
      throw new ValidationError("source, reference, expectedAmount, and actualAmount are required");
    }
    const record = await switchCoreService.createReconciliationRecord(body as never);
    return sendCreated(reply, record);
  });

  app.get("/reconciliation", async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const query = request.query as Record<string, unknown>;
    const result = await switchCoreService.listReconciliations({
      settlementBatchId: query.settlementBatchId as string | undefined,
      status: query.status as string | undefined,
      page,
      pageSize,
    });
    return sendPaginated(reply, result.data, result.meta);
  });

  app.post("/reconciliation/:id/resolve", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { resolvedBy: string; notes?: string };
    const record = await switchCoreService.resolveReconciliation(id, body.resolvedBy, body.notes);
    return sendSuccess(reply, record);
  });

  // ── Chargebacks ──────────────────────────────────

  app.post("/chargebacks", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    if (!body?.transactionId || !body?.caseNumber || !body?.amount) {
      throw new ValidationError("transactionId, caseNumber, and amount are required");
    }
    const chargeback = await switchCoreService.createChargeback(body as never);
    return sendCreated(reply, chargeback);
  });

  app.get("/chargebacks", async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const query = request.query as Record<string, unknown>;
    const result = await switchCoreService.listChargebacks({
      status: query.status as string | undefined,
      transactionId: query.transactionId as string | undefined,
      page,
      pageSize,
    });
    return sendPaginated(reply, result.data, result.meta);
  });

  app.post("/chargebacks/:caseNumber/process", async (request: FastifyRequest, reply: FastifyReply) => {
    const { caseNumber } = request.params as { caseNumber: string };
    const body = request.body as { action: "ACCEPTED" | "CONTESTED"; processedBy?: string };
    if (!body?.action) {
      throw new ValidationError("action is required (ACCEPTED or CONTESTED)");
    }
    const chargeback = await switchCoreService.processChargeback(caseNumber, body.action, body.processedBy);
    return sendSuccess(reply, chargeback);
  });
}
