import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, randomUUID } from "crypto";
import { isIP } from "net";
import { Decimal } from "../../core/decimal.js";
import { prisma } from "../../core/database.js";
import { ForbiddenError, ValidationError, NotFoundError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { sendSuccess, sendCreated } from "../../shared/utils/response.js";

function ref(p: string): string {
  return p + "-" + Date.now().toString(36).toUpperCase() + randomUUID().replace(/-/g,"").slice(0,6).toUpperCase();
}

async function init(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "T2tIpWhitelist" (
      ip TEXT NOT NULL PRIMARY KEY,
      note TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  );
}

async function isAllowed(ip: string): Promise<boolean> {
  const rows: { cnt: string }[] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::text as cnt FROM "T2tIpWhitelist" WHERE ip = $1`,
    ip
  );
  return parseInt(rows[0].cnt, 10) > 0;
}

export function registerT2tRoutes(app: FastifyInstance): void {

  app.post("/t2t/whitelist", {
    preHandler: app.authenticate,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const role = (req.user as { role?: string } | undefined)?.role;
    if (!role || !["SUPER_ADMIN", "ADMIN"].includes(role)) {
      throw new ForbiddenError("Only administrators can manage T2T IP whitelists");
    }
    const b = req.body as { ip?: string; action?: string; note?: string };
    if (!b?.ip) throw new ValidationError("ip is required");
    if (!isIP(b.ip) || b.ip === "0.0.0.0" || b.ip === "::") {
      throw new ValidationError("A specific IPv4 or IPv6 address is required; wildcard addresses are forbidden");
    }
    await init();
    if (b.action === "remove") {
      await prisma.$executeRawUnsafe(`DELETE FROM "T2tIpWhitelist" WHERE ip = $1`, b.ip);
      return sendSuccess(reply, { ip: b.ip, action: "removed", message: "IP removed from whitelist" });
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "T2tIpWhitelist" (ip, note) VALUES ($1, $2) ON CONFLICT (ip) DO UPDATE SET note = $2`,
      b.ip, b.note || null
    );
    logger.info({ ip: b.ip }, "T2T IP whitelisted");
    return sendSuccess(reply, { ip: b.ip, action: "added", message: "IP whitelisted successfully" });
  });

  app.get("/t2t/whitelist", {
    preHandler: app.authenticate,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const role = (req.user as { role?: string } | undefined)?.role;
    if (!role || !["SUPER_ADMIN", "ADMIN", "OPERATOR"].includes(role)) {
      throw new ForbiddenError("Your role cannot view T2T IP whitelists");
    }
    await init();
    const rows: { ip: string; note: string | null; added_at: Date }[] =
      await prisma.$queryRawUnsafe(`SELECT ip, note, added_at FROM "T2tIpWhitelist" ORDER BY added_at DESC`);
    return sendSuccess(reply, { whitelistedIps: rows, count: rows.length });
  });

  app.post("/t2t/ping", async (req: FastifyRequest, reply: FastifyReply) => {
    await init();
    const b   = req.body as { terminalId?: string };
    const ip  = req.ip;
    const ok  = await isAllowed(ip);
    if (!ok) {
      return sendSuccess(reply, {
        reachable: false, whitelisted: false, callerIp: ip,
        message: `Your IP (${ip}) is not whitelisted. Ask the receiver to add it via POST /t2t/whitelist`,
      });
    }
    return sendSuccess(reply, {
      reachable: true, whitelisted: true, callerIp: ip,
      terminalId: b?.terminalId || null,
      serverTime: new Date().toISOString(),
      message: "Connected. Your IP is whitelisted. You can send T2T transfers.",
    });
  });

  app.post("/t2t/transfer", async (req: FastifyRequest, reply: FastifyReply) => {
    await init();
    const b = req.body as { amount?: string; currency?: string; sourceId?: string; destId?: string; description?: string };
    const ip = req.ip;
    const ok = await isAllowed(ip);
    if (!ok) throw new ForbiddenError(`IP ${ip} not whitelisted. Call POST /t2t/whitelist first.`);
    if (!b.amount || !b.currency || !b.sourceId || !b.destId) {
      throw new ValidationError("Required: amount, currency, sourceId, destId");
    }
    const amount = new Decimal(b.amount);
    if (!amount.isFinite() || amount.lte(0)) throw new ValidationError("amount must be positive");
    const cur = b.currency.toUpperCase();
    if (cur.length !== 3) throw new ValidationError("currency must be 3 letters (USD, EUR, INR...)");
    const srcTid = b.sourceId;
    const dstTid = b.destId;
    const idempotencyKey = String(req.headers["x-primestack-idempotency-key"] || "").trim();
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      throw new ValidationError("x-primestack-idempotency-key is required and must be 16-128 characters");
    }
    const reference = "TRF-" + createHash("sha256").update(`${req.merchant?.id || "unknown"}:${idempotencyKey}`).digest("hex").slice(0, 32).toUpperCase();
    const srcAcct = `TERMINAL-${srcTid}-${cur}`;
    const dstAcct = `TERMINAL-${dstTid}-${cur}`;
    const merchantId = req.merchant?.id;
    if (!merchantId) throw new ForbiddenError("Authenticated merchant context is required");
    const result = await prisma.$transaction(async (tx) => {
      const existing: { reference: string; amount: string; currency: string; sourceId: string; destId: string; journalEntryRef: string | null }[] =
        await tx.$queryRawUnsafe(
          `SELECT reference, amount::text, currency, "sourceId", "destId", "journalEntryRef"
           FROM "Transfer" WHERE reference = $1 LIMIT 1`,
          reference,
        );
      if (existing.length) {
        return { duplicate: true, transfer: existing[0] };
      }
      const terminals: { tid: string; merchantId: string; status: string }[] =
        await tx.$queryRawUnsafe(
          `SELECT tid, "merchantId", status::text FROM "Terminal"
           WHERE tid IN ($1, $2) FOR UPDATE`,
          srcTid,
          dstTid,
        );
      const sourceTerminal = terminals.find((terminal) => terminal.tid === srcTid);
      const destinationTerminal = terminals.find((terminal) => terminal.tid === dstTid);
      if (!sourceTerminal || sourceTerminal.merchantId !== merchantId) {
        throw new ForbiddenError("Source terminal does not belong to the authenticated merchant");
      }
      if (sourceTerminal.status !== "ACTIVE") {
        throw new ValidationError("Source terminal is not active");
      }
      if (!destinationTerminal || destinationTerminal.merchantId !== merchantId) {
        throw new ForbiddenError("Destination terminal does not belong to the authenticated merchant");
      }
      if (destinationTerminal.status !== "ACTIVE") {
        throw new ValidationError("Destination terminal is not active");
      }
      for (const code of [srcAcct, dstAcct]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "Account" (id, code, name, type, subtype, currency, balance, "heldBalance", status, "createdAt", "updatedAt")
           VALUES ($1,$2,$3,'ASSET','TERMINAL',$4,0,0,'ACTIVE',NOW(),NOW())
           ON CONFLICT (code) DO NOTHING`,
          randomUUID(), code, "Terminal " + code, cur
        );
      }
      const srcBal: { id: string; balance: string }[] =
        await tx.$queryRawUnsafe(
          `SELECT id, balance::text FROM "Account"
           WHERE code = $1 AND status = 'ACTIVE' FOR UPDATE`,
          srcAcct,
        );
      if (!srcBal.length || new Decimal(srcBal[0].balance).lt(amount)) {
        throw new ValidationError("Insufficient terminal funds");
      }
      const dstAccount: { id: string }[] =
        await tx.$queryRawUnsafe(
          `SELECT id FROM "Account"
           WHERE code = $1 AND status = 'ACTIVE' FOR UPDATE`,
          dstAcct,
        );
      if (!dstAccount.length) {
        throw new ValidationError("Destination terminal account is not active");
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
        JSON.stringify({ sourceTerminalId: srcTid, destinationTerminalId: dstTid, idempotencyKey }),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "JournalLine" (id, "entryId", "accountId", debit, credit, currency, "createdAt")
         VALUES ($1,$2,$3,0,$4,$5,NOW()), ($6,$2,$7,$4,0,$5,NOW())`,
        randomUUID(),
        entryId,
        srcBal[0].id,
        amount.toFixed(4),
        cur,
        randomUUID(),
        dstAccount[0].id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "Transfer" (id, reference, type, status, amount, currency, "feeAmount", "netAmount",
           "sourceType", "sourceId", "destType", "destId", "sourceAccountId", "destAccountId",
           "merchantId", description, metadata, "journalEntryRef", "initiatedAt", "processedAt", "completedAt", "createdAt", "updatedAt")
           VALUES ($1,$2,'T2T','COMPLETED',$3,$4,0,$3,'TERMINAL',$5,'TERMINAL',$6,$7,$8,$9,$10,$11::jsonb,$12,NOW(),NOW(),NOW(),NOW(),NOW())`,
        transferId, reference, amount.toFixed(4), cur, srcTid, dstTid, srcAcct, dstAcct,
        merchantId, b.description || "T2T transfer",
        JSON.stringify({ idempotencyKeyHash: createHash("sha256").update(idempotencyKey).digest("hex") }),
        jeRef,
      );
      const debitResult = await tx.$executeRawUnsafe(
        `UPDATE "Account" SET balance = balance - $1, "updatedAt" = NOW()
         WHERE id = $2 AND status = 'ACTIVE' AND balance - "heldBalance" >= $1`,
        amount.toFixed(4),
        srcBal[0].id,
      );
      if (debitResult !== 1) {
        throw new ValidationError("Insufficient terminal funds");
      }
      await tx.$executeRawUnsafe(
        `UPDATE "Account" SET balance = balance + $1, "updatedAt" = NOW()
         WHERE id = $2 AND status = 'ACTIVE'`,
        amount.toFixed(4),
        dstAccount[0].id,
      );
      const srcNew: { balance: string }[] = await tx.$queryRawUnsafe(`SELECT balance::text FROM "Account" WHERE code = $1`, srcAcct);
      const dstNew: { balance: string }[] = await tx.$queryRawUnsafe(`SELECT balance::text FROM "Account" WHERE code = $1`, dstAcct);
      return { duplicate: false, transfer: null, sourceBalance: srcNew[0]?.balance || "0", destBalance: dstNew[0]?.balance || "0", jeRef };
    });
    const completedAt = new Date().toISOString();
    if (result.duplicate) {
      return reply.status(200).send({ success: true, data: { reference, status: "COMPLETED", duplicate: true, ...result.transfer } });
    }
    logger.info({ reference, srcTid, dstTid, amount: amount.toString(), cur }, "T2T transfer completed atomically");
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
  });

  app.get("/t2t/balance/:tid", async (req: FastifyRequest, reply: FastifyReply) => {
    const { tid } = req.params as { tid: string };
    const merchantId = req.merchant?.id;
    if (!merchantId) throw new ForbiddenError("Authenticated merchant context is required");
    const terminals: { tid: string }[] = await prisma.$queryRawUnsafe(
      `SELECT tid FROM "Terminal" WHERE tid = $1 AND "merchantId" = $2 LIMIT 1`,
      tid,
      merchantId,
    );
    if (!terminals.length) throw new NotFoundError("Terminal not found");
    const rows: { balance: string; currency: string }[] = await prisma.$queryRawUnsafe(
      `SELECT balance::text, currency FROM "Account"
       WHERE strpos(code, $1) = 1
       ORDER BY "createdAt" DESC LIMIT 1`,
      `TERMINAL-${tid}-`,
    );
    if (!rows.length) return sendSuccess(reply, { terminalId: tid, balance: "0.00", currency: "USD", message: "No transactions yet" });
    return sendSuccess(reply, { terminalId: tid, balance: rows[0].balance, currency: rows[0].currency });
  });

  app.get("/t2t/terminals", async (req: FastifyRequest, reply: FastifyReply) => {
    const merchantId = req.merchant?.id;
    if (!merchantId) throw new ForbiddenError("Authenticated merchant context is required");
    const rows: { tid: string; model: string | null; location: string | null; country: string }[] =
      await prisma.$queryRawUnsafe(
        `SELECT tid, model, location, country FROM "Terminal"
         WHERE "merchantId" = $1 ORDER BY "createdAt" DESC`,
        merchantId,
      );
    return sendSuccess(reply, rows);
  });

  app.get("/t2t/transfers", async (req: FastifyRequest, reply: FastifyReply) => {
    const merchantId = req.merchant?.id;
    if (!merchantId) throw new ForbiddenError("Authenticated merchant context is required");
    const q = req.query as { tid?: string; limit?: string };
    const limit = Math.min(parseInt(q.limit || "20", 10), 100);
    const rows = q.tid
      ? await prisma.$queryRawUnsafe(
          `SELECT reference, type, status::text, amount::text, currency, "sourceId", "destId", "completedAt"
           FROM "Transfer"
           WHERE "merchantId" = $1 AND ("sourceId" = $2 OR "destId" = $2) AND type = 'T2T'
           ORDER BY "createdAt" DESC LIMIT $3`,
          merchantId,
          q.tid,
          limit,
        )
      : await prisma.$queryRawUnsafe(
          `SELECT reference, type, status::text, amount::text, currency, "sourceId", "destId", "completedAt"
           FROM "Transfer"
           WHERE "merchantId" = $1 AND type = 'T2T'
           ORDER BY "createdAt" DESC LIMIT $2`,
          merchantId,
          limit
        );
    return sendSuccess(reply, rows);
  });
}