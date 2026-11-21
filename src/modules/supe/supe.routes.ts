import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../../core/database.js";
import { Decimal } from "../../core/decimal.js";
import { ValidationError, ConflictError, NotFoundError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { sendSuccess, sendCreated } from "../../shared/utils/response.js";
import { renderIncomingPaymentPdf } from "./incoming-payment-pdf.js";

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

async function ensurePlatformReserve(currency: string): Promise<string> {
  const code = `PLATFORM:RESERVE:${currency}`;
  await prisma.account.upsert({
    where: { code },
    create: { code, name: `Platform Reserve (${currency})`, type: "ASSET", subtype: "RESERVE", currency },
    update: {}
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
    const user = req.user as { id?: string; merchantId?: string; role?: string } | undefined;
    const q = req.query as { limit?: string };
    const limit = Math.min(parseInt(q.limit || "20", 10), 100);

    const isAdmin = user?.role && ["SUPER_ADMIN", "ADMIN"].includes(user.role);
    const uploads = await prisma.journalEntry.findMany({
      where: { source: "SUPE", ...(isAdmin ? {} : { postedBy: user?.id || "" }) },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { reference: true, description: true, createdAt: true, status: true, metadata: true,
        lines: { select: { credit: true, account: { select: { code: true } } }, where: { credit: { not: "0" } }, take: 1 } }
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
        destination: creditLine?.account.code || "",
      };
    });

    return sendSuccess(reply, { uploads: formatted, count: formatted.length });
  });

  // ── Incoming payment receipt as PDF ─────────────
  app.get("/supe/uploads/:reference/pdf", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { reference } = req.params as { reference: string };
    const user = req.user as { id?: string; merchantId?: string; role?: string } | undefined;
    const isAdmin = user?.role && ["SUPER_ADMIN", "ADMIN"].includes(user.role);

    // Try to locate the SUPE journal entry — by original reference (metadata) or journal ref.
    const entry = await prisma.journalEntry.findFirst({
      where: {
        source: "SUPE",
        OR: [
          { reference },
          { metadata: { path: ["originalReference"], equals: reference } },
        ],
      },
      include: { lines: { include: { account: true } } },
    });

    if (!entry) throw new NotFoundError("Incoming payment", reference);

    // Non-admins may only fetch their own uploads.
    if (!isAdmin && entry.postedBy !== user?.id) {
      throw new NotFoundError("Incoming payment", reference);
    }

    const meta = (entry.metadata as Record<string, unknown> | null) || {};
    const amountLine = entry.lines.find((l) => !l.credit.isZero()) || entry.lines[0];

    const pdfBuffer = renderIncomingPaymentPdf({
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

  // ── Direct XML / ISO 20022 ingest (server-to-server webhook) ────────────
  // curl -X POST /supe/ingest/xml -H "Content-Type: application/xml"
  //   -H "X-PrimeStack-Key-Id: psk_xxx"
  //   -H "X-PrimeStack-Signature: <hmac_sha256>"
  //   -H "X-Checksum-SHA256: <sha256>"
  //   --data-binary "@file.xml"
  app.post("/supe/ingest/xml", async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const bodyStr = rawBody ? rawBody.toString("utf8") : typeof req.body === "string" ? req.body : "";

    if (!bodyStr || bodyStr.length < 10) throw new ValidationError("Empty or invalid XML body");

    const payload = rawBody ?? Buffer.from(bodyStr);

    const providedChecksum = req.headers["x-checksum-sha256"] as string | undefined;
    if (providedChecksum) {
      const actualChecksum = createHash("sha256").update(payload).digest("hex");
      if (actualChecksum !== providedChecksum) {
        throw new ValidationError("SHA256 checksum mismatch — file may be corrupted");
      }
    }

    const keyId = req.headers["x-primestack-key-id"] as string | undefined;
    const signature = req.headers["x-primestack-signature"] as string | undefined;
    if (keyId && signature) {
      const hmacKey = await prisma.hmacKey.findFirst({
        where: { keyId, status: "ACTIVE" },
        select: { secret: true }
      });
      if (hmacKey) {
        const expected = createHmac("sha256", hmacKey.secret).update(payload).digest("hex");
        const sigBuf = Buffer.from(signature, "hex");
        const expBuf = Buffer.from(expected, "hex");
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
          throw new ValidationError("HMAC signature verification failed");
        }
      }
    }

    const xml = bodyStr;
    const msgType =
      xml.includes("pacs.008") || xml.includes("FIToFICstmrCdtTrf") ? "pacs.008" :
      xml.includes("pacs.002") || xml.includes("FIToFIPmtStsRpt") ? "pacs.002" :
      xml.includes("camt.054") || xml.includes("BkToCstmrDbtCdtNtfctn") ? "camt.054" :
      xml.includes("pain.001") ? "pain.001" : "ISO 20022";

    const amtMatch =
      xml.match(/<InstdAmt[^>]+Ccy="([A-Z]{3})"[^>]*>([\d.]+)<\/InstdAmt>/) ||
      xml.match(/<IntrBkSttlmAmt[^>]+Ccy="([A-Z]{3})"[^>]*>([\d.]+)<\/IntrBkSttlmAmt>/) ||
      xml.match(/<Amt[^>]+Ccy="([A-Z]{3})"[^>]*>([\d.]+)<\/Amt>/);

    const currency = amtMatch?.[1] ?? "USD";
    const amountStr = amtMatch?.[2] ?? "";
    if (!amountStr || isNaN(parseFloat(amountStr))) {
      throw new ValidationError("Could not extract amount from XML — check the file format");
    }

    const refMatch =
      xml.match(/<EndToEndId>(.*?)<\/EndToEndId>/) ||
      xml.match(/<InstrId>(.*?)<\/InstrId>/) ||
      xml.match(/<MsgId>(.*?)<\/MsgId>/);
    const reference = refMatch?.[1]?.trim() ?? "";
    if (!reference) throw new ValidationError("Could not extract reference from XML");

    const senderMatch =
      xml.match(/<Dbtr>[\s\S]*?<Nm>(.*?)<\/Nm>/) ||
      xml.match(/<InitgPty>[\s\S]*?<Nm>(.*?)<\/Nm>/);
    const sender = senderMatch?.[1]?.trim() ?? "";

    const dateMatch =
      xml.match(/<IntrBkSttlmDt>(.*?)<\/IntrBkSttlmDt>/) ||
      xml.match(/<ReqdExctnDt>(.*?)<\/ReqdExctnDt>/) ||
      xml.match(/<CreDtTm>(.*?)<\/CreDtTm>/);
    const date = dateMatch?.[1]?.trim().split("T")[0] ?? new Date().toISOString().split("T")[0];

    const merchantKey = keyId ? await prisma.hmacKey.findFirst({
      where: { keyId, status: "ACTIVE" },
      include: { merchant: { select: { id: true } } }
    }) : null;
    const merchantId = merchantKey?.merchant?.id;

    const journalRef = "SUPE-" + createHash("sha256")
      .update(`${merchantId ?? keyId ?? "ingest"}:${reference}`)
      .digest("hex").slice(0, 32).toUpperCase();

    const existing = await prisma.journalEntry.findUnique({ where: { reference: journalRef }, select: { reference: true } });
    if (existing) throw new ConflictError(`Reference ${reference} has already been processed`);

    let destCode: string;
    if (merchantId) {
      const wallet = await prisma.wallet.findFirst({ where: { merchantId, status: "ACTIVE" }, include: { account: true } });
      destCode = wallet?.account.code ?? await ensurePlatformReserve(currency);
    } else {
      destCode = await ensurePlatformReserve(currency);
    }

    const fundingCode = await ensureSupeFundingAccount(currency);
    const normalizedAmount = new Decimal(amountStr).toFixed(4);

    await ledgerService.postEntry({
      reference: journalRef,
      entryType: "TRANSFER",
      description: `SUPE XML ingest: ${msgType} — ${reference} — ${sender}`,
      source: "SUPE",
      postedBy: keyId ?? "ingest",
      metadata: {
        supeFormat: msgType, originalReference: reference, externalReference: reference,
        sender, valueDate: date, currency, keyId,
        sha256Checksum: providedChecksum ?? null,
        destination: destCode,
        ingestedAt: new Date().toISOString(),
      },
      lines: [
        { accountCode: fundingCode, debit: normalizedAmount, credit: "0" },
        { accountCode: destCode, debit: "0", credit: normalizedAmount },
      ],
    });

    if (merchantId) {
      await prisma.auditLog.create({
        data: {
          merchantId,
          action: "SUPE_XML_INGEST",
          entity: "JournalEntry",
          entityId: journalRef,
          ipAddress: req.ip,
          after: { amount: normalizedAmount, currency, reference, format: msgType, keyId }
        }
      });
    }

    logger.info({ journalRef, amount: normalizedAmount, currency, reference, msgType }, "SUPE XML ingest credited");

    return sendCreated(reply, {
      journalEntryRef: journalRef, amount: normalizedAmount, currency, reference, format: msgType,
      sender, date, destination: destCode, status: "CREDITED",
      checksumVerified: !!providedChecksum, hmacVerified: !!(keyId && signature),
      message: `${normalizedAmount} ${currency} credited from ${msgType} file`,
    });
  });
}