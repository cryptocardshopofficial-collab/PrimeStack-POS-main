import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { createConnection, isIP } from "net";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { config } from "../../config/index.js";
import { Decimal } from "../../core/decimal.js";
import { prisma } from "../../core/database.js";
import {
  ConflictError,
  ForbiddenError,
  LedgerError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { redis } from "../../core/redis.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { ensureTerminalAccount } from "../terminal/terminal.service.js";
import { verifyWiseWebhookSignature } from "../wallet/wise-virtual-account.js";
import { sendSuccess, sendCreated } from "../../shared/utils/response.js";

const amountSchema = z
  .union([z.string(), z.number().finite()])
  .transform(String)
  .refine(
    (value) => /^\d+(?:\.\d{1,4})?$/.test(value),
    "amount must have no more than 4 decimal places",
  );

const currencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());

const t2tTransferSchema = z.object({
  amount: amountSchema,
  currency: currencySchema,
  sourceId: z.string().trim().min(1).max(128),
  destId: z.string().trim().min(1).max(128),
  description: z.string().max(500).optional(),
});

/** Manual credit of real funds received into a terminal account. */
const t2tInboundSchema = z
  .object({
    tid: z.string().trim().min(1).max(128),
    amount: amountSchema,
    currency: currencySchema,
    reference: z
      .string()
      .trim()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    note: z.string().max(500).optional(),
  })
  .strict();

/** Provider-agnostic inbound real-funds webhook payload. */
const inboundWebhookSchema = z
  .object({
    eventId: z.string().trim().min(8).max(128),
    amount: amountSchema,
    currency: currencySchema,
    target: z
      .object({
        type: z.enum(["TERMINAL", "MERCHANT"]),
        id: z.string().trim().min(1).max(128),
      })
      .strict(),
    payerName: z.string().trim().max(255).optional(),
    payerAccount: z.string().trim().max(128).optional(),
    payerReference: z.string().trim().max(128).optional(),
    receivedAt: z.string().datetime().optional(),
  })
  .strict();

const t2tWhitelistSchema = z.object({
  ip: z.string().trim().min(1).max(45),
  action: z.enum(["add", "remove"]).default("add"),
  note: z.string().trim().max(500).optional(),
  /**
   * Public HTTPS endpoint on the sender's own system. When set, pinging this
   * whitelisted IP also delivers a signed JSON notice there.
   */
  callbackUrl: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine(
      (value) => value.startsWith("https://"),
      "callbackUrl must be an https URL",
    )
    .optional(),
});

const T2T_PING_PORTS = [443, 80] as const;
const T2T_PING_TIMEOUT_MS = 3000;
const T2T_PING_MAX_TIMEOUT_MS = 5000;
const T2T_PING_MAX_TARGETS = 50;
const T2T_PING_CONCURRENCY = 5;

const t2tPingSchema = z
  .object({
    ip: z.string().trim().min(1).max(45).optional(),
    timeoutMs: z.coerce
      .number()
      .int()
      .min(500)
      .max(T2T_PING_MAX_TIMEOUT_MS)
      .default(T2T_PING_TIMEOUT_MS),
  })
  .strict();

const t2tSenderPingSchema = z
  .object({
    terminalId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

function normalizeIp(ip: string): string {
  const normalized = ip.trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

function getHeaderValue(
  headers: FastifyRequest["headers"],
  headerName: string,
): string | undefined {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const value = normalized[headerName.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function isPublicUnicastIp(ip: string): boolean {
  try {
    return (
      isIP(ip) !== 0 && ipaddr.process(normalizeIp(ip)).range() === "unicast"
    );
  } catch {
    return false;
  }
}

type T2tTransferRecord = {
  reference: string;
  status: string;
  amount: string;
  currency: string;
  sourceId: string;
  destId: string;
  journalEntryRef: string | null;
  completedAt: Date | null;
  metadata: Record<string, unknown> | null;
};

type T2tTransferResult =
  | { duplicate: true; transfer: T2tTransferRecord }
  | {
      duplicate: false;
      transfer: null;
      sourceBalance: string;
      destBalance: string;
      jeRef: string;
    };

async function isAllowed(
  ip: string,
  merchantId?: string | null,
): Promise<boolean> {
  // A merchant may be reached from an IP on the global (administrator) list or
  // on its own list. Without a merchant context only the global list applies.
  const rows: { allowed: boolean }[] = merchantId
    ? await prisma.$queryRaw<{ allowed: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "T2tIpWhitelist"
          WHERE ip = ${ip} AND (merchant_id IS NULL OR merchant_id = ${merchantId})
        ) AS allowed
      `
    : await prisma.$queryRaw<{ allowed: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "T2tIpWhitelist"
          WHERE ip = ${ip} AND merchant_id IS NULL
        ) AS allowed
      `;
  return rows[0]?.allowed === true;
}

type WhitelistScope =
  | { kind: "global"; merchantId: null }
  | { kind: "merchant"; merchantId: string };

const GLOBAL_WHITELIST_ROLES = ["SUPER_ADMIN", "ADMIN"];
const READ_WHITELIST_ROLES = ["SUPER_ADMIN", "ADMIN", "OPERATOR"];

// Resolves the whitelist the caller is allowed to manage. Administrators work on
// the shared global list; merchants work only on their own entries.
function writableWhitelistScope(
  user: { role?: string; merchantId?: string | null } | undefined,
): WhitelistScope {
  const role = user?.role;
  if (role && GLOBAL_WHITELIST_ROLES.includes(role)) {
    return { kind: "global", merchantId: null };
  }
  if (role === "MERCHANT") {
    if (!user?.merchantId) {
      throw new ForbiddenError(
        "Merchant context is required to manage T2T IP whitelists",
      );
    }
    return { kind: "merchant", merchantId: user.merchantId };
  }
  throw new ForbiddenError(
    "Only administrators or merchants can manage T2T IP whitelists",
  );
}

// Read/ping scope: administrators and operators see the global list, merchants
// see their own.
function readableWhitelistScope(
  user: { role?: string; merchantId?: string | null } | undefined,
): WhitelistScope {
  const role = user?.role;
  if (role && READ_WHITELIST_ROLES.includes(role)) {
    return { kind: "global", merchantId: null };
  }
  if (role === "MERCHANT") {
    if (!user?.merchantId) {
      throw new ForbiddenError(
        "Merchant context is required to view T2T IP whitelists",
      );
    }
    return { kind: "merchant", merchantId: user.merchantId };
  }
  throw new ForbiddenError("Your role cannot view T2T IP whitelists");
}

type PingResult = {
  ip: string;
  note: string | null;
  callbackUrl: string | null;
  reachable: boolean;
  port: number | null;
  latencyMs: number | null;
  error: string | null;
  /** Whether the signed notice was accepted by the sender's callback URL. */
  notified: boolean;
  notifyStatus: number | null;
  notifyError: string | null;
};

type PingTarget = {
  ip: string;
  note: string | null;
  callback_url: string | null;
};

const SAFE_SOCKET_ERRORS = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNRESET",
  "EADDRNOTAVAIL",
]);

// A TCP connect checks whether a sender endpoint accepts connections; this is
// not an ICMP ping and does not verify its application or payment service.
function tcpProbe(
  ip: string,
  port: number,
  timeoutMs: number,
): Promise<{
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let socket: ReturnType<typeof createConnection>;
    let settled = false;

    try {
      socket = createConnection({ host: ip, port, family: isIP(ip) });
    } catch {
      resolve({ reachable: false, latencyMs: null, error: "CONNECT_FAILED" });
      return;
    }

    const finish = (reachable: boolean, error: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - startedAt, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "CONNECT_FAILED";
      finish(false, SAFE_SOCKET_ERRORS.has(code) ? code : "CONNECT_FAILED");
    });
    socket.once("close", () => {
      if (!settled) finish(false, "CONNECTION_CLOSED");
    });
  });
}

/**
 * Delivers a signed JSON notice to the sender's callback URL so the sender's
 * own system learns that its egress IP was allowlisted and probed. The body is
 * signed exactly like the inbound webhook (timestamp + raw JSON) so the sender
 * can verify it with the shared secret.
 */
async function notifySender(
  callbackUrl: string,
  payload: Record<string, unknown>,
): Promise<{ notified: boolean; status: number | null; error: string | null }> {
  const secret = config.t2tNotify.secret;
  if (!secret) {
    return {
      notified: false,
      status: null,
      error: "NOTIFY_SECRET_NOT_CONFIGURED",
    };
  }

  const body = JSON.stringify(payload);
  const timestamp = Date.now();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}${body}`)
    .digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.t2tNotify.timeoutMs);
  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [`${config.hmac.headerPrefix}-timestamp`]: String(timestamp),
        [`${config.hmac.headerPrefix}-signature`]: signature,
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    return {
      notified: response.ok,
      status: response.status,
      error: response.ok ? null : `HTTP_${response.status}`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      notified: false,
      status: null,
      error: aborted ? "ETIMEDOUT" : "NOTIFY_FAILED",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pingSenderIp(
  target: PingTarget,
  timeoutMs: number,
): Promise<PingResult> {
  const normalizedIp = normalizeIp(target.ip);
  const callbackUrl = target.callback_url ?? null;
  const base = {
    ip: normalizedIp,
    note: target.note,
    callbackUrl,
  };

  let reachable = false;
  let port: number | null = null;
  let latencyMs: number | null = null;
  let error: string | null = "UNREACHABLE";

  if (!isPublicUnicastIp(normalizedIp)) {
    error = "IP_NOT_PUBLIC_UNICAST";
  } else {
    for (const candidate of T2T_PING_PORTS) {
      const probe = await tcpProbe(normalizedIp, candidate, timeoutMs);
      latencyMs = probe.latencyMs;
      if (probe.reachable) {
        reachable = true;
        port = candidate;
        error = null;
        break;
      }
      error = probe.error;
    }
  }

  // Tell the sender's own system about the outcome. A failed delivery never
  // invalidates the probe result; it is reported alongside it.
  let notified = false;
  let notifyStatus: number | null = null;
  let notifyError: string | null = null;
  if (callbackUrl) {
    const delivery = await notifySender(callbackUrl, {
      event: "t2t.whitelist.ping",
      ip: normalizedIp,
      reachable,
      port,
      latencyMs,
      error,
      checkedAt: new Date().toISOString(),
    });
    notified = delivery.notified;
    notifyStatus = delivery.status;
    notifyError = delivery.error;
  } else {
    notifyError = "NO_CALLBACK_URL";
  }

  return {
    ...base,
    reachable,
    port,
    latencyMs,
    error,
    notified,
    notifyStatus,
    notifyError,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const INBOUND_MAX_AMOUNT = "10000000";

/**
 * External money is booked against an ASSET funding account because the ledger
 * engine only allows ASSET debits to exceed the account's balance — nothing in
 * the ledger backs funds that arrived from outside yet.
 */
async function ensureFundingAccount(currency: string): Promise<string> {
  const code = `${config.inboundWebhook.fundingAccountPrefix}-${currency}`;
  const existing = await prisma.account.findUnique({
    where: { code },
    select: { code: true },
  });
  if (existing) return existing.code;

  try {
    await prisma.account.create({
      data: {
        code,
        name: `System funding (${currency})`,
        type: "ASSET",
        subtype: "FUNDING",
        currency,
      },
    });
  } catch (error) {
    const created = await prisma.account.findUnique({
      where: { code },
      select: { code: true },
    });
    if (!created) throw error;
    return created.code;
  }

  return code;
}

async function readAccountBalance(code: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ balance: string }[]>(
    `SELECT balance::text AS balance FROM "Account" WHERE code = $1 LIMIT 1`,
    code,
  );
  return rows[0]?.balance ?? null;
}

/**
 * Deterministic journal reference derived from the receipt's own identity, so a
 * replayed call can never credit the same funds twice.
 */
function inboundJournalReference(scope: string): string {
  return `INB-${createHash("sha256").update(scope).digest("hex").slice(0, 32).toUpperCase()}`;
}

type InboundReceipt = {
  duplicate: boolean;
  amount: string;
  journalEntryRef: string;
  balance: string | null;
};

/** Credits real funds into a receiving account, debiting the funding account. */
async function creditInboundFunds(input: {
  accountCode: string;
  amount: string;
  currency: string;
  journalReference: string;
  description: string;
  postedBy: string;
  metadata: Record<string, unknown>;
}): Promise<InboundReceipt> {
  const amount = new Decimal(input.amount);
  if (!amount.isFinite() || amount.lte(0)) {
    throw new ValidationError("amount must be positive");
  }
  if (amount.gt(INBOUND_MAX_AMOUNT)) {
    throw new ValidationError("amount exceeds the maximum inbound limit");
  }
  const normalizedAmount = amount.toFixed(4);

  const duplicate = await prisma.journalEntry.findUnique({
    where: { reference: input.journalReference },
    select: { reference: true },
  });
  if (duplicate) {
    return {
      duplicate: true,
      amount: normalizedAmount,
      journalEntryRef: duplicate.reference,
      balance: await readAccountBalance(input.accountCode),
    };
  }

  const targetAccount = await prisma.account.findUnique({
    where: { code: input.accountCode },
    select: { code: true },
  });
  if (!targetAccount) {
    throw new NotFoundError("Receiving account", input.accountCode);
  }

  const fundingAccount = await ensureFundingAccount(input.currency);
  try {
    await ledgerService.postEntry({
      reference: input.journalReference,
      entryType: "TRANSFER",
      description: input.description,
      source: "INBOUND",
      postedBy: input.postedBy,
      metadata: input.metadata,
      lines: [
        { accountCode: fundingAccount, debit: normalizedAmount, credit: "0" },
        { accountCode: input.accountCode, debit: "0", credit: normalizedAmount },
      ],
    });
  } catch (error) {
    // A concurrent retry may have posted this reference first.
    if (error instanceof LedgerError && error.message.includes("already exists")) {
      return {
        duplicate: true,
        amount: normalizedAmount,
        journalEntryRef: input.journalReference,
        balance: await readAccountBalance(input.accountCode),
      };
    }
    throw error;
  }

  return {
    duplicate: false,
    amount: normalizedAmount,
    journalEntryRef: input.journalReference,
    balance: await readAccountBalance(input.accountCode),
  };
}

export function registerT2tRoutes(app: FastifyInstance): void {
  app.post(
    "/t2t/whitelist",
    {
      preHandler: app.authenticate,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user as
        { id?: string; role?: string; merchantId?: string | null } | undefined;
      const userId = user?.id;
      if (!userId) {
        throw new ForbiddenError(
          "Only administrators or merchants can manage T2T IP whitelists",
        );
      }
      const scope = writableWhitelistScope(user);
      const parsedBody = t2tWhitelistSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new ValidationError("Invalid T2T IP whitelist data", {
          errors: parsedBody.error.errors,
        });
      }
      const b = parsedBody.data;
      const ip = normalizeIp(b.ip);
      if (!isIP(ip) || ip === "0.0.0.0" || ip === "::") {
        throw new ValidationError(
          "A specific IPv4 or IPv6 address is required; wildcard addresses are forbidden",
        );
      }
      await prisma.$transaction(async (tx) => {
        // Idempotent add/remove: clear the caller's own row for this IP first so
        // the unique (merchant_id, ip) pair is never violated.
        await tx.$executeRaw`
          DELETE FROM "T2tIpWhitelist"
          WHERE ip = ${ip} AND merchant_id IS NOT DISTINCT FROM ${scope.merchantId}`;
        if (b.action !== "remove") {
          await tx.$executeRaw`
          INSERT INTO "T2tIpWhitelist" (id, ip, note, callback_url, merchant_id)
          VALUES (${randomUUID()}, ${ip}, ${b.note || null}, ${b.callbackUrl ?? null}, ${scope.merchantId})`;
        }
        await tx.auditLog.create({
          data: {
            userId,
            merchantId: scope.merchantId ?? undefined,
            action:
              b.action === "remove"
                ? "T2T_IP_WHITELIST_REMOVED"
                : "T2T_IP_WHITELIST_ADDED",
            entity: "T2tIpWhitelist",
            entityId: ip,
            ipAddress: req.ip,
            after: {
              ip,
              note: b.action === "add" ? (b.note ?? null) : null,
              callbackUrl: b.action === "add" ? (b.callbackUrl ?? null) : null,
              merchantId: scope.merchantId,
            },
          },
        });
      });
      logger.info(
        { ip, action: b.action, userId, scope: scope.kind },
        "T2T IP whitelist updated",
      );
      return sendSuccess(reply, {
        ip,
        scope: scope.kind,
        action: b.action === "remove" ? "removed" : "added",
        callbackUrl: b.action === "remove" ? null : (b.callbackUrl ?? null),
        message:
          b.action === "remove"
            ? "IP removed from whitelist"
            : "IP whitelisted successfully",
      });
    },
  );

  app.get(
    "/t2t/whitelist",
    {
      preHandler: app.authenticate,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Administrators/operators read the global list; merchants read their own.
      const scope = readableWhitelistScope(
        req.user as { role?: string; merchantId?: string | null } | undefined,
      );
      const rows: {
        ip: string;
        note: string | null;
        callback_url: string | null;
        merchant_id: string | null;
        added_at: Date;
      }[] = await prisma.$queryRawUnsafe(
        `SELECT ip, note, callback_url, merchant_id, added_at FROM "T2tIpWhitelist"
         WHERE merchant_id IS NOT DISTINCT FROM $1::text
         ORDER BY added_at DESC`,
        scope.merchantId,
      );
      return sendSuccess(reply, {
        whitelistedIps: rows,
        scope: scope.kind,
        count: rows.length,
      });
    },
  );

  // Ping one sender IP or every whitelisted sender to confirm reachability.
  app.post(
    "/t2t/whitelist/ping",
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const scope = readableWhitelistScope(
        req.user as { role?: string; merchantId?: string | null } | undefined,
      );
      const parsed = t2tPingSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError("Invalid ping request", {
          errors: parsed.error.errors,
        });
      }
      const { timeoutMs } = parsed.data;

      let targets: PingTarget[];
      if (parsed.data.ip) {
        const ip = normalizeIp(parsed.data.ip);
        if (!isPublicUnicastIp(ip)) {
          throw new ValidationError(
            "Only public unicast IP addresses can be pinged",
          );
        }
        targets = await prisma.$queryRaw<PingTarget[]>`
          SELECT ip, note, callback_url FROM "T2tIpWhitelist"
          WHERE ip = ${ip}
            AND merchant_id IS NOT DISTINCT FROM ${scope.merchantId}::text
          LIMIT 1
        `;
        if (!targets.length) throw new NotFoundError("Sender IP", ip);
      } else {
        targets = await prisma.$queryRaw<PingTarget[]>`
          SELECT ip, note, callback_url FROM "T2tIpWhitelist"
          WHERE merchant_id IS NOT DISTINCT FROM ${scope.merchantId}::text
          ORDER BY added_at DESC
          LIMIT ${T2T_PING_MAX_TARGETS + 1}
        `;
        if (targets.length > T2T_PING_MAX_TARGETS) {
          throw new ValidationError(
            `Too many IPs to ping. Maximum allowed is ${T2T_PING_MAX_TARGETS}.`,
          );
        }
      }

      const results = await mapWithConcurrency(
        targets,
        T2T_PING_CONCURRENCY,
        (target) => pingSenderIp(target, timeoutMs),
      );

      const reachable = results.filter((r) => r.reachable);
      const notified = results.filter((r) => r.notified);
      const withCallback = results.filter((r) => r.callbackUrl !== null);
      const latencies = reachable
        .map((r) => r.latencyMs)
        .filter((ms): ms is number => ms !== null);
      const avgLatencyMs = latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null;

      logger.info(
        {
          count: results.length,
          reachable: reachable.length,
          withCallback: withCallback.length,
          notified: notified.length,
          ports: T2T_PING_PORTS,
          scope: scope.kind,
        },
        "T2T whitelist ping completed",
      );

      return sendSuccess(reply, {
        results,
        summary: {
          total: results.length,
          reachable: reachable.length,
          unreachable: results.length - reachable.length,
          notified: notified.length,
          callbacksConfigured: withCallback.length,
          avgLatencyMs,
          ports: [...T2T_PING_PORTS],
          portsChecked: [...T2T_PING_PORTS],
        },
      });
    },
  );

  app.post(
    "/t2t/ping",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = t2tSenderPingSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError("Invalid ping request", {
          errors: parsed.error.errors,
        });
      }

      const callerIp = normalizeIp(req.ip);
      if (!isIP(callerIp)) {
        throw new ValidationError("Unable to determine a valid caller IP");
      }

      const allowed = await isAllowed(callerIp, req.merchant?.id);
      if (!allowed) {
        return sendSuccess(reply, {
          reachable: false,
          whitelisted: false,
          callerIp,
          message:
            "Your IP is not whitelisted. Ask the receiver to add it before sending transfers.",
        });
      }
      return sendSuccess(reply, {
        reachable: true,
        whitelisted: true,
        callerIp,
        terminalId: parsed.data.terminalId ?? null,
        serverTime: new Date().toISOString(),
        message: "Connection check successful. Your IP is whitelisted.",
      });
    },
  );

  app.post(
    "/t2t/transfer",
    {
      config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsedBody = t2tTransferSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new ValidationError("Invalid T2T transfer data", {
          errors: parsedBody.error.errors,
        });
      }
      const b = parsedBody.data;
      const ip = normalizeIp(req.ip);
      const userAgent =
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : undefined;
      const ok = await isAllowed(ip, req.merchant?.id);
      if (!ok)
        throw new ForbiddenError(
          `IP ${ip} not whitelisted. Call POST /t2t/whitelist first.`,
        );
      const amount = new Decimal(b.amount);
      if (!amount.isFinite() || amount.lte(0))
        throw new ValidationError("amount must be positive");
      const normalizedAmount = amount.toFixed(4);
      if (amount.gt("10000000"))
        throw new ValidationError("amount exceeds the maximum transfer limit");
      const cur = b.currency;
      const srcTid = b.sourceId;
      const dstTid = b.destId;
      if (srcTid === dstTid) {
        throw new ValidationError(
          "sourceId and destId must identify different terminals",
        );
      }
      const idempotencyHeader = req.headers["x-primestack-idempotency-key"];
      const idempotencyKey =
        typeof idempotencyHeader === "string" ? idempotencyHeader.trim() : "";
      if (
        idempotencyKey.length < 16 ||
        idempotencyKey.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
      ) {
        throw new ValidationError(
          "x-primestack-idempotency-key must be 16-128 URL-safe characters",
        );
      }
      const reference =
        "TRF-" +
        createHash("sha256")
          .update(`${req.merchant?.id || "unknown"}:${idempotencyKey}`)
          .digest("hex")
          .slice(0, 32)
          .toUpperCase();
      const srcAcct = `TERMINAL-${srcTid}-${cur}`;
      const dstAcct = `TERMINAL-${dstTid}-${cur}`;
      const merchantId = req.merchant?.id;
      if (!merchantId)
        throw new ForbiddenError("Authenticated merchant context is required");
      const nonceHeader = req.headers["x-primestack-nonce"];
      const keyIdHeader = req.headers["x-primestack-key-id"];
      const nonce = typeof nonceHeader === "string" ? nonceHeader : "";
      const keyId = typeof keyIdHeader === "string" ? keyIdHeader : "";
      if (!nonce || !keyId)
        throw new ValidationError("x-primestack nonce and key ID are required");
      const nonceRedisKey = `t2t:hmac-nonce:${keyId}:${nonce}`;
      const nonceReserved = await redis.set(
        nonceRedisKey,
        "1",
        "EX",
        600,
        "NX",
      );
      if (!nonceReserved)
        throw new ConflictError("Nonce has already been used");

      const requestFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            merchantId,
            amount: normalizedAmount,
            currency: cur,
            sourceId: srcTid,
            destId: dstTid,
          }),
        )
        .digest("hex");

      let result: T2tTransferResult;
      try {
        result = await prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(
            `WITH transfer_lock AS MATERIALIZED (
             SELECT pg_advisory_xact_lock(hashtext($1))
           )
           SELECT TRUE AS acquired FROM transfer_lock`,
            reference,
          );
          const existing: T2tTransferRecord[] = await tx.$queryRawUnsafe(
            `SELECT reference, status::text, amount::text, currency, "sourceId", "destId", "journalEntryRef", "completedAt", metadata
           FROM "Transfer" WHERE reference = $1 LIMIT 1`,
            reference,
          );
          if (existing.length) {
            const previous = existing[0];
            const storedFingerprint = previous.metadata?.requestFingerprint;
            const matchesLegacyRecord =
              storedFingerprint === undefined &&
              previous.amount === normalizedAmount &&
              previous.currency === cur &&
              previous.sourceId === srcTid &&
              previous.destId === dstTid;
            if (
              storedFingerprint !== requestFingerprint &&
              !matchesLegacyRecord
            ) {
              throw new ConflictError(
                "Idempotency key was already used with different transfer parameters",
              );
            }
            return { duplicate: true, transfer: previous };
          }
          const terminals: {
            tid: string;
            merchantId: string;
            status: string;
          }[] = await tx.$queryRawUnsafe(
            `SELECT tid, "merchantId", status::text FROM "Terminal"
           WHERE tid IN ($1, $2) ORDER BY tid FOR UPDATE`,
            srcTid,
            dstTid,
          );
          const sourceTerminal = terminals.find(
            (terminal) => terminal.tid === srcTid,
          );
          const destinationTerminal = terminals.find(
            (terminal) => terminal.tid === dstTid,
          );
          if (!sourceTerminal || sourceTerminal.merchantId !== merchantId) {
            throw new ForbiddenError(
              "Source terminal does not belong to the authenticated merchant",
            );
          }
          if (sourceTerminal.status !== "ACTIVE") {
            throw new ValidationError("Source terminal is not active");
          }
          if (
            !destinationTerminal ||
            destinationTerminal.merchantId !== merchantId
          ) {
            throw new ForbiddenError(
              "Destination terminal does not belong to the authenticated merchant",
            );
          }
          if (destinationTerminal.status !== "ACTIVE") {
            throw new ValidationError("Destination terminal is not active");
          }
          const accounts: {
            id: string;
            code: string;
            balance: string;
            heldBalance: string;
            currency: string;
            status: string;
          }[] = await tx.$queryRawUnsafe(
            `SELECT id, code, balance::text, "heldBalance"::text, currency, status::text
         FROM "Account" WHERE code IN ($1, $2) ORDER BY code FOR UPDATE`,
            srcAcct,
            dstAcct,
          );
          const sourceAccount = accounts.find(
            (account) => account.code === srcAcct,
          );
          const destinationAccount = accounts.find(
            (account) => account.code === dstAcct,
          );
          if (
            !sourceAccount ||
            sourceAccount.status !== "ACTIVE" ||
            sourceAccount.currency !== cur
          ) {
            throw new ValidationError(
              "Source terminal is not enabled for this currency",
            );
          }
          if (
            !destinationAccount ||
            destinationAccount.status !== "ACTIVE" ||
            destinationAccount.currency !== cur
          ) {
            throw new ValidationError(
              "Destination terminal is not enabled for this currency",
            );
          }
          const availableBalance = new Decimal(sourceAccount.balance).minus(
            sourceAccount.heldBalance,
          );
          if (availableBalance.lt(amount)) {
            throw new ValidationError("Insufficient terminal funds");
          }

          const transferId = randomUUID();
          const jeRef = "JE-" + reference;
          const entryId = randomUUID();
          await tx.$executeRawUnsafe(
            `INSERT INTO "JournalEntry" (id, reference, "entryType", description, source, status, "postedAt", "postedBy", metadata, "createdAt", "updatedAt")
         VALUES ($1,$2,'TRANSFER',$3,'T2T','POSTED',NOW(),$4,$5::jsonb,NOW(),NOW())`,
            entryId,
            jeRef,
            `T2T transfer from ${srcTid} to ${dstTid}`,
            merchantId,
            JSON.stringify({
              sourceTerminalId: srcTid,
              destinationTerminalId: dstTid,
              idempotencyKeyHash: createHash("sha256")
                .update(idempotencyKey)
                .digest("hex"),
            }),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "JournalLine" (id, "entryId", "accountId", debit, credit, currency, "createdAt")
         VALUES ($1,$2,$3,0,$4,$5,NOW()), ($6,$2,$7,$4,0,$5,NOW())`,
            randomUUID(),
            entryId,
            sourceAccount.id,
            amount.toFixed(4),
            cur,
            randomUUID(),
            destinationAccount.id,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "Transfer" (id, reference, type, status, amount, currency, "feeAmount", "netAmount",
           "sourceType", "sourceId", "destType", "destId", "sourceAccountId", "destAccountId",
           "merchantId", description, metadata, "journalEntryRef", "initiatedAt", "processedAt", "completedAt", "createdAt", "updatedAt")
           VALUES ($1,$2,'T2T','COMPLETED',$3,$4,0,$3,'TERMINAL',$5,'TERMINAL',$6,$7,$8,$9,$10,$11::jsonb,$12,NOW(),NOW(),NOW(),NOW(),NOW())`,
            transferId,
            reference,
            amount.toFixed(4),
            cur,
            srcTid,
            dstTid,
            sourceAccount.id,
            destinationAccount.id,
            merchantId,
            b.description || "T2T transfer",
            JSON.stringify({
              idempotencyKeyHash: createHash("sha256")
                .update(idempotencyKey)
                .digest("hex"),
              requestFingerprint,
            }),
            jeRef,
          );
          const debitResult = await tx.$executeRawUnsafe(
            `UPDATE "Account" SET balance = balance - $1, "updatedAt" = NOW()
         WHERE id = $2 AND status = 'ACTIVE' AND balance - "heldBalance" >= $1`,
            amount.toFixed(4),
            sourceAccount.id,
          );
          if (debitResult !== 1) {
            throw new ValidationError("Insufficient terminal funds");
          }
          const creditResult = await tx.$executeRawUnsafe(
            `UPDATE "Account" SET balance = balance + $1, "updatedAt" = NOW()
         WHERE id = $2 AND status = 'ACTIVE'`,
            amount.toFixed(4),
            destinationAccount.id,
          );
          if (creditResult !== 1) {
            throw new ValidationError(
              "Destination terminal account is not active",
            );
          }
          const srcNew: { balance: string }[] = await tx.$queryRawUnsafe(
            `SELECT balance::text FROM "Account" WHERE code = $1`,
            srcAcct,
          );
          const dstNew: { balance: string }[] = await tx.$queryRawUnsafe(
            `SELECT balance::text FROM "Account" WHERE code = $1`,
            dstAcct,
          );
          await tx.auditLog.create({
            data: {
              merchantId,
              action: "T2T_TRANSFER_COMPLETED",
              entity: "Transfer",
              entityId: transferId,
              ipAddress: ip,
              userAgent,
              after: {
                reference,
                amount: normalizedAmount,
                currency: cur,
                sourceId: srcTid,
                destId: dstTid,
                idempotencyKeyHash: createHash("sha256")
                  .update(idempotencyKey)
                  .digest("hex"),
              },
            },
          });
          return {
            duplicate: false,
            transfer: null,
            sourceBalance: srcNew[0]?.balance || "0",
            destBalance: dstNew[0]?.balance || "0",
            jeRef,
          };
        });
      } catch (error) {
        try {
          await redis.del(nonceRedisKey);
        } catch (releaseError) {
          logger.warn(
            { err: releaseError, reference },
            "Failed to release T2T nonce reservation",
          );
        }
        try {
          await prisma.auditLog.create({
            data: {
              merchantId,
              action: "T2T_TRANSFER_FAILED",
              entity: "Transfer",
              entityId: reference,
              ipAddress: ip,
              userAgent,
              before: {
                amount: normalizedAmount,
                currency: cur,
                sourceId: srcTid,
                destId: dstTid,
              },
              after: {
                errorType: error instanceof Error ? error.name : "UnknownError",
              },
            },
          });
        } catch (auditError) {
          logger.error(
            { err: auditError, reference },
            "Failed to write T2T failure audit log",
          );
        }
        logger.error(
          { err: error, reference, merchantId },
          "T2T transfer failed",
        );
        throw error;
      }
      const completedAt = new Date().toISOString();
      if (result.duplicate) {
        return reply.status(200).send({
          success: true,
          data: {
            reference: result.transfer.reference,
            status: result.transfer.status,
            duplicate: true,
            amount: result.transfer.amount,
            currency: result.transfer.currency,
            sourceId: result.transfer.sourceId,
            destId: result.transfer.destId,
            journalEntryRef: result.transfer.journalEntryRef,
            completedAt: result.transfer.completedAt,
          },
        });
      }
      logger.info(
        {
          reference,
          merchantId,
          srcTid,
          dstTid,
          amount: normalizedAmount,
          cur,
        },
        "T2T transfer completed atomically",
      );
      return sendCreated(reply, {
        reference,
        type: "T2T",
        status: "COMPLETED",
        amount: amount.toString(),
        currency: cur,
        sourceType: "TERMINAL",
        sourceId: srcTid,
        destType: "TERMINAL",
        destId: dstTid,
        journalEntryRef: result.jeRef,
        sourceBalance: result.sourceBalance,
        destBalance: result.destBalance,
        completedAt,
        message: `Transfer of ${amount.toString()} ${cur} from ${srcTid} to ${dstTid} completed`,
      });
    },
  );

  app.get(
    "/t2t/balance/:tid",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tid } = req.params as { tid: string };
      const parsedQuery = z
        .object({
          currency: z
            .string()
            .regex(/^[A-Za-z]{3}$/)
            .transform((value) => value.toUpperCase())
            .default("USD"),
        })
        .safeParse(req.query);
      if (!parsedQuery.success) {
        throw new ValidationError("Invalid balance query", {
          errors: parsedQuery.error.errors,
        });
      }
      const merchantId = req.merchant?.id;
      if (!merchantId)
        throw new ForbiddenError("Authenticated merchant context is required");
      const terminals: { tid: string }[] = await prisma.$queryRawUnsafe(
        `SELECT tid FROM "Terminal" WHERE tid = $1 AND "merchantId" = $2 LIMIT 1`,
        tid,
        merchantId,
      );
      if (!terminals.length) throw new NotFoundError("Terminal not found");
      const currency = parsedQuery.data.currency;
      const rows: { balance: string; currency: string }[] =
        await prisma.$queryRawUnsafe(
          `SELECT balance::text, currency FROM "Account"
       WHERE code = $1 AND currency = $2 AND status = 'ACTIVE' LIMIT 1`,
          `TERMINAL-${tid}-${currency}`,
          currency,
        );
      if (!rows.length)
        throw new NotFoundError(
          "Terminal currency account",
          `${tid}/${currency}`,
        );
      return sendSuccess(reply, {
        terminalId: tid,
        balance: rows[0].balance,
        currency: rows[0].currency,
      });
    },
  );

  app.get(
    "/t2t/terminals",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const merchantId = req.merchant?.id;
      if (!merchantId)
        throw new ForbiddenError("Authenticated merchant context is required");
      const rows: {
        tid: string;
        model: string | null;
        location: string | null;
        country: string;
      }[] = await prisma.$queryRawUnsafe(
        `SELECT tid, model, location, country FROM "Terminal"
         WHERE "merchantId" = $1 ORDER BY "createdAt" DESC`,
        merchantId,
      );
      return sendSuccess(reply, rows);
    },
  );

  app.get(
    "/t2t/transfers",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const merchantId = req.merchant?.id;
      if (!merchantId)
        throw new ForbiddenError("Authenticated merchant context is required");
      const parsedQuery = z
        .object({
          tid: z.string().trim().min(1).max(128).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .safeParse(req.query);
      if (!parsedQuery.success) {
        throw new ValidationError("Invalid transfer query", {
          errors: parsedQuery.error.errors,
        });
      }
      const { tid, limit } = parsedQuery.data;
      const rows = tid
        ? await prisma.$queryRawUnsafe(
            `SELECT reference, type, status::text, amount::text, currency, "sourceId", "destId", "completedAt"
           FROM "Transfer"
           WHERE "merchantId" = $1 AND ("sourceId" = $2 OR "destId" = $2) AND type = 'T2T'
           ORDER BY "createdAt" DESC LIMIT $3`,
            merchantId,
            tid,
            limit,
          )
        : await prisma.$queryRawUnsafe(
            `SELECT reference, type, status::text, amount::text, currency, "sourceId", "destId", "completedAt"
           FROM "Transfer"
           WHERE "merchantId" = $1 AND type = 'T2T'
           ORDER BY "createdAt" DESC LIMIT $2`,
            merchantId,
            limit,
          );
      return sendSuccess(reply, rows);
    },
  );

  // Manual credit for real funds that arrived outside the platform (bank or VPA
  // settlement) and must now sit in a terminal's receiving account.
  app.post(
    "/t2t/inbound",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user as { id?: string; role?: string } | undefined;
      if (!user?.id || !user.role || !GLOBAL_WHITELIST_ROLES.includes(user.role)) {
        throw new ForbiddenError("Only administrators can credit terminal funds");
      }
      const parsedBody = t2tInboundSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new ValidationError("Invalid inbound funds data", {
          errors: parsedBody.error.errors,
        });
      }
      const b = parsedBody.data;
      const terminals = await prisma.$queryRawUnsafe<
        { tid: string; merchantId: string }[]
      >(
        `SELECT tid, "merchantId" FROM "Terminal" WHERE tid = $1 LIMIT 1`,
        b.tid,
      );
      const terminal = terminals[0];
      if (!terminal) throw new NotFoundError("Terminal", b.tid);

      const accountCode = await ensureTerminalAccount(
        prisma,
        terminal.tid,
        b.currency,
      );
      const receipt = await creditInboundFunds({
        accountCode,
        amount: b.amount,
        currency: b.currency,
        journalReference: inboundJournalReference(
          `t2t:${terminal.tid}:${b.currency}:${b.reference}`,
        ),
        description: `Inbound funds to terminal ${terminal.tid}`,
        postedBy: user.id,
        metadata: {
          terminalId: terminal.tid,
          merchantId: terminal.merchantId,
          reference: b.reference,
          note: b.note ?? null,
        },
      });

      if (receipt.duplicate) {
        logger.info(
          { terminalId: terminal.tid, reference: b.reference },
          "Inbound funds already credited to terminal",
        );
        return sendSuccess(reply, {
          terminalId: terminal.tid,
          accountCode,
          amount: receipt.amount,
          currency: b.currency,
          balance: receipt.balance,
          journalEntryRef: receipt.journalEntryRef,
          reference: b.reference,
          duplicate: true,
        });
      }

      await prisma.auditLog.create({
        data: {
          userId: user.id,
          merchantId: terminal.merchantId,
          action: "T2T_INBOUND_FUNDS_RECEIVED",
          entity: "Account",
          entityId: accountCode,
          ipAddress: req.ip,
          after: {
            terminalId: terminal.tid,
            amount: receipt.amount,
            currency: b.currency,
            reference: b.reference,
            journalEntryRef: receipt.journalEntryRef,
          },
        },
      });

      logger.info(
        {
          terminalId: terminal.tid,
          amount: receipt.amount,
          currency: b.currency,
          reference: b.reference,
          userId: user.id,
        },
        "Inbound funds credited to terminal",
      );

      return sendCreated(reply, {
        terminalId: terminal.tid,
        accountCode,
        amount: receipt.amount,
        currency: b.currency,
        balance: receipt.balance,
        journalEntryRef: receipt.journalEntryRef,
        reference: b.reference,
        duplicate: false,
        message: `Credited ${receipt.amount} ${b.currency} to terminal ${terminal.tid}`,
      });
    },
  );

  // Provider-agnostic webhook for real external funds. Senders sign
  // `${timestamp}${JSON.stringify(body)}` with the shared inbound secret, so the
  // route is excluded from the platform HMAC plugin (see plugins/auth.ts).
  app.post(
    "/webhooks/inbound",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const secret = config.inboundWebhook.secret;
      if (!secret) {
        throw new UnauthorizedError("Inbound webhook is not configured");
      }

      const prefix = config.hmac.headerPrefix.toLowerCase();
      const timestampHeader = getHeaderValue(req.headers, `${prefix}-timestamp`);
      const signatureHeader = getHeaderValue(req.headers, `${prefix}-signature`);
      if (
        typeof timestampHeader !== "string" ||
        typeof signatureHeader !== "string" ||
        !/^\d{13}$/.test(timestampHeader)
      ) {
        throw new UnauthorizedError("Missing or malformed inbound webhook signature");
      }
      const drift = Date.now() - Number(timestampHeader);
      const maxDrift = config.inboundWebhook.maxTimestampDriftMs;
      if (drift > maxDrift || drift < -maxDrift) {
        throw new UnauthorizedError("Inbound webhook timestamp expired");
      }

      const expected = createHmac(config.hmac.algorithm, secret)
        .update(`${timestampHeader}${JSON.stringify(req.body ?? {})}`)
        .digest("hex");
      const expectedBuffer = Buffer.from(expected, "hex");
      const providedBuffer = Buffer.from(signatureHeader.trim(), "hex");
      if (
        providedBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(providedBuffer, expectedBuffer)
      ) {
        logger.warn({ ip: req.ip }, "Inbound webhook signature mismatch");
        throw new UnauthorizedError("Invalid inbound webhook signature");
      }

      const parsedBody = inboundWebhookSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new ValidationError("Invalid inbound webhook payload", {
          errors: parsedBody.error.errors,
        });
      }
      const b = parsedBody.data;

      let accountCode: string;
      let merchantId: string | null = null;
      if (b.target.type === "TERMINAL") {
        const terminals = await prisma.$queryRawUnsafe<
          { tid: string; merchantId: string }[]
        >(
          `SELECT tid, "merchantId" FROM "Terminal" WHERE tid = $1 LIMIT 1`,
          b.target.id,
        );
        if (!terminals[0]) throw new NotFoundError("Terminal", b.target.id);
        merchantId = terminals[0].merchantId;
        accountCode = await ensureTerminalAccount(prisma, terminals[0].tid, b.currency);
      } else {
        const merchants = await prisma.$queryRawUnsafe<
          { id: string; code: string }[]
        >(
          `SELECT id, code FROM "Merchant" WHERE code = $1 LIMIT 1`,
          b.target.id,
        );
        if (!merchants[0]) throw new NotFoundError("Merchant", b.target.id);
        merchantId = merchants[0].id;
        accountCode = `MERCHANT-${merchants[0].code}-${b.currency}`;
      }

      const receipt = await creditInboundFunds({
        accountCode,
        amount: b.amount,
        currency: b.currency,
        journalReference: inboundJournalReference(`webhook:${b.eventId}`),
        description: `Inbound ${b.currency} funds from ${b.payerName ?? "external sender"}`,
        postedBy: "inbound-webhook",
        metadata: {
          eventId: b.eventId,
          targetType: b.target.type,
          targetId: b.target.id,
          payerName: b.payerName ?? null,
          payerAccount: b.payerAccount ?? null,
          payerReference: b.payerReference ?? null,
          receivedAt: b.receivedAt ?? null,
        },
      });

      if (receipt.duplicate) {
        logger.info(
          { eventId: b.eventId, accountCode },
          "Inbound webhook replay ignored",
        );
      } else {
        await prisma.auditLog.create({
          data: {
            merchantId: merchantId ?? undefined,
            action: "INBOUND_FUNDS_RECEIVED",
            entity: "Account",
            entityId: accountCode,
            ipAddress: req.ip,
            after: {
              eventId: b.eventId,
              targetType: b.target.type,
              targetId: b.target.id,
              amount: receipt.amount,
              currency: b.currency,
              payerName: b.payerName ?? null,
              payerReference: b.payerReference ?? null,
              journalEntryRef: receipt.journalEntryRef,
            },
          },
        });
        logger.info(
          {
            eventId: b.eventId,
            accountCode,
            amount: receipt.amount,
            currency: b.currency,
          },
          "Inbound webhook credited real funds",
        );
      }

      const payload = {
        eventId: b.eventId,
        targetType: b.target.type,
        targetId: b.target.id,
        accountCode,
        amount: receipt.amount,
        currency: b.currency,
        balance: receipt.balance,
        journalEntryRef: receipt.journalEntryRef,
        duplicate: receipt.duplicate,
      };
      return receipt.duplicate
        ? sendSuccess(reply, payload)
        : sendCreated(reply, payload);
    },
  );

  // Wise webhook — real funds arriving on a provisioned Wise receiving account.
  // Wise signs the raw request body with RSA-SHA256 (`X-Signature-SHA256`), so
  // this scope installs a raw-body JSON parser and the path is excluded from the
  // platform HMAC plugin (see plugins/auth.ts).
  app.register(async (wiseScope) => {
    wiseScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (request, body, done) => {
        (request as FastifyRequest & { rawBody?: Buffer }).rawBody =
          body as Buffer;
        try {
          done(null, JSON.parse((body as Buffer).toString("utf8")));
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );

    wiseScope.post(
      "/wise/webhook",
      { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
        const signature = getHeaderValue(req.headers, "x-signature-sha256");
        if (
          !rawBody ||
          typeof signature !== "string" ||
          !verifyWiseWebhookSignature(rawBody, signature)
        ) {
          logger.warn({ ip: req.ip }, "Wise webhook signature mismatch");
          throw new UnauthorizedError("Invalid Wise webhook signature");
        }

        const event = (req.body ?? {}) as Record<string, unknown>;
        const eventType =
          typeof event.event_type === "string" ? event.event_type : "";
        const deliveryId = getHeaderValue(req.headers, "x-delivery-id");
        const isTest =
          getHeaderValue(req.headers, "x-test-notification") === "true";
        const data = (event.data ?? {}) as Record<string, unknown>;
        const transactionType =
          typeof data.transaction_type === "string"
            ? data.transaction_type.toLowerCase()
            : "";

        // Only balance credits move money. Everything else is acknowledged so
        // Wise stops retrying the delivery.
        if (
          isTest ||
          eventType !== "balances#update" ||
          transactionType !== "credit"
        ) {
          logger.info(
            { eventType, transactionType, isTest },
            "Wise webhook acknowledged without a credit",
          );
          return sendSuccess(reply, {
            received: true,
            eventType,
            processed: false,
          });
        }

        const currency =
          typeof data.currency === "string" ? data.currency.toUpperCase() : "";
        const balanceId =
          data.balance_id === undefined || data.balance_id === null
            ? ""
            : String(data.balance_id);
        const amount =
          data.amount === undefined || data.amount === null
            ? ""
            : String(data.amount);
        if (!currency || !balanceId || !amount) {
          throw new ValidationError(
            "Wise balance credit is missing currency, balance id, or amount",
          );
        }

        const virtualAccount = await prisma.virtualAccount.findFirst({
          where: { provider: "WISE", externalId: balanceId },
          include: { wallet: { select: { walletAddress: true, merchantId: true } } },
        });
        if (!virtualAccount) {
          logger.warn(
            { balanceId, currency },
            "Wise balance credit for an unknown virtual account",
          );
          return sendSuccess(reply, {
            received: true,
            processed: false,
            reason: "unknown_virtual_account",
          });
        }
        if (virtualAccount.currency !== currency) {
          logger.warn(
            { balanceId, currency, expected: virtualAccount.currency },
            "Wise balance credit currency mismatch",
          );
          throw new ValidationError(
            "Wise balance credit currency does not match the virtual account",
          );
        }

        const accountCode = `WALLET-${virtualAccount.wallet.walletAddress}-${currency}`;
        const idempotencyScope =
          typeof deliveryId === "string"
            ? `wise:${deliveryId}`
            : `wise:${String(event.subscription_id ?? "")}:${balanceId}:${amount}`;

        const receipt = await creditInboundFunds({
          accountCode,
          amount,
          currency,
          journalReference: inboundJournalReference(idempotencyScope),
          description: `Wise ${currency} credit (${String(
            data.transfer_reference ?? deliveryId ?? balanceId,
          )})`,
          postedBy: "wise-webhook",
          metadata: {
            provider: "WISE",
            deliveryId: typeof deliveryId === "string" ? deliveryId : null,
            subscriptionId: event.subscription_id ?? null,
            balanceId,
            transactionType,
            transferReference: data.transfer_reference ?? null,
            channelName: data.channel_name ?? null,
            occurredAt: data.occurred_at ?? null,
            postTransactionBalance:
              data.post_transaction_balance_amount ?? null,
          },
        });

        if (receipt.duplicate) {
          logger.info(
            { balanceId, accountCode },
            "Wise balance credit replay ignored",
          );
        } else {
          await prisma.auditLog.create({
            data: {
              action: "INBOUND_FUNDS_RECEIVED",
              entity: "Account",
              entityId: accountCode,
              ipAddress: req.ip,
              after: {
                provider: "WISE",
                virtualAccountId: virtualAccount.id,
                balanceId,
                amount: receipt.amount,
                currency,
                journalEntryRef: receipt.journalEntryRef,
              },
            },
          });
          logger.info(
            { balanceId, accountCode, amount: receipt.amount, currency },
            "Wise balance credit recorded",
          );
        }

        // Reconcile with a merchant XML upload: a PENDING SUPE upload that quotes
        // this transfer reference is promoted to CREDITED once the real funds
        // land. Best-effort — a failure here never blocks the credit response.
        const transferReference =
          typeof data.transfer_reference === "string"
            ? data.transfer_reference.trim()
            : "";
        if (!receipt.duplicate && transferReference) {
          try {
            const reconciled = await prisma.inboundPayment.updateMany({
              where: {
                endToEndId: transferReference,
                status: { in: ["PENDING", "CONFIRMED"] },
                ...(virtualAccount.wallet.merchantId
                  ? { merchantId: virtualAccount.wallet.merchantId }
                  : {}),
              },
              data: {
                status: "CREDITED",
                journalEntryRef: receipt.journalEntryRef,
                creditedAt: new Date(),
                confirmedAt: new Date(),
              },
            });
            if (reconciled.count > 0) {
              logger.info(
                { transferReference, count: reconciled.count },
                "Wise credit reconciled a pending SUPE upload",
              );
            }
          } catch (error) {
            logger.warn(
              { err: error, transferReference },
              "Wise credit: SUPE upload reconciliation failed",
            );
          }
        }

        return sendSuccess(reply, {
          received: true,
          processed: true,
          duplicate: receipt.duplicate,
          accountCode,
          amount: receipt.amount,
          currency,
          balance: receipt.balance,
          journalEntryRef: receipt.journalEntryRef,
        });
      },
    );
  });
}
