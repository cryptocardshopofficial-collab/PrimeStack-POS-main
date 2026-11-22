import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";

import { ForbiddenError, NotFoundError } from "../../core/errors.js";
import { sendSuccess, sendCreated } from "../../shared/utils/response.js";
import { renderIncomingPaymentPdf } from "./incoming-payment-pdf.js";

import {
  SupeService,
  type SupeContext,
} from "./supe.service.js";

import {
  formatExtension,
  formatMime,
  parsePacs002StatusReport,
} from "./supe.formats.js";

import {
  listInstructionsSchema,
  listInboundPaymentsSchema,
  type SupeSettlementFormat,
  type SupeTransmissionChannel,
} from "./types.js";

const ADMIN_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "OPERATOR",
];

type JwtUser = {
  id?: string;
  email?: string;
  role?: string;
  merchantId?: string;
} | undefined;

type RawBodyRequest = FastifyRequest & {
  rawBody?: Buffer;
};

function ctxFrom(req: FastifyRequest): SupeContext {
  const user = req.user as JwtUser;
  return { userId: user?.id, merchantId: user?.merchantId, role: user?.role, ip: req.ip };
}

/**
 * SUPE routes.
 *
 * Inbound  (fund credit):  POST /supe/process, GET /supe/uploads[/:ref/pdf],
 *                         POST /supe/ingest/xml  (HMAC)
 * Outbound (bank-grade):   POST /supe/instructions, GET /supe/instructions,
 *                         GET /supe/instructions/:ref, GET .../download,
 *                         POST /supe/instructions/:ref/{transmit,execute,
 *                         reject,cancel}, POST /supe/instructions/callback
 *                         (HMAC pacs.002).
 */
export function registerSupeRoutes(app: FastifyInstance, supeService: SupeService): void {
  // ── Admin guard for outbound mutation routes ──
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    const role = (request.user as JwtUser)?.role;
    if (!ADMIN_ROLES.includes(role ?? "")) {
      throw new ForbiddenError("Your role cannot manage settlement instructions");
    }
  };

  // ════════════════════════════════════════════════
  // Inbound — fund upload credit
  // ════════════════════════════════════════════════

  app.post("/supe/process", { preHandler: app.authenticate }, async (req, reply) => {
    const result = await supeService.processFundUpload(req.body as Record<string, unknown>, ctxFrom(req));
    return sendCreated(reply, result);
  });

  app.get("/supe/uploads", { preHandler: app.authenticate }, async (req, reply) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(parseInt(q.limit || "20", 10), 100);
    const uploads = await supeService.listUploads(ctxFrom(req), limit);
    return sendSuccess(reply, { uploads, count: uploads.length });
  });

  app.get("/supe/uploads/:reference/pdf", { preHandler: app.authenticate }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const ctx = ctxFrom(req);
    const entry = await supeService.getUploadForPdf(reference, ctx);

    const meta = (entry.metadata as Record<string, unknown> | null) || {};
    const amountLine = entry.lines.find((l) => !l.credit.isZero()) || entry.lines[0];

    const pdfBuffer = await renderIncomingPaymentPdf({
      reference: (meta.originalReference as string) || entry.reference,
      journalRef: entry.reference,
      amount: amountLine?.credit.toString() || "0",
      currency: (meta.currency as string) || "USD",
      format: (meta.supeFormat as string) || null,
      sender: (meta.sender as string) || null,
      senderAccount: (meta.senderAccount as string) || null,
      valueDate: (meta.valueDate as string) || null,
      fileName: (meta.fileName as string) || null,
      note: (meta.note as string) || null,
      destination: amountLine?.account.code || (meta.destination as string) || null,
      status: entry.status === "POSTED" ? "CREDITED" : entry.status,
      createdAt: entry.createdAt,
      lines: entry.lines.map((l) => ({
        debit: l.debit.toString(),
        credit: l.credit.toString(),
        accountCode: l.account.code,
      })),
    });

    const safeName = reference.replace(/[^a-zA-Z0-9_-]/g, "_");
    return reply
      .type("application/pdf")
      .header("Content-Disposition", `attachment; filename="incoming-payment-${safeName}.pdf"`)
      .header("Content-Length", String(pdfBuffer.length))
      .send(pdfBuffer);
  });

  // ── Direct ISO 20022 / XML ingest (server-to-server, HMAC) ──
  app.post("/supe/ingest/xml", async (req, reply) => {
    const rawBody = (req as RawBodyRequest).rawBody;
    const payload = rawBody ?? Buffer.from(typeof req.body === "string" ? req.body : "");
    const result = await supeService.ingestXml(payload, req.headers, req.ip);
    // ACK for non-crediting messages is a 200; credited is a 201.
    if ("credited" in result && result.credited) return sendCreated(reply, result);
    return sendSuccess(reply, result);
  });

  // ════════════════════════════════════════════════
  // Outbound — bank-grade settlement instructions
  // ════════════════════════════════════════════════

  app.post("/supe/instructions", { preHandler: requireAdmin }, async (req, reply) => {
    const instruction = await supeService.createInstruction(req.body, ctxFrom(req));
    return sendCreated(reply, instruction);
  });

  app.get("/supe/instructions", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = listInstructionsSchema.safeParse(req.query);
    if (!parsed.success) throw new NotFoundError("Invalid instruction filters");
    const instructions = await supeService.listInstructions(parsed.data, ctxFrom(req));
    return sendSuccess(reply, { instructions, count: instructions.length });
  });

  app.get("/supe/instructions/:reference", { preHandler: requireAdmin }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const instruction = await supeService.getInstruction(reference, ctxFrom(req));
    return sendSuccess(reply, instruction);
  });

  app.get("/supe/instructions/:reference/download", { preHandler: requireAdmin }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const file = await supeService.getPayload(reference, ctxFrom(req));
    const safeName = reference.replace(/[^a-zA-Z0-9_-]/g, "_");
    return reply
      .type(file.mime)
      .header(
        "Content-Disposition",
        `attachment; filename="${safeName}.${file.extension}"`,
      )
      .header("Content-Length", Buffer.byteLength(file.payload, "utf8").toString())
      .send(file.payload);
  });

  app.post("/supe/instructions/:reference/transmit", { preHandler: requireAdmin }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const result = await supeService.transmit(reference, req.body, ctxFrom(req));
    return sendSuccess(reply, result);
  });

  app.post("/supe/instructions/:reference/execute", { preHandler: requireAdmin }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const instruction = await supeService.confirmExecution(reference, req.body, ctxFrom(req));
    return sendSuccess(reply, instruction);
  });

  app.post("/supe/instructions/:reference/reject", { preHandler: requireAdmin }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const instruction = await supeService.rejectInstruction(reference, req.body, ctxFrom(req));
    return sendSuccess(reply, instruction);
  });

  app.post("/supe/instructions/:reference/cancel", { preHandler: requireAdmin }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const instruction = await supeService.cancelInstruction(reference, ctxFrom(req));
    return sendSuccess(reply, instruction);
  });

  // ── Automated bank callback: ISO 20022 pacs.002 status report (HMAC) ──
  // The bank posts the validation/execution outcome as a pacs.002 XML document,
  // signed with an X-PrimeStack-* HMAC. rawBody is captured for application/xml.
  app.post("/supe/instructions/callback", async (req, reply) => {
    const rawBody = (req as RawBodyRequest).rawBody;
    const payload = rawBody ?? Buffer.from(typeof req.body === "string" ? req.body : "");
    await supeService.verifyInboundHmac(payload, req.headers);
    const report = parsePacs002StatusReport(payload.toString("utf8"));
    const instruction = await supeService.applyBankStatusReport(report, { ip: req.ip });
    return sendSuccess(reply, instruction);
  });

  // ════════════════════════════════════════════════
  // Bank-feed inbound payment tracking
  // ════════════════════════════════════════════════

  app.get("/supe/inbound", { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = listInboundPaymentsSchema.safeParse(req.query);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join(", ");
      throw new Error(msg);
    }
    const payments = await supeService.listInboundPayments(parsed.data, ctxFrom(req));
    return sendSuccess(reply, { payments, count: payments.length });
  });

  app.get("/supe/inbound/:endToEndId", { preHandler: app.authenticate }, async (req, reply) => {
    const { endToEndId } = req.params as { endToEndId: string };
    const payment = await supeService.getInboundPayment(endToEndId, ctxFrom(req));
    return sendSuccess(reply, payment);
  });
}

// Re-export the channel/format enums for the module consumers / swagger.
export { formatExtension, formatMime };
export type { SupeSettlementFormat, SupeTransmissionChannel };
