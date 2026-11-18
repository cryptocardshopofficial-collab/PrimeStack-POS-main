import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MerchantService } from "./merchant.service.js";
import { MerchantRegistrationService } from "./merchant-registration.service.js";
import {
  registerMerchantPublicSchema,
  validateAgentCodeSchema,
} from "./merchant-registration.types.js";
import {
  adminTransactionControlSchema,
  assignAgentSchema,
  assignMerchantWalletSchema,
  createKycDocumentSchema,
  createMerchantBankAccountSchema,
  createMerchantInvoiceSchema,
  createMerchantSchema,
  createMidSchema,
  createPaymentLinkSchema,
  createPricingPlanSchema,
  merchantRiskProfileSchema,
  merchantTransactionControlRequestSchema,
  reviewKycDocumentSchema,
  reviewMerchantTransactionControlSchema,
  updateMerchantSchema,
  updateMerchantStatusSchema,
} from "./merchant.types.js";
import {
  sendSuccess,
  sendCreated,
  sendPaginated,
  parsePagination,
} from "../../shared/utils/response.js";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../../core/errors.js";

/**
 * Merchant REST routes.
 * Base path: /merchants
 */
export function registerMerchantRoutes(
  app: FastifyInstance,
  merchantService: MerchantService,
): void {
  app.get("/merchants/overview", async (_request, reply) => {
    return sendSuccess(reply, await merchantService.getMerchantDashboard());
  });

  app.post(
    "/merchants",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createMerchantSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid merchant data", {
          errors: parsed.error.errors,
        });
      }
      const merchant = await merchantService.createMerchant(parsed.data);
      return sendCreated(reply, merchant);
    },
  );

  app.get(
    "/merchants",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { page, pageSize } = parsePagination(
        request.query as Record<string, unknown>,
      );
      const query = request.query as Record<string, unknown>;
      const result = await merchantService.listMerchants({
        status: query.status as string | undefined,
        country: query.country as string | undefined,
        page,
        pageSize,
      });
      return sendPaginated(reply, result.data, result.meta);
    },
  );

  app.get("/merchants/:id/home", async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendSuccess(reply, await merchantService.getMerchantHome(id));
  });

  app.get(
    "/merchants/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const merchant = await merchantService.getMerchant(id);
      return sendSuccess(reply, merchant);
    },
  );

  app.get(
    "/merchants/:id/stats",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const stats = await merchantService.getMerchantStats(id);
      return sendSuccess(reply, stats);
    },
  );

  app.patch(
    "/merchants/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = updateMerchantSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid update data", {
          errors: parsed.error.errors,
        });
      }
      const merchant = await merchantService.updateMerchant(id, parsed.data);
      return sendSuccess(reply, merchant);
    },
  );

  app.post(
    "/merchants/:id/suspend",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { reason?: string };
      const merchant = await merchantService.suspendMerchant(id, body?.reason);
      return sendSuccess(reply, merchant);
    },
  );

  app.post(
    "/merchants/:id/reactivate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const merchant = await merchantService.reactivateMerchant(id);
      return sendSuccess(reply, merchant);
    },
  );

  // Provision (or reset) the merchant's portal login. The one-time password is
  // returned exactly once and must never be cached.
  app.post(
    "/merchants/:id/portal-credentials",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      if (user.role !== "SUPER_ADMIN" && user.role !== "ADMIN") {
        throw new ForbiddenError(
          "Only administrators can provision merchant portal access",
        );
      }
      const { id } = request.params as { id: string };
      const credentials = await merchantService.createPortalCredentials(
        id,
        user.id,
        request.ip,
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : "unknown",
      );
      reply.header("cache-control", "no-store");
      return sendCreated(reply, credentials);
    },
  );

  app.patch("/merchants/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateMerchantStatusSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid merchant status", {
        errors: parsed.error.errors,
      });
    return sendSuccess(
      reply,
      await merchantService.setMerchantStatus(id, parsed.data.status),
    );
  });

  app.get("/merchants/:id/mids", async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendSuccess(reply, await merchantService.listMerchantIds(id));
  });

  app.post("/merchants/:id/mids", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = createMidSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid MID data", {
        errors: parsed.error.errors,
      });
    return sendCreated(
      reply,
      await merchantService.createMerchantId(id, parsed.data),
    );
  });

  app.get("/merchants/:id/terminals", async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendSuccess(reply, await merchantService.listMerchantTerminals(id));
  });

  app.put(
    "/merchants/:id/terminals/:terminalId/mid",
    async (request, reply) => {
      const { id, terminalId } = request.params as {
        id: string;
        terminalId: string;
      };
      const body = request.body as { mid?: string };
      if (!body?.mid?.trim()) throw new ValidationError("mid is required");
      return sendSuccess(
        reply,
        await merchantService.assignTerminal(id, terminalId, body.mid.trim()),
      );
    },
  );

  app.get("/merchants/:id/kyc-documents", async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendSuccess(reply, await merchantService.listKycDocuments(id));
  });

  app.post("/merchants/:id/kyc-documents", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = createKycDocumentSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid KYC document", {
        errors: parsed.error.errors,
      });
    return sendCreated(
      reply,
      await merchantService.addKycDocument(id, parsed.data),
    );
  });

  app.patch("/merchants/kyc-documents/:documentId", async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const parsed = reviewKycDocumentSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid KYC review", {
        errors: parsed.error.errors,
      });
    const reviewerId = (request.user as { id?: string } | undefined)?.id;
    return sendSuccess(
      reply,
      await merchantService.reviewKycDocument(documentId, {
        ...parsed.data,
        reviewedBy: reviewerId,
      }),
    );
  });

  app.put("/merchants/:id/risk-profile", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = merchantRiskProfileSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid risk profile", {
        errors: parsed.error.errors,
      });
    return sendSuccess(
      reply,
      await merchantService.setRiskProfile(id, parsed.data),
    );
  });

  app.get("/pricing-plans", async (_request, reply) => {
    return sendSuccess(reply, await merchantService.listPricingPlans());
  });

  app.post("/pricing-plans", async (request, reply) => {
    const parsed = createPricingPlanSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid pricing plan", {
        errors: parsed.error.errors,
      });
    return sendCreated(
      reply,
      await merchantService.createPricingPlan(parsed.data),
    );
  });

  app.put("/merchants/:id/pricing-plan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { pricingPlanId?: string | null };
    if (
      body?.pricingPlanId !== null &&
      typeof body?.pricingPlanId !== "string"
    ) {
      throw new ValidationError("pricingPlanId must be a UUID or null");
    }
    return sendSuccess(
      reply,
      await merchantService.assignPricingPlan(id, body.pricingPlanId ?? null),
    );
  });

  app.post("/merchants/:id/wallet-accounts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = assignMerchantWalletSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid merchant wallet mapping", {
        errors: parsed.error.errors,
      });
    return sendCreated(
      reply,
      await merchantService.mapMerchantWallet(id, parsed.data),
    );
  });

  app.put("/merchants/:id/agent", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = assignAgentSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid agent assignment", {
        errors: parsed.error.errors,
      });
    return sendSuccess(
      reply,
      await merchantService.assignAgent(id, parsed.data.agentId),
    );
  });

  // ── Merchant portal PIN administration ───────────

  const assertMerchantAdministrator = (request: FastifyRequest) => {
    const role = (request.user as { role?: string } | undefined)?.role;
    if (!role || !["SUPER_ADMIN", "ADMIN"].includes(role)) {
      throw new ForbiddenError(
        "Only administrators can manage merchant portal access",
      );
    }
  };

  app.get(
    "/merchants/:id/portal-pin",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      assertMerchantAdministrator(request);
      const { id } = request.params as { id: string };
      reply.header("cache-control", "no-store");
      return sendSuccess(
        reply,
        await merchantService.getMerchantPortalPinStatus(id),
      );
    },
  );

  app.post(
    "/merchants/:id/portal-pin",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = portalUser(request);
      assertMerchantAdministrator(request);
      const { id } = request.params as { id: string };
      const result = await merchantService.resetMerchantPortalPin(
        id,
        admin.id,
        request.ip,
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : "unknown",
      );
      reply.header("cache-control", "no-store");
      return sendCreated(reply, result);
    },
  );

  // ── Merchant pause / resume request review ───────

  app.get(
    "/merchant-transaction-requests",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, unknown>;
      const { page, pageSize } = parsePagination(query);
      const status = query.status;
      if (
        status !== undefined &&
        !["PENDING", "INFO_REQUESTED", "APPROVED", "REJECTED"].includes(
          String(status),
        )
      ) {
        throw new ValidationError("Invalid transaction control request status");
      }
      reply.header("cache-control", "no-store");
      const result = await merchantService.listMerchantControlRequestsForAdmin(
        status as
          | "PENDING"
          | "INFO_REQUESTED"
          | "APPROVED"
          | "REJECTED"
          | undefined,
        page,
        pageSize,
      );
      return sendPaginated(reply, result.data, result.meta);
    },
  );

  app.post(
    "/merchant-transaction-requests/:id/review",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = portalUser(request);
      if (!["SUPER_ADMIN", "ADMIN"].includes(admin.role)) {
        throw new ForbiddenError(
          "Only administrators can review merchant transaction requests",
        );
      }
      const { id } = request.params as { id: string };
      const parsed = reviewMerchantTransactionControlSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        throw new ValidationError("Invalid transaction control review", {
          errors: parsed.error.errors,
        });
      }
      reply.header("cache-control", "no-store");
      return sendSuccess(
        reply,
        await merchantService.reviewMerchantTransactionControlRequest(
          id,
          parsed.data.decision,
          parsed.data.adminRemarks,
          admin.id,
          request.ip,
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : "unknown",
        ),
      );
    },
  );

  // Administrator directly pausing or resuming a merchant transaction.
  app.post(
    "/merchants/:id/transactions/:transactionId/control",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = portalUser(request);
      if (!["SUPER_ADMIN", "ADMIN"].includes(admin.role)) {
        throw new ForbiddenError(
          "Only administrators can pause or resume merchant transactions",
        );
      }
      const { id, transactionId } = request.params as {
        id: string;
        transactionId: string;
      };
      const parsed = adminTransactionControlSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("A valid action and reason are required", {
          errors: parsed.error.errors,
        });
      }
      reply.header("cache-control", "no-store");
      return sendSuccess(
        reply,
        await merchantService.adminSetTransactionHold(
          id,
          transactionId,
          parsed.data.action,
          parsed.data.reason,
          admin.id,
          request.ip,
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : "unknown",
        ),
      );
    },
  );
}

function merchantContext(request: FastifyRequest): string {
  if (!request.merchant?.id)
    throw new UnauthorizedError("Merchant authentication is required");
  return request.merchant.id;
}

interface PortalUser {
  id: string;
  role: string;
  merchantId: string | null;
  mustChangePassword: boolean;
}

/** Read the JWT-authenticated portal user attached by app.authenticate. */
function portalUser(request: FastifyRequest): PortalUser {
  const user = request.user as
    | {
        id?: string;
        role?: string;
        merchantId?: string | null;
        mustChangePassword?: boolean;
      }
    | undefined;
  if (!user?.id) throw new UnauthorizedError("Authentication is required");
  return {
    id: user.id,
    role: user.role ?? "",
    merchantId: user.merchantId ?? null,
    mustChangePassword: user.mustChangePassword === true,
  };
}

/** Merchants may only touch their own account; staff roles may pick any. */
function assertMerchantScope(user: PortalUser, merchantId: string): void {
  if (user.role === "MERCHANT" && user.merchantId !== merchantId) {
    throw new ForbiddenError("You cannot access another merchant account");
  }
}

/** Force a password change before any merchant data is disclosed. */
function assertPasswordChanged(user: PortalUser): void {
  if (user.mustChangePassword) {
    throw new ForbiddenError(
      "Change your password before accessing merchant data",
    );
  }
}

export function registerMerchantPortalRoutes(
  app: FastifyInstance,
  merchantService: MerchantService,
): void {
  app.get("/merchant/profile", async (request, reply) => {
    return sendSuccess(
      reply,
      await merchantService.getMerchant(merchantContext(request)),
    );
  });

  app.get("/merchant/transactions", async (request, reply) => {
    const { page, pageSize } = parsePagination(
      request.query as Record<string, unknown>,
    );
    const result = await merchantService.listMerchantTransactions(
      merchantContext(request),
      page,
      pageSize,
    );
    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/merchant/terminals", async (request, reply) => {
    return sendSuccess(
      reply,
      await merchantService.listMerchantTerminals(merchantContext(request)),
    );
  });

  app.get("/merchant/kyc-documents", async (request, reply) => {
    return sendSuccess(
      reply,
      await merchantService.listKycDocuments(merchantContext(request)),
    );
  });

  app.post("/merchant/kyc-documents", async (request, reply) => {
    const parsed = createKycDocumentSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid KYC document", {
        errors: parsed.error.errors,
      });
    return sendCreated(
      reply,
      await merchantService.addKycDocument(
        merchantContext(request),
        parsed.data,
      ),
    );
  });

  app.get("/merchant/settlements", async (request, reply) => {
    const { page, pageSize } = parsePagination(
      request.query as Record<string, unknown>,
    );
    const result = await merchantService.listMerchantSettlements(
      merchantContext(request),
      page,
      pageSize,
    );
    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/merchant/balance", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const currency = String(query.currency ?? "USD").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency))
      throw new ValidationError("currency must be a three-letter code");
    return sendSuccess(
      reply,
      await merchantService.getMerchantBalance(
        merchantContext(request),
        currency,
      ),
    );
  });

  app.get("/merchant/statements", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = parsePagination(query);
    const currency = String(query.currency ?? "USD").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency))
      throw new ValidationError("currency must be a three-letter code");
    const result = await merchantService.listMerchantStatement(
      merchantContext(request),
      currency,
      page,
      pageSize,
    );
    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/merchant/invoices", async (request, reply) => {
    const { page, pageSize } = parsePagination(
      request.query as Record<string, unknown>,
    );
    const result = await merchantService.listInvoices(
      merchantContext(request),
      page,
      pageSize,
    );
    return sendPaginated(reply, result.data, result.meta);
  });

  app.post("/merchant/invoices", async (request, reply) => {
    const parsed = createMerchantInvoiceSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid invoice", {
        errors: parsed.error.errors,
      });
    return sendCreated(
      reply,
      await merchantService.createInvoice(merchantContext(request), {
        ...parsed.data,
        dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : undefined,
      }),
    );
  });

  app.get("/merchant/payment-links", async (request, reply) => {
    const { page, pageSize } = parsePagination(
      request.query as Record<string, unknown>,
    );
    const result = await merchantService.listPaymentLinks(
      merchantContext(request),
      page,
      pageSize,
    );
    return sendPaginated(reply, result.data, result.meta);
  });

  app.post("/merchant/payment-links", async (request, reply) => {
    const parsed = createPaymentLinkSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ValidationError("Invalid payment link", {
        errors: parsed.error.errors,
      });
    return sendCreated(
      reply,
      await merchantService.createPaymentLink(merchantContext(request), {
        ...parsed.data,
        expiresAt: parsed.data.expiresAt
          ? new Date(parsed.data.expiresAt)
          : undefined,
      }),
    );
  });

  // ── JWT portal routes (/merchant-portal/*) ─────────────────────
  // Used by merchant-portal.html. Authenticated with the dashboard JWT.

  app.get(
    "/merchant-portal/me",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      return sendSuccess(reply, {
        id: user.id,
        role: user.role,
        merchantId: user.merchantId,
        mustChangePassword: user.mustChangePassword,
      });
    },
  );

  app.get(
    "/merchant-portal/merchants",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      if (user.role === "MERCHANT") {
        if (!user.merchantId)
          throw new ForbiddenError("No merchant account is linked to this login");
        return sendSuccess(
          reply,
          [await merchantService.getPortalProfile(user.merchantId)],
        );
      }
      const { page, pageSize } = parsePagination(
        request.query as Record<string, unknown>,
      );
      const result = await merchantService.listMerchants({ page, pageSize });
      return sendPaginated(reply, result.data, result.meta);
    },
  );

  app.get(
    "/merchant-portal/merchants/:id",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id } = request.params as { id: string };
      assertMerchantScope(user, id);
      return sendSuccess(reply, await merchantService.getPortalProfile(id));
    },
  );

  app.get(
    "/merchant-portal/merchants/:id/transactions",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id } = request.params as { id: string };
      assertMerchantScope(user, id);
      const { page, pageSize } = parsePagination(
        request.query as Record<string, unknown>,
      );
      const result = await merchantService.listMerchantTransactions(
        id,
        page,
        pageSize,
      );
      return sendPaginated(reply, result.data, result.meta);
    },
  );

  app.get(
    "/merchant-portal/merchants/:id/terminals",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id } = request.params as { id: string };
      assertMerchantScope(user, id);
      return sendSuccess(
        reply,
        await merchantService.listMerchantTerminals(id),
      );
    },
  );

  app.post(
    "/merchant-portal/change-password",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      const body = request.body as {
        currentPassword?: string;
        newPassword?: string;
      };
      if (
        typeof body?.currentPassword !== "string" ||
        typeof body?.newPassword !== "string" ||
        body.newPassword.length < 12
      ) {
        throw new ValidationError(
          "A current password and a new password of at least 12 characters are required",
        );
      }
      await merchantService.changePortalPassword(
        user.id,
        body.currentPassword,
        body.newPassword,
        request.ip,
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : "unknown",
      );
      return sendSuccess(reply, { mustChangePassword: false });
    },
  );

  // ── Merchant bank accounts (commission payout) ─────────────────

  app.get(
    "/merchant-portal/merchants/:id/bank-accounts",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id } = request.params as { id: string };
      assertMerchantScope(user, id);
      return sendSuccess(
        reply,
        await merchantService.listMerchantBankAccounts(id),
      );
    },
  );

  app.post(
    "/merchant-portal/merchants/:id/bank-accounts",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id } = request.params as { id: string };
      assertMerchantScope(user, id);
      const parsed = createMerchantBankAccountSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid bank account details", {
          errors: parsed.error.errors,
        });
      }
      reply.header("cache-control", "no-store");
      return sendCreated(
        reply,
        await merchantService.createMerchantBankAccount(
          id,
          user.id,
          parsed.data,
          request.ip,
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : "unknown",
        ),
      );
    },
  );

  app.patch(
    "/merchant-portal/merchants/:id/bank-accounts/:accountId/default",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id, accountId } = request.params as {
        id: string;
        accountId: string;
      };
      assertMerchantScope(user, id);
      return sendSuccess(
        reply,
        await merchantService.setDefaultMerchantBankAccount(
          id,
          accountId,
          user.id,
          request.ip,
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : "unknown",
        ),
      );
    },
  );

  app.delete(
    "/merchant-portal/merchants/:id/bank-accounts/:accountId",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id, accountId } = request.params as {
        id: string;
        accountId: string;
      };
      assertMerchantScope(user, id);
      return sendSuccess(
        reply,
        await merchantService.deleteMerchantBankAccount(
          id,
          accountId,
          user.id,
          request.ip,
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : "unknown",
        ),
      );
    },
  );

  // ── Merchant pause / report / resume requests ──────────────────

  app.get(
    "/merchant-portal/merchants/:id/transaction-control-requests",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id } = request.params as { id: string };
      assertMerchantScope(user, id);
      const { page, pageSize } = parsePagination(
        request.query as Record<string, unknown>,
      );
      const result = await merchantService.listMerchantControlRequests(
        id,
        page,
        pageSize,
      );
      return sendPaginated(reply, result.data, result.meta);
    },
  );

  app.post(
    "/merchant-portal/merchants/:id/transactions/:transactionId/control-request",
    { preHandler: app.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = portalUser(request);
      assertPasswordChanged(user);
      const { id, transactionId } = request.params as {
        id: string;
        transactionId: string;
      };
      assertMerchantScope(user, id);
      const parsed = merchantTransactionControlRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        throw new ValidationError("A valid action and reason are required", {
          errors: parsed.error.errors,
        });
      }
      reply.header("cache-control", "no-store");
      return sendCreated(
        reply,
        await merchantService.requestMerchantTransactionControl(
          id,
          user.id,
          transactionId,
          parsed.data.action,
          parsed.data.reason,
          parsed.data.suspicious ?? false,
          request.ip,
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : "unknown",
        ),
      );
    },
  );
}
/**
 * Public merchant self-registration.
 * Base path: /public/merchant-registration
 *
 * Merchants complete KYC/AML, upload company documents and personal ID
 * verification themselves. Registrations that reference an agent code are only
 * accepted when that code matches a registered agent — a wrong agent number
 * cannot complete.
 */
export function registerMerchantPublicRoutes(
  app: FastifyInstance,
  registrationService: MerchantRegistrationService,
): void {
  app.post(
    "/public/merchant-registration/validate-agent",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = validateAgentCodeSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid agent code", {
          errors: parsed.error.errors,
        });
      }
      reply.header("Cache-Control", "no-store");
      return sendSuccess(
        reply,
        await registrationService.validateAgentCode(parsed.data.agentCode),
      );
    },
  );

  app.post(
    "/public/merchant-registration",
    {
      bodyLimit: 24 * 1024 * 1024,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = registerMerchantPublicSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid merchant registration", {
          errors: parsed.error.errors,
        });
      }
      reply.header("Cache-Control", "no-store");
      return sendCreated(reply, await registrationService.register(parsed.data));
    },
  );
}
