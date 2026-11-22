import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../../config/index.js";
import { ForbiddenError, ValidationError } from "../../core/errors.js";
import { sendCreated, sendSuccess } from "../../shared/utils/response.js";
import { logger } from "../../core/logger.js";
import {
  ensureWiseWebhookSubscription,
  listWiseWebhookSubscriptions,
  wiseWebhookPublicKey,
} from "../wallet/wise-virtual-account.js";
import { handleWiseBalanceWebhook } from "../wallet/wise-webhook.handler.js";
import type { WalletService } from "../wallet/wallet.service.js";

const VIRTUAL_ACCOUNT_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

function assertVirtualAccountAdmin(request: FastifyRequest): { id: string } {
  const user = request.user as { id?: string; role?: string } | undefined;
  if (!user?.id || !user.role || !VIRTUAL_ACCOUNT_ROLES.has(user.role)) {
    throw new ForbiddenError("Your admin role cannot manage virtual accounts");
  }
  return { id: user.id };
}

function auditUserAgent(request: FastifyRequest): string | undefined {
  const userAgent = request.headers["user-agent"];
  return typeof userAgent === "string" ? userAgent : undefined;
}

export function registerAdminVirtualAccountRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  walletService: WalletService,
): void {
  app.get("/admin/virtual-account/configuration", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertVirtualAccountAdmin(request);
    reply.header("Cache-Control", "no-store");
    return sendSuccess(reply, {
      provider: "WISE",
      enabled: config.wise.enabled,
      provisioningEnabled: config.wise.provisioningEnabled,
      environment: config.wise.environment,
      configured: Boolean(config.wise.apiKey && config.wise.profileId && wiseWebhookPublicKey()),
      profileIdConfigured: Boolean(config.wise.profileId),
      apiKeyConfigured: Boolean(config.wise.apiKey),
      webhookPublicKeyConfigured: Boolean(wiseWebhookPublicKey()),
      webhookUrl: config.wise.webhookUrl || null,
      webhookUrlConfigured: Boolean(config.wise.webhookUrl),
    });
  });

  app.get("/admin/wallets/:address/virtual-accounts", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertVirtualAccountAdmin(request);
    reply.header("Cache-Control", "no-store");
    const { address } = request.params as { address: string };
    return sendSuccess(reply, await walletService.listVirtualAccounts(address));
  });

  app.post("/admin/wallets/:address/virtual-accounts", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = assertVirtualAccountAdmin(request);
    reply.header("Cache-Control", "no-store");
    if (!config.wise.provisioningEnabled || !config.wise.apiKey || !config.wise.profileId) {
      throw new ForbiddenError("Wise virtual-account provisioning is not enabled or fully configured");
    }
    const schema = z.object({
      currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("currency must be a three-letter code");
    }
    const { address } = request.params as { address: string };
    const account = await prisma.$transaction(async (transaction) => {
      const created = await walletService.createVirtualAccount(address, parsed.data.currency);
      await transaction.auditLog.create({
        data: {
          userId: actor.id,
          action: "CREATE_VIRTUAL_ACCOUNT",
          entity: "VirtualAccount",
          entityId: created.id,
          after: { walletAddress: address, currency: created.currency, accountNumber: created.accountNumber },
          ipAddress: request.ip,
          userAgent: auditUserAgent(request),
        },
      });
      return created;
    });
    return sendCreated(reply, account);
  });

  // Wise only delivers `balances#update` events once a subscription points at
  // this platform's /wise/webhook URL. Without one, inbound balance credits are
  // never delivered, so no real funds reach the ledger.
  app.get("/admin/wise/webhook-subscriptions", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertVirtualAccountAdmin(request);
    reply.header("Cache-Control", "no-store");
    if (!config.wise.provisioningEnabled || !config.wise.apiKey || !config.wise.profileId) {
      throw new ForbiddenError("Wise provisioning is not enabled or fully configured");
    }
    return sendSuccess(reply, {
      webhookUrl: config.wise.webhookUrl || null,
      subscriptions: await listWiseWebhookSubscriptions(),
    });
  });

  app.post("/admin/wise/webhook-subscriptions", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = assertVirtualAccountAdmin(request);
    reply.header("Cache-Control", "no-store");
    if (!config.wise.provisioningEnabled || !config.wise.apiKey || !config.wise.profileId) {
      throw new ForbiddenError("Wise provisioning is not enabled or fully configured");
    }
    const result = await ensureWiseWebhookSubscription();
    if (result.created) {
      await prisma.auditLog.create({
        data: {
          userId: actor.id,
          action: "CREATE_WISE_WEBHOOK_SUBSCRIPTION",
          entity: "WiseWebhookSubscription",
          entityId: result.subscription.id ?? config.wise.webhookUrl,
          after: {
            triggerOn: result.subscription.triggerOn,
            url: result.subscription.url,
            version: result.subscription.version,
          },
          ipAddress: request.ip,
          userAgent: auditUserAgent(request),
        },
      });
    }
    return result.created
      ? sendCreated(reply, result)
      : sendSuccess(reply, result);
  });

  // ── Wise inbound balance webhook (public — Wise signs with RSA-SHA256) ──
  // This is the URL you register at Wise. It receives every balances#update
  // event, verifies the RSA-SHA256 signature, and credits the matching
  // merchant wallet (or platform reserve) via the SUPE ledger flow.
  //
  // Registration URL: POST /admin/wise/webhook-subscriptions
  // The URL itself:   POST /wise/webhook   (must be in WISE_WEBHOOK_URL env)
  app.post("/wise/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody
      ?? Buffer.from(typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}));

    const signature = request.headers["x-signature-sha256"] as string | undefined;

    try {
      const result = await handleWiseBalanceWebhook(prisma, rawBody, signature, request.ip);
      // Always return 200 to Wise — any non-2xx causes retries.
      reply.status(200);
      return sendSuccess(reply, result);
    } catch (err) {
      // Signature failure or parse error → 400 (Wise will not retry 4xx).
      logger.warn({ err: err instanceof Error ? err.message : String(err), ip: request.ip }, "Wise webhook rejected");
      return reply.status(400).send({
        success: false,
        error: {
          code: err instanceof ValidationError ? "VALIDATION_ERROR" : "WEBHOOK_ERROR",
          message: err instanceof Error ? err.message : "Webhook processing failed",
        },
      });
    }
  });

  // ── Wise webhook status (admin) ──────────────────────────────────────
  // Shows the endpoint URL, subscription state, and env configuration so
  // an operator can confirm the feed is wired up correctly.
  app.get("/admin/wise/webhook-status", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertVirtualAccountAdmin(request);
    reply.header("Cache-Control", "no-store");
    const webhookUrl = config.wise.webhookUrl || null;
    const sigKeyConfigured = Boolean(wiseWebhookPublicKey());
    let subscriptions: Awaited<ReturnType<typeof listWiseWebhookSubscriptions>> = [];
    let subscriptionError: string | null = null;
    if (config.wise.provisioningEnabled && config.wise.apiKey && config.wise.profileId) {
      try { subscriptions = await listWiseWebhookSubscriptions(); }
      catch (e) { subscriptionError = e instanceof Error ? e.message : "unknown error"; }
    }
    const active = subscriptions.some((s) => s.triggerOn === "balances#update" && s.url === webhookUrl);
    return sendSuccess(reply, {
      webhookEndpoint: webhookUrl,
      webhookEndpointConfigured: Boolean(webhookUrl),
      signatureKeyConfigured: sigKeyConfigured,
      environment: config.wise.environment,
      subscriptionActive: active,
      subscriptions,
      subscriptionError,
      instructions: active
        ? "Wise will deliver balances#update events to your endpoint. Credits will post automatically."
        : "Run POST /admin/wise/webhook-subscriptions to register the subscription with Wise.",
    });
  });
}
