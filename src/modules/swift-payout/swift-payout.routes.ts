import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ForbiddenError, ValidationError } from "../../core/errors.js";
import { sendSuccess, sendCreated } from "../../shared/utils/response.js";
import { swiftPayoutDashboardHtml } from "./swift-payout-dashboard.js";
import { generateSwiftPayoutDraft } from "./swift-payout.service.js";
import { swiftPayoutDraftSchema } from "./swift-payout.types.js";
import { executeSwiftWirePayout } from "./swift-wire.service.js";

const payoutDraftRoles = ["SUPER_ADMIN", "ADMIN", "OPERATOR"];

const address = z.array(z.string().trim().min(1).max(140)).max(4).optional();

const swiftWireSchema = z.object({
  amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
  currency: z.literal("USD").default("USD"),
  sourceAccountCode: z.string().trim().min(1).max(64),
  beneficiaryAccountCode: z.string().trim().min(1).max(64),
  beneficiaryName: z.string().trim().min(1).max(140),
  beneficiaryAccountNumber: z.string().trim().min(1).max(34).optional(),
  beneficiaryAddress: address,
  receivingBankName: z.string().trim().min(1).max(140),
  receivingBankAddress: address,
  receivingBankAccount: z.string().trim().min(1).max(34).optional(),
  receivingBankBic: z.string().trim().min(8).max(11).optional(),
  intermediaryBic: z.string().trim().min(8).max(11).optional(),
  intermediaryName: z.string().trim().max(140).optional(),
  orderingCustomerName: z.string().trim().min(1).max(140),
  orderingCustomerAccount: z.string().trim().max(34).optional(),
  reference: z.string().trim().max(16).optional(),
  remittanceInfo: z.string().trim().max(140).optional(),
  chargeBearer: z.enum(["OUR", "SHA", "BEN"]).default("SHA"),
  valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export function registerSwiftPayoutModule(app: FastifyInstance): void {
  app.get("/admin/swift-payout-draft", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(swiftPayoutDashboardHtml);
  });

  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", async (request, reply) => {
      await adminApp.authenticate(request, reply);
      const role = (request.user as { role?: string } | undefined)?.role;
      if (!role || !payoutDraftRoles.includes(role)) {
        throw new ForbiddenError("Your admin role cannot create SWIFT payout drafts");
      }
    });

    adminApp.post("/swift-payouts/draft", async (request, reply) => {
      const parsed = swiftPayoutDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid SWIFT payout draft", { errors: parsed.error.errors });
      }
      return sendSuccess(reply, generateSwiftPayoutDraft(parsed.data));
    });

    // Books the ledger movement and emits an MT103 for the operator's bank to send.
    adminApp.post("/swift-payouts/wire", async (request, reply) => {
      const parsed = swiftWireSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid SWIFT wire request", { errors: parsed.error.errors });
      }
      const actor = request.user as { id?: string } | undefined;
      if (!actor?.id) {
        throw new ValidationError("An operator identity is required");
      }
      return sendCreated(reply, await executeSwiftWirePayout({ ...parsed.data, postedBy: actor.id }));
    });
  }, { prefix: "/admin" });
}
