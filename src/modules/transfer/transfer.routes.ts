import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { TransferService } from "./transfer.service.js";
import { createTransferSchema, bulkTransferSchema, payoutSchema } from "./types.js";
import { sendSuccess, sendCreated, sendPaginated, parsePagination } from "../../shared/utils/response.js";
import { ForbiddenError, ValidationError } from "../../core/errors.js";

/**
 * Transfer REST routes.
 *
 * Base path: /transfers
 */
export function registerTransferRoutes(
  app: FastifyInstance,
  transferService: TransferService,
): void {
  app.post("/transfers", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createTransferSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid transfer data", { errors: parsed.error.errors });
    }

    const transfer = await transferService.createTransfer(parsed.data);
    return sendCreated(reply, transfer);
  });

  app.post("/transfers/bulk", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = bulkTransferSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid bulk transfer data", { errors: parsed.error.errors });
    }

    const result = await transferService.createBulkTransfer(parsed.data);
    return sendCreated(reply, result);
  });

  app.get("/transfers", async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const query = request.query as Record<string, unknown>;

    const result = await transferService.listTransfers({
      type: query.type as string | undefined,
      status: query.status as string | undefined,
      merchantId: query.merchantId as string | undefined,
      page,
      pageSize,
    });

    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/transfers/:reference", async (request: FastifyRequest, reply: FastifyReply) => {
    const { reference } = request.params as { reference: string };
    const transfer = await transferService.getTransfer(reference);
    return sendSuccess(reply, transfer);
  });

  app.post("/transfers/:reference/reverse", async (request: FastifyRequest, reply: FastifyReply) => {
    const { reference } = request.params as { reference: string };
    const body = request.body as { reason: string };

    if (!body?.reason) {
      throw new ValidationError("reason is required");
    }

    const transfer = await transferService.reverseTransfer(reference, body.reason);
    return sendSuccess(reply, transfer);
  });

  /**
   * Pending payout queue for the administrator approval inbox.
   */
  app.get("/transfers/pending", async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const query = request.query as Record<string, unknown>;

    const result = await transferService.listPendingTransfers({
      merchantId: query.merchantId as string | undefined,
      page,
      pageSize,
    });

    return sendPaginated(reply, result.data, result.meta);
  });

  /**
   * Approve a pending payout — this is the moment funds actually move.
   */
  app.post("/transfers/:reference/approve", async (request: FastifyRequest, reply: FastifyReply) => {
    const { reference } = request.params as { reference: string };
    const user = request.user as { id?: string } | undefined;
    if (!user?.id) {
      throw new ValidationError("An approver identity is required");
    }

    const transfer = await transferService.approveTransfer(reference, user.id);
    reply.header("cache-control", "no-store");
    return sendSuccess(reply, transfer);
  });

  app.post("/transfers/:reference/reject", async (request: FastifyRequest, reply: FastifyReply) => {
    const { reference } = request.params as { reference: string };
    const body = request.body as { reason?: string };
    if (!body?.reason || !body.reason.trim()) {
      throw new ValidationError("reason is required");
    }

    const user = request.user as { id?: string } | undefined;
    if (!user?.id) {
      throw new ValidationError("A reviewer identity is required");
    }

    const transfer = await transferService.rejectTransfer(
      reference,
      user.id,
      body.reason.trim(),
    );
    reply.header("cache-control", "no-store");
    return sendSuccess(reply, transfer);
  });
}

/**
 * Merchant-facing payout routes.
 *
 * Registered under the /merchant-portal prefix so the merchant JWT session can
 * reach them. Payouts submitted here execute immediately without administrator
 * approval.
 */
export function registerMerchantPayoutRoutes(
  app: FastifyInstance,
  transferService: TransferService,
): void {
  app.post("/payouts", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = payoutSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid payout data", { errors: parsed.error.errors });
    }

    const user = request.user as
      | { id?: string; merchantId?: string | null; mustChangePassword?: boolean }
      | undefined;
    if (!user?.merchantId) {
      throw new ForbiddenError("A merchant account is required to send payouts");
    }
    if (user.mustChangePassword) {
      throw new ForbiddenError("Change your password before sending payouts");
    }

    const body = parsed.data;
    const isBankPayout = body.type === "bank_payout";

    if (isBankPayout) {
      if (!body.beneficiaryName?.trim() || !body.iban?.trim()) {
        throw new ValidationError(
          "beneficiaryName and iban are required for a bank payout",
        );
      }
    } else if (!body.address?.trim()) {
      throw new ValidationError("address is required for a crypto payout");
    }

    const transfer = await transferService.createPayout({
      type: isBankPayout ? "BANK_PAYOUT" : "CRYPTO_PAYOUT",
      amount: body.amount,
      currency: body.currency,
      merchantId: user.merchantId,
      destId: isBankPayout ? body.iban : body.address,
      description: isBankPayout
        ? `Bank payout to ${body.beneficiaryName}${body.reference ? ` (${body.reference})` : ""}`
        : `Crypto payout to ${body.address}${body.asset ? ` (${body.asset})` : ""}`,
      metadata: { ...body },
    });

    reply.header("cache-control", "no-store");
    return sendCreated(reply, transfer);
  });

  app.get("/payouts", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as { merchantId?: string | null } | undefined;
    if (!user?.merchantId) {
      throw new ForbiddenError("A merchant account is required to view payouts");
    }

    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);

    const result = await transferService.listTransfers({
      merchantId: user.merchantId,
      page,
      pageSize,
    });

    return sendPaginated(reply, result.data, result.meta);
  });
}
