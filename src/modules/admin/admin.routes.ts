import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AdminService } from "./admin.service.js";
import { loginSchema, createUserSchema, updateUserSchema, updateKycSchema } from "./types.js";
import { sendSuccess, sendCreated, sendPaginated, parsePagination } from "../../shared/utils/response.js";
import { ForbiddenError, ValidationError } from "../../core/errors.js";

/**
 * Admin REST routes — JWT protected.
 *
 * Base path: /admin
 *
 * These routes are excluded from HMAC auth (handled in the auth plugin)
 * and require a valid JWT token in the Authorization header.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  adminService: AdminService,
): void {
  const assertSuperAdmin = (request: FastifyRequest) => {
    const role = (request.user as { role?: string } | undefined)?.role;
    if (!["SUPER_ADMIN", "ADMIN"].includes(role ?? "")) {
      throw new ForbiddenError("Only administrators can manage admin users");
    }
  };
  const assertKycReviewer = (request: FastifyRequest) => {
    const role = (request.user as { role?: string } | undefined)?.role;
    if (!role || !["SUPER_ADMIN", "ADMIN", "REVIEWER"].includes(role)) {
      throw new ForbiddenError("Your admin role cannot manage KYC");
    }
  };
  // ── Login (public, no auth required) ────────────
  app.post(
    "/admin/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid login data", { errors: parsed.error.errors });
      }

      const result = await adminService.login(
        parsed.data.email,
        parsed.data.password,
        reply as never,
        parsed.data.pin,
      );
      return sendSuccess(reply, result);
    },
  );

  // ── User Management (JWT required) ──────────────

  app.post("/admin/users", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertSuperAdmin(request);
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid user data", { errors: parsed.error.errors });
    }

    const user = request.user as { id: string };
    const created = await adminService.createUser(parsed.data, user.id);
    return sendCreated(reply, created);
  });

  app.get("/admin/users", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const query = request.query as Record<string, unknown>;

    const result = await adminService.listUsers({
      role: query.role as string | undefined,
      isActive: query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
      page,
      pageSize,
    });

    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/admin/users/:id", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const user = await adminService.getUser(id);
    return sendSuccess(reply, user);
  });

  app.patch("/admin/users/:id", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = updateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid update data", { errors: parsed.error.errors });
    }

    const authUser = request.user as { id: string };
    const updated = await adminService.updateUser(id, parsed.data, authUser.id);
    return sendSuccess(reply, updated);
  });

  app.delete("/admin/users/:id", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id: string };
    const authUser = request.user as { id: string };
    await adminService.deleteUser(id, authUser.id);
    return sendSuccess(reply, { id, deactivated: true });
  });

  // ── Staff access PIN (JWT required) ─────────────

  app.get("/admin/users/:id/pin", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id: string };
    reply.header("cache-control", "no-store");
    return sendSuccess(reply, await adminService.getUserPinStatus(id));
  });

  app.post("/admin/users/:id/pin", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id: string };
    const authUser = request.user as { id: string };
    reply.header("cache-control", "no-store");
    return sendCreated(reply, await adminService.setUserPin(id, authUser.id));
  });

  app.delete("/admin/users/:id/pin", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id: string };
    const authUser = request.user as { id: string };
    return sendSuccess(reply, await adminService.clearUserPin(id, authUser.id));
  });

  // ── Audit Logs (JWT required) ────────────────────

  app.get("/admin/audit-logs", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const query = request.query as Record<string, unknown>;

    const result = await adminService.listAuditLogs({
      userId: query.userId as string | undefined,
      merchantId: query.merchantId as string | undefined,
      action: query.action as string | undefined,
      page,
      pageSize,
    });

    return sendPaginated(reply, result.data, result.meta);
  });

  // ── KYC Management (JWT required) ────────────────

  app.get("/admin/kyc/pending", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertKycReviewer(request);
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const result = await adminService.listPendingKyc(page, pageSize);
    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/admin/kyc/:merchantId", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertKycReviewer(request);
    const { merchantId } = request.params as { merchantId: string };
    const kyc = await adminService.getKyc(merchantId);
    return sendSuccess(reply, kyc);
  });

  app.patch("/admin/kyc/:merchantId", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertKycReviewer(request);
    const { merchantId } = request.params as { merchantId: string };
    const parsed = updateKycSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid KYC data", { errors: parsed.error.errors });
    }

    const authUser = request.user as { id: string };
    const updated = await adminService.updateKyc(merchantId, parsed.data, authUser.id);
    return sendSuccess(reply, updated);
  });
}
