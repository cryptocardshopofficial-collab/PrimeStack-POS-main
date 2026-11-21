import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "crypto";
import { prisma } from "../../core/database.js";
import { Decimal } from "../../core/decimal.js";
import { ValidationError, ConflictError, NotFoundError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { sendSuccess, sendCreated } from "../../shared/utils/response.js";

const SUPE_MAX_AMOUNT = "50000000";
const SUPE_FUNDING_PREFIX = "SYSTEM-FUNDING";

async function ensureSupeFundingAccount(currency: string): Promise<string> {
  const code = `${SUPE_FUNDING_PREFIX}-${currency}`;
  const existing = await prisma.account.findUnique({ where: { code }, select: { code: true } });
  if (existing) return existing.code;
  await prisma.account.create({
    data: { code, name: `System funding (${currency})`, type: "ASSET", subtype: "FUNDING", currency }
  });
  return code;
}

type SupeUser = { id?: string; role?: string; merchantId?: string } | undefined;
type SupeBody = {
  format?: string; amount?: string; currency?: string; reference?: string;
  sender?: string; senderAccount?: string; date?: string; description?: string;
  destination?: string; note?: string; fileName?: string;
};

export function registerSupeRoutes(app: FastifyInstance): void {

  app.post("/supe/process", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user as SupeUser;
    const b = req.body as SupeBody;

    if (!b.amount || !b.currency || !b.reference) {
      throw new ValidationError("amount, currency and reference are required");
    }

    const amount = new Decimal(String(b.amount).replace(",", "."));
    if (!amount.isFinite() || amount.lte(0)) throw new ValidationError("amount must be positive");
    if (amount.gt(SUPE_MAX_AMOUNT)) throw new ValidationError("amount exceeds maximum limit");

    const currency = b.currency.toUpperCase();
    const reference = b.reference.trim();
    const normalizedAmount = amount.toFixed(4);

    const journalRef = "SUPE-" + createHash("sha256")
      .update(`${user?.merchantId || user?.id || "admin"}:${reference}`)
      .digest("hex").slice(0, 32).toUpperCase();

    const existing = await prisma.journalEntry.findUnique({ where: { reference: journalRef }, select: { reference: true } });
    if (existing) throw new ConflictError(`Reference ${reference} has already been processed`);

    let destAccountCode: string;
    if (b.destination === "platform-reserve") {
      destAccountCode = `PLATFORM:RESERVE:${currency}`;
      await prisma.account.upsert({
        where: { code: destAccountCode },
        create: { code: destAccountCode, name: `Platform Reserve (${currency})`, type: "ASSET", subtype: "RESERVE", currency },
        update: {}
      });
    } else {
      const merchantId = user?.merchantId;
      if (!merchantId) throw new ValidationError("Merchant context required for wallet credit");
      const wallet = await prisma.wallet.findFirst({ where: { merchantId, status: "ACTIVE" }, include: { account: true } });
      if (!wallet) throw new NotFoundError("Merchant wallet", merchantId);
      destAccountCode = wallet.account.code;
    }

    const fundingAccount = await ensureSupeFundingAccount(currency);

    await ledgerService.postEntry({
      reference: journalRef,
      entryType: "TRANSFER",
      description: `SUPE: ${b.format || "fund upload"} — ${reference} — ${b.sender || "unknown sender"}`,
      source: "SUPE",
      postedBy: user?.id || "system",
      metadata: {
        supeFormat: b.format, originalReference: reference, sender: b.sender,
        senderAccount: b.senderAccount, valueDate: b.date, fileName: b.fileName,
        note: b.note, destination: b.destination, currency,
      },
      lines: [
        { accountCode: fundingAccount, debit: normalizedAmount, credit: "0" },
        { accountCode: destAccountCode, debit: "0", credit: normalizedAmount },
      ],
    });

    await prisma.auditLog.create({
      data: {
        userId: user?.id,
        merchantId: user?.merchantId,
        action: "SUPE_FUND_UPLOAD",
        entity: "JournalEntry",
        entityId: journalRef,
        ipAddress: req.ip,
        after: { amount: normalizedAmount, currency, reference, format: b.format, destination: b.destination }
      }
    });

    logger.info({ journalRef, amount: normalizedAmount, currency, reference }, "SUPE fund upload credited");

    return sendCreated(reply, {
      journalEntryRef: journalRef,
      amount: normalizedAmount,
      currency,
      reference,
      format: b.format,
      destination: destAccountCode,
      status: "CREDITED",
      message: `${normalizedAmount} ${currency} credited successfully`,
    });
  });

  app.get("/supe/uploads", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user as { merchantId?: string; role?: string } | undefined;
    const q = req.query as { limit?: string };
    const limit = Math.min(parseInt(q.limit || "20", 10), 100);

    const isAdmin = user?.role && ["SUPER_ADMIN", "ADMIN"].includes(user.role);
    const uploads = await prisma.journalEntry.findMany({
      where: { source: "SUPE", ...(isAdmin ? {} : { postedBy: user?.id || "" }) },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { reference: true, description: true, createdAt: true, status: true, metadata: true,
        lines: { select: { credit: true, accountCode: true }, where: { credit: { not: "0" } }, take: 1 } }
    });

    const formatted = uploads.map(u => {
      const meta = u.metadata as Record<string, unknown> | null;
      const creditLine = u.lines[0];
      return {
        reference: meta?.originalReference || u.reference,
        journalRef: u.reference,
        amount: creditLine?.credit || "0",
        currency: (meta?.currency as string) || "USD",
        format: (meta?.supeFormat as string) || "Unknown",
        sender: (meta?.sender as string) || "",
        fileName: (meta?.fileName as string) || "",
        status: u.status === "POSTED" ? "CREDITED" : u.status,
        createdAt: u.createdAt,
        destination: creditLine?.accountCode || "",
      };
    });

    return sendSuccess(reply, { uploads: formatted, count: formatted.length });
  });
}