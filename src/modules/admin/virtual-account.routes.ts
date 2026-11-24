import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../../config/index.js";
import { ForbiddenError, ValidationError } from "../../core/errors.js";
import { sendCreated, sendSuccess } from "../../shared/utils/response.js";

import {
  ensureWiseWebhookSubscription,
  getWiseBalance,
  listWiseWebhookSubscriptions,
  wiseWebhookPublicKey,
} from "../wallet/wise-virtual-account.js";
import { executeWisePayout } from "../wallet/wise-outbound.js";

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

/**
 * Body for an outbound Wise payout. USD only. A `routingNumber` selects a US
 * (ACH) recipient; a `swiftCode` selects an international (SWIFT) one.
 */
const wisePayoutSchema = z.object({
  amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
  currency: z.literal("USD").default("USD"),
  reference: z.string().max(64).optional(),
  description: z.string().max(500).optional(),
  recipient: z.object({
    accountHolderName: z.string().trim().min(1).max(140),
    routingNumber: z.string().trim().regex(/^\d{9}$/).optional(),
    accountNumber: z.string().trim().min(4).max(34).optional(),
    swiftCode: z.string().trim().min(8).max(11).optional(),
    iban: z.string().trim().min(4).max(34).optional(),
    accountType: z.enum(["CHECKING", "SAVINGS"]).optional(),
    country: z.string().trim().length(2),
    address: z.object({
      firstLine: z.string().trim().min(1).max(140),
      city: z.string().trim().min(1).max(70),
      state: z.string().trim().max(35).optional(),
      postCode: z.string().trim().min(1).max(20),
      country: z.string().trim().length(2),
    }),
  }),
});

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


  // ΓöÇΓöÇ Wise webhook status (admin) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
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

  // ── Wise live balances (admin) ─────────────────────────────────────────────
  // Shows what the profile actually holds at Wise — the funds an outbound
  // payout can draw from.
  app.get("/admin/wise/balances", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertVirtualAccountAdmin(request);
    reply.header("Cache-Control", "no-store");
    if (!config.wise.provisioningEnabled || !config.wise.apiKey || !config.wise.profileId) {
      throw new ForbiddenError("Wise provisioning is not enabled or fully configured");
    }
    return sendSuccess(reply, {
      environment: config.wise.environment,
      profileId: config.wise.profileId,
      usd: await getWiseBalance("USD"),
    });
  });

  // ── Wise outbound payout (admin) ───────────────────────────────────────────
  // Sends USD from the profile's Wise balance to an external bank account, and
  // records the outflow in the ledger (fail-closed).
  app.post("/admin/wise/payouts", {
    preHandler: app.authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = assertVirtualAccountAdmin(request);
    reply.header("Cache-Control", "no-store");
    if (!config.wise.provisioningEnabled || !config.wise.apiKey || !config.wise.profileId) {
      throw new ForbiddenError("Wise provisioning is not enabled or fully configured");
    }
    const parsed = wisePayoutSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid Wise payout request", {
        errors: parsed.error.errors,
      });
    }

    const result = await executeWisePayout({
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      reference: parsed.data.reference,
      description: parsed.data.description,
      recipient: parsed.data.recipient,
      postedBy: actor.id,
    });

    await prisma.auditLog.create({
      data: {
        userId: actor.id,
        action: "WISE_PAYOUT_SENT",
        entity: "WisePayout",
        entityId: result.reference,
        after: {
          amount: result.amount,
          currency: result.currency,
          wiseRecipientId: result.wiseRecipientId,
          wiseTransferId: result.wiseTransferId,
          journalEntryRef: result.journalEntryRef,
          beneficiary: parsed.data.recipient.accountHolderName,
        },
        ipAddress: request.ip,
        userAgent: auditUserAgent(request),
      },
    });

    return sendCreated(reply, result);
  });
}

