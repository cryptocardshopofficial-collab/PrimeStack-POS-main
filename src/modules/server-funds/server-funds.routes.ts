import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, randomUUID } from "crypto";
import { prisma } from "../../core/database.js";
import { Decimal } from "../../core/decimal.js";
import {
  ValidationError, ConflictError, NotFoundError, ForbiddenError
} from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { sendSuccess, sendCreated } from "../../shared/utils/response.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

type AdminUser = { id?: string; role?: string; merchantId?: string } | undefined;
const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];

function assertAdmin(user: AdminUser): string {
  if (!user?.id || !user.role || !ADMIN_ROLES.includes(user.role)) {
    throw new ForbiddenError("Only administrators can access server fund endpoints");
  }
  return user.id;
}

async function ensureAccount(code: string, name: string, currency: string, subtype = "RESERVE"): Promise<string> {
  await prisma.account.upsert({
    where: { code },
    create: { code, name, type: "ASSET", subtype, currency },
    update: {},
  });
  return code;
}

async function postFundEntry(opts: {
  journalRef: string;
  amount: string;
  currency: string;
  debitCode: string;
  creditCode: string;
  description: string;
  postedBy: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await ledgerService.postEntry({
    reference: opts.journalRef,
    entryType: "TRANSFER",
    description: opts.description,
    source: "SERVER_FUNDS",
    postedBy: opts.postedBy,
    metadata: opts.metadata,
    lines: [
      { accountCode: opts.debitCode,  debit: opts.amount, credit: "0" },
      { accountCode: opts.creditCode, debit: "0", credit: opts.amount },
    ],
  });
}

function makeRef(prefix: string, scope: string, reference: string): string {
  return prefix + "-" + createHash("sha256")
    .update(`${scope}:${reference}`)
    .digest("hex").slice(0, 32).toUpperCase();
}

function parseAmount(raw: unknown): Decimal {
  const d = new Decimal(String(raw).replace(",", "."));
  if (!d.isFinite() || d.lte(0)) throw new ValidationError("amount must be a positive number");
  if (d.gt("50000000")) throw new ValidationError("amount exceeds the maximum limit of 50,000,000");
  return d;
}

async function auditFundLoad(opts: {
  userId: string; action: string; amount: string; currency: string;
  reference: string; journalRef: string; ip: string; meta: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: opts.userId,
      action: opts.action,
      entity: "JournalEntry",
      entityId: opts.journalRef,
      ipAddress: opts.ip,
      after: { amount: opts.amount, currency: opts.currency, reference: opts.reference, ...opts.meta },
    },
  });
}

// ── History helper ────────────────────────────────────────────────────────────

async function loadHistory(source: string, limit: number) {
  const entries = await prisma.journalEntry.findMany({
    where: { source },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      reference: true, description: true, createdAt: true, status: true, metadata: true,
      lines: { where: { credit: { not: "0" } }, select: { credit: true, accountCode: true }, take: 1 },
    },
  });
  return entries.map(e => {
    const meta = e.metadata as Record<string, unknown> | null;
    const line = e.lines[0];
    return {
      journalRef: e.reference,
      amount: line?.credit ?? "0",
      currency: (meta?.currency as string) ?? "USD",
      reference: (meta?.externalReference as string) ?? e.reference,
      description: e.description,
      status: e.status === "POSTED" ? "CREDITED" : e.status,
      destination: line?.accountCode ?? "",
      createdAt: e.createdAt,
      metadata: meta,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═════════════════════════════════════════════════════════════════════════════

export function registerServerFundRoutes(app: FastifyInstance): void {

  // ── 1. SUPE ────────────────────────────────────────────────────────────────

  app.post("/supe/process", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user as AdminUser;
    const b = req.body as {
      format?: string; amount?: string; currency?: string; reference?: string;
      sender?: string; senderAccount?: string; date?: string; description?: string;
      destination?: string; note?: string; fileName?: string;
    };
    if (!b.amount || !b.currency || !b.reference) throw new ValidationError("amount, currency and reference are required");
    const amount = parseAmount(b.amount);
    const currency = b.currency.toUpperCase();
    const normalizedAmount = amount.toFixed(4);
    const journalRef = makeRef("SUPE", user?.merchantId ?? user?.id ?? "admin", b.reference);
    const existing = await prisma.journalEntry.findUnique({ where: { reference: journalRef }, select: { reference: true } });
    if (existing) throw new ConflictError(`Reference ${b.reference} has already been processed`);
    let destCode: string;
    if (b.destination === "platform-reserve") {
      destCode = await ensureAccount(`PLATFORM:RESERVE:${currency}`, `Platform Reserve (${currency})`, currency);
    } else {
      const merchantId = user?.merchantId;
      if (!merchantId) throw new ValidationError("Merchant context required for wallet credit");
      const wallet = await prisma.wallet.findFirst({ where: { merchantId, status: "ACTIVE" }, include: { account: true } });
      if (!wallet) throw new NotFoundError("Merchant wallet", merchantId);
      destCode = wallet.account.code;
    }
    const fundingCode = await ensureAccount(`SYSTEM-FUNDING-${currency}`, `System funding (${currency})`, currency, "FUNDING");
    await postFundEntry({
      journalRef, amount: normalizedAmount, currency,
      debitCode: fundingCode, creditCode: destCode,
      description: `SUPE: ${b.format ?? "fund upload"} — ${b.reference} — ${b.sender ?? "unknown sender"}`,
      postedBy: user?.id ?? "system",
      metadata: { supeFormat: b.format, externalReference: b.reference, sender: b.sender, currency,
        senderAccount: b.senderAccount, valueDate: b.date, fileName: b.fileName, note: b.note, destination: b.destination },
    });
    if (user?.id) await auditFundLoad({ userId: user.id, action: "SUPE_FUND_UPLOAD",
      amount: normalizedAmount, currency, reference: b.reference, journalRef, ip: req.ip,
      meta: { format: b.format, fileName: b.fileName, destination: b.destination } });
    logger.info({ journalRef, amount: normalizedAmount, currency }, "SUPE fund upload credited");
    return sendCreated(reply, { journalEntryRef: journalRef, amount: normalizedAmount, currency,
      reference: b.reference, format: b.format, destination: destCode, status: "CREDITED",
      message: `${normalizedAmount} ${currency} credited successfully` });
  });

  app.get("/supe/uploads", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { limit?: string };
    const uploads = await loadHistory("SUPE", Math.min(parseInt(q.limit ?? "20", 10), 100));
    return sendSuccess(reply, { uploads, count: uploads.length });
  });

  // ── 2. Global Server Fund Load ─────────────────────────────────────────────

  app.post("/admin/server-funds/global-load", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = assertAdmin(req.user as AdminUser);
    const b = req.body as {
      amount?: string; currency?: string; globalReference?: string; nodeId?: string;
      globalServerHost?: string; globalServerPort?: number; authToken?: string;
      sourceAccount?: string; destinationAccount?: string; settlementDate?: string;
      authorizedBy?: string; notes?: string;
    };
    if (!b.amount || !b.currency || !b.globalReference || !b.authorizedBy) {
      throw new ValidationError("amount, currency, globalReference and authorizedBy are required");
    }
    const amount = parseAmount(b.amount);
    const currency = b.currency.toUpperCase();
    const normalizedAmount = amount.toFixed(4);
    const journalRef = makeRef("GS", userId, b.globalReference);
    const existing = await prisma.journalEntry.findUnique({ where: { reference: journalRef }, select: { reference: true } });
    if (existing) throw new ConflictError(`Global reference ${b.globalReference} has already been loaded`);
    const destCode = b.destinationAccount ?? `PLATFORM:RESERVE:${currency}`;
    await ensureAccount(destCode, `Platform Reserve (${currency})`, currency);
    const debitCode = await ensureAccount(`GLOBAL:SERVER:INCOMING:${currency}`, `Global server incoming (${currency})`, currency, "INCOMING");
    await postFundEntry({
      journalRef, amount: normalizedAmount, currency,
      debitCode, creditCode: destCode,
      description: `Global Server load — ${b.globalReference} — ${b.nodeId ?? "unknown node"} — by ${b.authorizedBy}`,
      postedBy: userId,
      metadata: { externalReference: b.globalReference, nodeId: b.nodeId, host: b.globalServerHost,
        port: b.globalServerPort, sourceAccount: b.sourceAccount, authorizedBy: b.authorizedBy,
        settlementDate: b.settlementDate, notes: b.notes, currency },
    });
    await auditFundLoad({ userId, action: "GLOBAL_SERVER_FUND_LOAD",
      amount: normalizedAmount, currency, reference: b.globalReference, journalRef, ip: req.ip,
      meta: { nodeId: b.nodeId, host: b.globalServerHost, authorizedBy: b.authorizedBy } });
    logger.info({ journalRef, amount: normalizedAmount, currency, node: b.nodeId }, "Global server fund loaded");
    return sendCreated(reply, { journalEntryRef: journalRef, amount: normalizedAmount, currency,
      reference: b.globalReference, destination: destCode, status: "CREDITED",
      message: `${normalizedAmount} ${currency} loaded from global server` });
  });

  app.get("/admin/server-funds/global-load/history", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    assertAdmin(req.user as AdminUser);
    const q = req.query as { limit?: string };
    const entries = await loadHistory("SERVER_FUNDS", Math.min(parseInt(q.limit ?? "20", 10), 100));
    const filtered = entries.filter(e => (e.metadata as Record<string,unknown>)?.nodeId !== undefined);
    return sendSuccess(reply, { entries: filtered, count: filtered.length });
  });

  // ── 3. Visa Server Funds ───────────────────────────────────────────────────

  app.post("/admin/server-funds/visa", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = assertAdmin(req.user as AdminUser);
    const b = req.body as {
      amount?: string; currency?: string; settlementReference?: string; vsssFileNumber?: string;
      settlementType?: string; settlementCycle?: string; vmid?: string; vssAuthToken?: string;
      vssEndpoint?: string; binRange?: string; destinationAccount?: string;
      settlementDate?: string; authorizedBy?: string; notes?: string;
    };
    if (!b.amount || !b.currency || !b.settlementReference || !b.authorizedBy) {
      throw new ValidationError("amount, currency, settlementReference and authorizedBy are required");
    }
    const amount = parseAmount(b.amount);
    const currency = b.currency.toUpperCase();
    const normalizedAmount = amount.toFixed(4);
    const journalRef = makeRef("VISA", userId, b.settlementReference);
    const existing = await prisma.journalEntry.findUnique({ where: { reference: journalRef }, select: { reference: true } });
    if (existing) throw new ConflictError(`Visa settlement reference ${b.settlementReference} already processed`);
    const destCode = b.destinationAccount ?? `VISA:CLEARING:${currency}`;
    await ensureAccount(destCode, `Visa clearing (${currency})`, currency, "CLEARING");
    const debitCode = await ensureAccount(`VISA:NETWORK:SETTLEMENT:${currency}`, `Visa network settlement (${currency})`, currency, "SETTLEMENT");
    await postFundEntry({
      journalRef, amount: normalizedAmount, currency,
      debitCode, creditCode: destCode,
      description: `Visa ${b.settlementType ?? "settlement"} — ${b.settlementReference} — ${b.vsssFileNumber ?? ""} — by ${b.authorizedBy}`,
      postedBy: userId,
      metadata: { externalReference: b.settlementReference, vsssFileNumber: b.vsssFileNumber,
        settlementType: b.settlementType, settlementCycle: b.settlementCycle, vmid: b.vmid,
        binRange: b.binRange, authorizedBy: b.authorizedBy, settlementDate: b.settlementDate,
        notes: b.notes, currency },
    });
    await auditFundLoad({ userId, action: "VISA_SERVER_FUND_LOAD",
      amount: normalizedAmount, currency, reference: b.settlementReference, journalRef, ip: req.ip,
      meta: { settlementType: b.settlementType, vmid: b.vmid, authorizedBy: b.authorizedBy } });
    logger.info({ journalRef, amount: normalizedAmount, currency, type: b.settlementType }, "Visa settlement loaded");
    return sendCreated(reply, { journalEntryRef: journalRef, amount: normalizedAmount, currency,
      reference: b.settlementReference, settlementType: b.settlementType, destination: destCode,
      status: "CREDITED", message: `${normalizedAmount} ${currency} Visa settlement credited` });
  });

  app.get("/admin/server-funds/visa/history", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    assertAdmin(req.user as AdminUser);
    const q = req.query as { limit?: string };
    const entries = await loadHistory("SERVER_FUNDS", Math.min(parseInt(q.limit ?? "20", 10), 100));
    const filtered = entries.filter(e => (e.metadata as Record<string,unknown>)?.vmid !== undefined);
    return sendSuccess(reply, { entries: filtered, count: filtered.length });
  });

  // ── 4. M1 Server ──────────────────────────────────────────────────────────

  app.post("/admin/server-funds/m1", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = assertAdmin(req.user as AdminUser);
    const b = req.body as {
      amount?: string; currency?: string; m1Reference?: string; institutionCode?: string;
      m1ApiKey?: string; m1SecretToken?: string; m1Host?: string; m1Port?: number;
      transferType?: string; sourceAccount?: string; destinationAccount?: string;
      valueDate?: string; authorizedBy?: string; notes?: string;
    };
    if (!b.amount || !b.currency || !b.m1Reference || !b.institutionCode || !b.authorizedBy) {
      throw new ValidationError("amount, currency, m1Reference, institutionCode and authorizedBy are required");
    }
    const amount = parseAmount(b.amount);
    const currency = b.currency.toUpperCase();
    const normalizedAmount = amount.toFixed(4);
    const journalRef = makeRef("M1S", userId, b.m1Reference);
    const existing = await prisma.journalEntry.findUnique({ where: { reference: journalRef }, select: { reference: true } });
    if (existing) throw new ConflictError(`M1 reference ${b.m1Reference} already processed`);
    const destCode = b.destinationAccount ?? `M1:CLEARING:${currency}`;
    await ensureAccount(destCode, `M1 clearing (${currency})`, currency, "CLEARING");
    const debitCode = await ensureAccount(`M1:INSTITUTIONAL:INCOMING:${currency}`, `M1 institutional incoming (${currency})`, currency, "INCOMING");
    await postFundEntry({
      journalRef, amount: normalizedAmount, currency,
      debitCode, creditCode: destCode,
      description: `M1 ${b.transferType ?? "settlement"} — ${b.m1Reference} — ${b.institutionCode} — by ${b.authorizedBy}`,
      postedBy: userId,
      metadata: { externalReference: b.m1Reference, institutionCode: b.institutionCode,
        m1Host: b.m1Host, m1Port: b.m1Port, transferType: b.transferType,
        sourceAccount: b.sourceAccount, authorizedBy: b.authorizedBy,
        valueDate: b.valueDate, notes: b.notes, currency },
    });
    await auditFundLoad({ userId, action: "M1_SERVER_FUND_LOAD",
      amount: normalizedAmount, currency, reference: b.m1Reference, journalRef, ip: req.ip,
      meta: { institutionCode: b.institutionCode, transferType: b.transferType, authorizedBy: b.authorizedBy } });
    logger.info({ journalRef, amount: normalizedAmount, currency, inst: b.institutionCode }, "M1 server fund loaded");
    return sendCreated(reply, { journalEntryRef: journalRef, amount: normalizedAmount, currency,
      reference: b.m1Reference, transferType: b.transferType, destination: destCode,
      status: "CREDITED", message: `${normalizedAmount} ${currency} M1 server funds credited` });
  });

  app.get("/admin/server-funds/m1/history", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    assertAdmin(req.user as AdminUser);
    const q = req.query as { limit?: string };
    const entries = await loadHistory("SERVER_FUNDS", Math.min(parseInt(q.limit ?? "20", 10), 100));
    const filtered = entries.filter(e => (e.metadata as Record<string,unknown>)?.institutionCode !== undefined);
    return sendSuccess(reply, { entries: filtered, count: filtered.length });
  });

  // ── 5. M1 Funds Direct ────────────────────────────────────────────────────

  app.post("/admin/server-funds/m1-funds", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = assertAdmin(req.user as AdminUser);
    const b = req.body as {
      amount?: string; currency?: string; m1ConfirmationNumber?: string; m1WalletId?: string;
      accountHolderName?: string; m1TransactionHash?: string; transferDate?: string;
      fundType?: string; destinationAccount?: string; purpose?: string;
      authorizedBy?: string; notes?: string;
    };
    if (!b.amount || !b.currency || !b.m1ConfirmationNumber || !b.m1WalletId || !b.authorizedBy) {
      throw new ValidationError("amount, currency, m1ConfirmationNumber, m1WalletId and authorizedBy are required");
    }
    const amount = parseAmount(b.amount);
    const currency = b.currency.toUpperCase();
    const normalizedAmount = amount.toFixed(4);
    const journalRef = makeRef("M1F", userId, b.m1ConfirmationNumber);
    const existing = await prisma.journalEntry.findUnique({ where: { reference: journalRef }, select: { reference: true } });
    if (existing) throw new ConflictError(`M1 confirmation ${b.m1ConfirmationNumber} already processed`);
    const destCode = b.destinationAccount ?? `PLATFORM:RESERVE:${currency}`;
    await ensureAccount(destCode, `Platform Reserve (${currency})`, currency);
    const debitCode = await ensureAccount(`M1:DIRECT:INCOMING:${currency}`, `M1 direct incoming (${currency})`, currency, "INCOMING");
    await postFundEntry({
      journalRef, amount: normalizedAmount, currency,
      debitCode, creditCode: destCode,
      description: `M1 direct — ${b.m1ConfirmationNumber} — ${b.accountHolderName ?? b.m1WalletId} — ${b.fundType ?? "wallet transfer"}`,
      postedBy: userId,
      metadata: { externalReference: b.m1ConfirmationNumber, m1WalletId: b.m1WalletId,
        accountHolderName: b.accountHolderName, m1TransactionHash: b.m1TransactionHash,
        transferDate: b.transferDate, fundType: b.fundType, purpose: b.purpose,
        authorizedBy: b.authorizedBy, notes: b.notes, currency },
    });
    await auditFundLoad({ userId, action: "M1_DIRECT_FUND_RECEIPT",
      amount: normalizedAmount, currency, reference: b.m1ConfirmationNumber, journalRef, ip: req.ip,
      meta: { m1WalletId: b.m1WalletId, fundType: b.fundType, authorizedBy: b.authorizedBy } });
    logger.info({ journalRef, amount: normalizedAmount, currency, wallet: b.m1WalletId }, "M1 direct fund received");
    return sendCreated(reply, { journalEntryRef: journalRef, amount: normalizedAmount, currency,
      confirmationNumber: b.m1ConfirmationNumber, walletId: b.m1WalletId, destination: destCode,
      status: "CREDITED", message: `${normalizedAmount} ${currency} M1 funds credited` });
  });

  app.get("/admin/server-funds/m1-funds/history", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    assertAdmin(req.user as AdminUser);
    const q = req.query as { limit?: string };
    const entries = await loadHistory("SERVER_FUNDS", Math.min(parseInt(q.limit ?? "20", 10), 100));
    const filtered = entries.filter(e => (e.metadata as Record<string,unknown>)?.m1WalletId !== undefined);
    return sendSuccess(reply, { entries: filtered, count: filtered.length });
  });

  // ── 6. Bank Server Receipt ─────────────────────────────────────────────────

  app.post("/admin/receive-funds/bank-server", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = assertAdmin(req.user as AdminUser);
    const b = req.body as {
      amount?: string; currency?: string; bankReference?: string; transferType?: string;
      senderName?: string; senderBank?: string; senderAccount?: string;
      mti?: string; destinationAccount?: string; receivedDate?: string;
      authorizedBy?: string; notes?: string;
    };
    if (!b.amount || !b.currency || !b.bankReference || !b.senderName || !b.authorizedBy) {
      throw new ValidationError("amount, currency, bankReference, senderName and authorizedBy are required");
    }
    const amount = parseAmount(b.amount);
    const currency = b.currency.toUpperCase();
    const normalizedAmount = amount.toFixed(4);
    const journalRef = makeRef("BANK", userId, b.bankReference);
    const existing = await prisma.journalEntry.findUnique({ where: { reference: journalRef }, select: { reference: true } });
    if (existing) throw new ConflictError(`Bank reference ${b.bankReference} already processed`);
    const destCode = b.destinationAccount ?? `PLATFORM:RESERVE:${currency}`;
    await ensureAccount(destCode, `Platform Reserve (${currency})`, currency);
    const debitCode = await ensureAccount(`BANK:INCOMING:${currency}`, `Bank incoming (${currency})`, currency, "INCOMING");
    await postFundEntry({
      journalRef, amount: normalizedAmount, currency,
      debitCode, creditCode: destCode,
      description: `Bank receipt ${b.transferType ?? "WIRE"} — ${b.bankReference} — ${b.senderName} — ${b.senderBank ?? ""}`,
      postedBy: userId,
      metadata: { externalReference: b.bankReference, transferType: b.transferType,
        senderName: b.senderName, senderBank: b.senderBank, senderAccount: b.senderAccount,
        mti: b.mti, receivedDate: b.receivedDate, authorizedBy: b.authorizedBy,
        notes: b.notes, currency },
    });
    await auditFundLoad({ userId, action: "BANK_SERVER_RECEIPT",
      amount: normalizedAmount, currency, reference: b.bankReference, journalRef, ip: req.ip,
      meta: { transferType: b.transferType, senderName: b.senderName, senderBank: b.senderBank, authorizedBy: b.authorizedBy } });
    logger.info({ journalRef, amount: normalizedAmount, currency, sender: b.senderName }, "Bank fund receipt recorded");
    return sendCreated(reply, { journalEntryRef: journalRef, amount: normalizedAmount, currency,
      reference: b.bankReference, transferType: b.transferType, senderName: b.senderName,
      destination: destCode, status: "CREDITED", message: `${normalizedAmount} ${currency} received from ${b.senderName}` });
  });

  app.get("/admin/receive-funds/bank-server/history", { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    assertAdmin(req.user as AdminUser);
    const q = req.query as { limit?: string };
    const entries = await loadHistory("SERVER_FUNDS", Math.min(parseInt(q.limit ?? "20", 10), 100));
    const filtered = entries.filter(e => (e.metadata as Record<string,unknown>)?.senderBank !== undefined);
    return sendSuccess(reply, { entries: filtered, count: filtered.length });
  });
}