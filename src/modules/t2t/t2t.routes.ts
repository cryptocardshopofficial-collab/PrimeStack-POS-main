import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, randomUUID } from "crypto";
import { createConnection, isIP } from "net";
import { z } from "zod";
import { Decimal } from "../../core/decimal.js";
import { prisma } from "../../core/database.js";
import {
  ConflictError,
  ForbiddenError,
  ValidationError,
  NotFoundError,
} from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { redis } from "../../core/redis.js";
import { sendSuccess, sendCreated } from "../../shared/utils/response.js";

const t2tTransferSchema = z.object({
  amount: z
    .union([z.string(), z.number().finite()])
    .transform(String)
    .refine(
      (value) => /^\d+(?:\.\d{1,4})?$/.test(value),
      "amount must have no more than 4 decimal places",
    ),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase()),
  sourceId: z.string().trim().min(1).max(128),
  destId: z.string().trim().min(1).max(128),
  description: z.string().max(500).optional(),
});

const t2tWhitelistSchema = z.object({
  ip: z.string().trim().min(1).max(45),
  action: z.enum(["add", "remove"]).default("add"),
  note: z.string().trim().max(500).optional(),
});

const t2tPingSchema = z.object({
  ip: z.string().trim().min(1).max(45).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  timeoutMs: z.coerce.number().int().min(100).max(10000).default(3000),
});

function normalizeIp(ip: string): string {
  const normalized = ip.trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
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
    ? await prisma.$queryRawUnsafe(
        `SELECT EXISTS (
           SELECT 1 FROM "T2tIpWhitelist"
           WHERE ip = $1 AND (merchant_id IS NULL OR merchant_id = $2)
         ) AS allowed`,
        ip,
        merchantId,
      )
    : await prisma.$queryRawUnsafe(
        `SELECT EXISTS (
           SELECT 1 FROM "T2tIpWhitelist"
           WHERE ip = $1 AND merchant_id IS NULL
         ) AS allowed`,
        ip,
      );
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
      throw new ForbiddenError("Merchant context is required to manage T2T IP whitelists");
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
      throw new ForbiddenError("Merchant context is required to view T2T IP whitelists");
    }
    return { kind: "merchant", merchantId: user.merchantId };
  }
  throw new ForbiddenError("Your role cannot view T2T IP whitelists");
}

type PingResult = {
  ip: string;
  note: string | null;
  reachable: boolean;
  port: number | null;
  latencyMs: number | null;
  error: string | null;
};

// TCP ping: opens a socket to the sender's IP and measures how long the
// handshake takes. ICMP is not usable without raw-socket privileges, so a TCP
// connect is the reliable way to prove a sender endpoint is reachable.
function tcpProbe(
  ip: string,
  port: number,
  timeoutMs: number,
): Promise<{ reachable: boolean; latencyMs: number; error: string | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = createConnection({ host: ip, port });
    let settled = false;
    const finish = (reachable: boolean, error: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      finish(false, err.code || err.message),
    );
  });
}

async function pingSenderIp(
  ip: string,
  ports: number[],
  timeoutMs: number,
): Promise<Omit<PingResult, "note">> {
  if (!isIP(ip)) {
    return {
      ip,
      reachable: false,
      port: null,
      latencyMs: null,
      error: "invalid_ip",
    };
  }
  let last: { latencyMs: number; error: string | null } = {
    latencyMs: 0,
    error: "unreachable",
  };
  for (const port of ports) {
    const probe = await tcpProbe(ip, port, timeoutMs);
    if (probe.reachable) {
      return {
        ip,
        reachable: true,
        port,
        latencyMs: probe.latencyMs,
        error: null,
      };
    }
    last = probe;
  }
  return {
    ip,
    reachable: false,
    port: ports[ports.length - 1] ?? null,
    latencyMs: last.latencyMs,
    error: last.error,
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
        | { id?: string; role?: string; merchantId?: string | null }
        | undefined;
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
          INSERT INTO "T2tIpWhitelist" (id, ip, note, merchant_id)
          VALUES (${randomUUID()}, ${ip}, ${b.note || null}, ${scope.merchantId})`;
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
        merchant_id: string | null;
        added_at: Date;
      }[] = await prisma.$queryRawUnsafe(
        `SELECT ip, note, merchant_id, added_at FROM "T2tIpWhitelist"
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
      const ports = parsed.data.port ? [parsed.data.port] : [443, 80];

      let targets: { ip: string; note: string | null }[];
      if (parsed.data.ip) {
        const ip = normalizeIp(parsed.data.ip);
        targets = await prisma.$queryRawUnsafe(
          `SELECT ip, note FROM "T2tIpWhitelist"
           WHERE ip = $1 AND merchant_id IS NOT DISTINCT FROM $2::text LIMIT 1`,
          ip,
          scope.merchantId,
        );
        if (!targets.length) throw new NotFoundError("Sender IP", ip);
      } else {
        targets = await prisma.$queryRawUnsafe(
          `SELECT ip, note FROM "T2tIpWhitelist"
           WHERE merchant_id IS NOT DISTINCT FROM $1::text
           ORDER BY added_at DESC`,
          scope.merchantId,
        );
      }

      const results: PingResult[] = await Promise.all(
        targets.map(async (target) => ({
          ...(await pingSenderIp(target.ip, ports, timeoutMs)),
          note: target.note,
        })),
      );

      const reachable = results.filter((r) => r.reachable);
      const latencies = reachable
        .map((r) => r.latencyMs)
        .filter((ms): ms is number => typeof ms === "number");
      const avgLatencyMs = latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null;

      logger.info(
        { count: results.length, reachable: reachable.length, ports },
        "T2T sender IP ping",
      );

      return sendSuccess(reply, {
        results,
        summary: {
          total: results.length,
          reachable: reachable.length,
          unreachable: results.length - reachable.length,
          avgLatencyMs,
          ports,
        },
      });
    },
  );

  app.post("/t2t/ping", async (req: FastifyRequest, reply: FastifyReply) => {
    const b = req.body as { terminalId?: string };
    const ip = normalizeIp(req.ip);
    const ok = await isAllowed(ip, req.merchant?.id);
    if (!ok) {
      return sendSuccess(reply, {
        reachable: false,
        whitelisted: false,
        callerIp: ip,
        message: `Your IP (${ip}) is not whitelisted. Ask the receiver to add it via POST /t2t/whitelist`,
      });
    }
    return sendSuccess(reply, {
      reachable: true,
      whitelisted: true,
      callerIp: ip,
      terminalId: b?.terminalId || null,
      serverTime: new Date().toISOString(),
      message: "Connected. Your IP is whitelisted. You can send T2T transfers.",
    });
  });

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
}
