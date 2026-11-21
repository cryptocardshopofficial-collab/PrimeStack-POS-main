import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "crypto";
import { prisma } from "../../core/database.js";
import { Decimal } from "../../core/decimal.js";
import { ForbiddenError, ValidationError, ConflictError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { ledgerService } from "../ledger/ledger.module.js";
import { sendCreated, sendSuccess } from "../../shared/utils/response.js";

/**
 * Server Fund Load routes — admin (JWT) protected.
 *
 * These endpoints let an authorized officer record inbound settlement funds
 * from external server types into the platform ledger. Every call creates an
 * immutable double-entry journal entry:
 *
 *   DEBIT  <source-incoming-account>
 *   CREDIT <destination-account>
 *
 * Routes:
 *   POST /admin/server-funds/global-load   — Global Server (PGSN) settlement
 *   POST /admin/server-funds/visa          — Visa card network clearing
 *   POST /admin/server-funds/m1            — M1 institutional private banking
 *   POST /admin/server-funds/m1-funds      — M1 wallet direct (manual confirmation)
 *   POST /admin/receive-funds/bank-server  — Bank server receipt (ISO 8583 / SWIFT / ACH / SEPA)
 */

const FUND_MAX_AMOUNT = "50000000";

type FundUser = { id?: string; role?: string; merchantId?: string } | undefined;

/** Assert the caller is an admin role. */
function assertAdmin(request: FastifyRequest): void {
  const role = (request.user as { role?: string } | undefined)?.role;
  if (!["SUPER_ADMIN", "ADMIN"].includes(role ?? "")) {
    throw new ForbiddenError("Only administrators can load server funds");
  }
}

/** Parse and validate a positive decimal amount within the global limit. */
function parseAmount(raw: unknown): { amount: Decimal; normalized: string } {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new ValidationError("amount is required");
  }
  const amount = new Decimal(String(raw).replace(",", "."));
  if (!amount.isFinite() || amount.lte(0)) {
    throw new ValidationError("amount must be a positive number");
  }
  if (amount.gt(FUND_MAX_AMOUNT)) {
    throw new ValidationError(`amount exceeds maximum limit of ${FUND_MAX_AMOUNT}`);
  }
  return { amount, normalized: amount.toFixed(4) };
}

function requireField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new ValidationError(`${field} is required`);
  }
  return String(value).trim();
}

/** Upsert an account so the ledger entry can resolve it. */
async function ensureAccount(
  code: string,
  name: string,
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
  subtype: string,
  currency: string,
): Promise<string> {
  await prisma.account.upsert({
    where: { code },
    create: { code, name, type, subtype, currency },
    update: {},
  });
  return code;
}

/**
 * Core fund-load routine shared by every server-type endpoint.
 *
 * @param request      Fastify request (for user + ip)
 * @param reply        Fastify reply
 * @param params        Descriptor for the load
 */
async function recordFundLoad(
  request: FastifyRequest,
  reply: FastifyReply,
  params: {
    source: string;
    action: string;
    entity: string;
    sourceAccount: { code: string; name: string; subtype: string };
    destinationAccount: { code: string; name: string; subtype: string };
    amount: string;
    currency: string;
    reference: string;
    description: string;
    metadata: Record<string, unknown>;
  },
): Promise<FastifyReply> {
  const user = request.user as FundUser;
  const currency = params.currency.toUpperCase();

  const journalRef = `${params.source}-` + createHash("sha256")
    .update(`${params.source}:${params.reference}:${currency}:${params.amount}`)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();

  const existing = await prisma.journalEntry.findUnique({
    where: { reference: journalRef },
    select: { reference: true },
  });
  if (existing) {
    throw new ConflictError(`Reference ${params.reference} has already been processed`);
  }

  const sourceCode = await ensureAccount(
    params.sourceAccount.code,
    params.sourceAccount.name,
    "ASSET",
    params.sourceAccount.subtype,
    currency,
  );
  const destCode = await ensureAccount(
    params.destinationAccount.code,
    params.destinationAccount.name,
    "ASSET",
    params.destinationAccount.subtype,
    currency,
  );

  await ledgerService.postEntry({
    reference: journalRef,
    entryType: "TRANSFER",
    description: params.description,
    source: params.source,
    postedBy: user?.id || "system",
    metadata: { ...params.metadata, currency, originalReference: params.reference },
    lines: [
      { accountCode: sourceCode, debit: params.amount, credit: "0" },
      { accountCode: destCode, debit: "0", credit: params.amount },
    ],
  });

  await prisma.auditLog.create({
    data: {
      userId: user?.id,
      merchantId: user?.merchantId,
      action: params.action,
      entity: params.entity,
      entityId: journalRef,
      ipAddress: request.ip,
      after: {
        amount: params.amount,
        currency,
        reference: params.reference,
        source: sourceCode,
        destination: destCode,
        ...params.metadata,
      },
    },
  });

  logger.info(
    { journalRef, amount: params.amount, currency, source: params.source },
    `${params.source} fund load credited`,
  );

  return sendCreated(reply, {
    journalEntryRef: journalRef,
    amount: params.amount,
    currency,
    reference: params.reference,
    source: params.source,
    sourceAccount: sourceCode,
    destinationAccount: destCode,
    status: "CREDITED",
    message: `${params.amount} ${currency} credited successfully`,
  });
}

export function registerServerFundsRoutes(app: FastifyInstance): void {
  // ── Global Server Fund Load ──────────────────────
  app.post("/admin/server-funds/global-load", { preHandler: app.authenticate }, async (req, reply) => {
    assertAdmin(req);
    const body = req.body as Record<string, unknown>;

    const { normalized } = parseAmount(body.amount);
    const currency = requireField(body, "currency").toUpperCase();
    const reference = requireField(body, "globalReference");
    const globalServerHost = requireField(body, "globalServerHost");
    const globalServerPort = requireField(body, "globalServerPort");
    const nodeId = requireField(body, "nodeId");
    const authToken = requireField(body, "authToken");
    const sourceAccount = requireField(body, "sourceAccount");
    const destinationAccount = body.destinationAccount
      ? String(body.destinationAccount).trim()
      : `PLATFORM:RESERVE:${currency}`;
    const settlementDate = body.settlementDate ? String(body.settlementDate).trim() : undefined;
    const authorizedBy = requireField(body, "authorizedBy");
    const notes = body.notes ? String(body.notes).trim() : undefined;

    return recordFundLoad(req, reply, {
      source: "GLOBAL_SERVER",
      action: "GLOBAL_SERVER_FUND_LOAD",
      entity: "JournalEntry",
      sourceAccount: {
        code: "GLOBAL:SERVER:INCOMING",
        name: "Global Server Incoming",
        subtype: "INCOMING",
      },
      destinationAccount: {
        code: destinationAccount,
        name: destinationAccount.includes("RESERVE") ? "Platform Reserve" : destinationAccount,
        subtype: "RESERVE",
      },
      amount: normalized,
      currency,
      reference,
      description: `Global Server fund load — ${reference} — node ${nodeId}`,
      metadata: {
        globalServerHost,
        globalServerPort,
        nodeId,
        authTokenMasked: authToken.slice(0, 4) + "****",
        sourceAccount,
        settlementDate,
        authorizedBy,
        notes,
      },
    });
  });

  // ── Visa Server Fund Load ────────────────────────
  app.post("/admin/server-funds/visa", { preHandler: app.authenticate }, async (req, reply) => {
    assertAdmin(req);
    const body = req.body as Record<string, unknown>;

    const { normalized } = parseAmount(body.amount);
    const currency = requireField(body, "currency").toUpperCase();
    const reference = requireField(body, "settlementReference");
    const vmid = requireField(body, "vmid");
    const vssAuthToken = requireField(body, "vssAuthToken");
    const vssEndpoint = requireField(body, "vssEndpoint");
    const settlementFileNumber = requireField(body, "settlementFileNumber");
    const settlementType = requireField(body, "settlementType");
    const settlementCycle = requireField(body, "settlementCycle");
    const binRange = body.binRange ? String(body.binRange).trim() : undefined;
    const destinationAccount = body.destinationAccount
      ? String(body.destinationAccount).trim()
      : `VISA:CLEARING:${currency}`;
    const authorizedBy = requireField(body, "authorizedBy");

    return recordFundLoad(req, reply, {
      source: "VISA_SERVER",
      action: "VISA_SERVER_FUND_LOAD",
      entity: "JournalEntry",
      sourceAccount: {
        code: "VISA:NETWORK:SETTLEMENT",
        name: "Visa Network Settlement",
        subtype: "SETTLEMENT",
      },
      destinationAccount: {
        code: destinationAccount,
        name: destinationAccount.includes("CLEARING") ? "Visa Clearing" : destinationAccount,
        subtype: "CLEARING",
      },
      amount: normalized,
      currency,
      reference,
      description: `Visa ${settlementType} settlement — ${reference} — VMID ${vmid}`,
      metadata: {
        vmid,
        vssAuthTokenMasked: vssAuthToken.slice(0, 4) + "****",
        vssEndpoint,
        settlementFileNumber,
        settlementType,
        settlementCycle,
        binRange,
        authorizedBy,
      },
    });
  });

  // ── M1 Server Fund Load ──────────────────────────
  app.post("/admin/server-funds/m1", { preHandler: app.authenticate }, async (req, reply) => {
    assertAdmin(req);
    const body = req.body as Record<string, unknown>;

    const { normalized } = parseAmount(body.amount);
    const currency = requireField(body, "currency").toUpperCase();
    const reference = requireField(body, "m1ReferenceNumber");
    const m1ServerHost = requireField(body, "m1ServerHost");
    const m1ServerPort = requireField(body, "m1ServerPort");
    const institutionCode = requireField(body, "institutionCode");
    const m1ApiKey = requireField(body, "m1ApiKey");
    const m1SecretToken = requireField(body, "m1SecretToken");
    const sourceAccount = requireField(body, "sourceAccount");
    const transferType = requireField(body, "transferType");
    const valueDate = body.valueDate ? String(body.valueDate).trim() : undefined;
    const destinationAccount = body.destinationAccount
      ? String(body.destinationAccount).trim()
      : `M1:CLEARING:${currency}`;
    const authorizedBy = requireField(body, "authorizedBy");

    return recordFundLoad(req, reply, {
      source: "M1_SERVER",
      action: "M1_SERVER_FUND_LOAD",
      entity: "JournalEntry",
      sourceAccount: {
        code: "M1:INSTITUTIONAL:INCOMING",
        name: "M1 Institutional Incoming",
        subtype: "INCOMING",
      },
      destinationAccount: {
        code: destinationAccount,
        name: destinationAccount.includes("CLEARING") ? "M1 Clearing" : destinationAccount,
        subtype: "CLEARING",
      },
      amount: normalized,
      currency,
      reference,
      description: `M1 ${transferType} — ${reference} — institution ${institutionCode}`,
      metadata: {
        m1ServerHost,
        m1ServerPort,
        institutionCode,
        m1ApiKeyMasked: m1ApiKey.slice(0, 4) + "****",
        m1SecretTokenMasked: m1SecretToken.slice(0, 4) + "****",
        sourceAccount,
        transferType,
        valueDate,
        authorizedBy,
      },
    });
  });

  // ── M1 Funds Direct Transfer ─────────────────────
  app.post("/admin/server-funds/m1-funds", { preHandler: app.authenticate }, async (req, reply) => {
    assertAdmin(req);
    const body = req.body as Record<string, unknown>;

    const { normalized } = parseAmount(body.amount);
    const currency = requireField(body, "currency").toUpperCase();
    const reference = requireField(body, "confirmationNumber");
    const m1WalletId = requireField(body, "m1WalletId");
    const accountHolderName = requireField(body, "accountHolderName");
    const transactionHash = body.transactionHash ? String(body.transactionHash).trim() : undefined;
    const transferDate = body.transferDate ? String(body.transferDate).trim() : undefined;
    const fundType = requireField(body, "fundType");
    const purpose = requireField(body, "purpose");
    const destinationAccount = body.destinationAccount
      ? String(body.destinationAccount).trim()
      : `PLATFORM:RESERVE:${currency}`;
    const authorizedBy = requireField(body, "authorizedBy");

    return recordFundLoad(req, reply, {
      source: "M1_DIRECT",
      action: "M1_DIRECT_FUND_RECEIPT",
      entity: "JournalEntry",
      sourceAccount: {
        code: "M1:DIRECT:INCOMING",
        name: "M1 Direct Incoming",
        subtype: "INCOMING",
      },
      destinationAccount: {
        code: destinationAccount,
        name: destinationAccount.includes("RESERVE") ? "Platform Reserve" : destinationAccount,
        subtype: "RESERVE",
      },
      amount: normalized,
      currency,
      reference,
      description: `M1 direct ${fundType} receipt — ${reference} — wallet ${m1WalletId}`,
      metadata: {
        m1WalletId,
        accountHolderName,
        transactionHash,
        transferDate,
        fundType,
        purpose,
        authorizedBy,
      },
    });
  });

  // ── Bank Server Fund Receipt ─────────────────────
  app.post("/admin/receive-funds/bank-server", { preHandler: app.authenticate }, async (req, reply) => {
    assertAdmin(req);
    const body = req.body as Record<string, unknown>;

    const { normalized } = parseAmount(body.amount);
    const currency = requireField(body, "currency").toUpperCase();
    const reference = requireField(body, "bankReference");
    const method = requireField(body, "method").toUpperCase();
    const allowedMethods = ["ISO8583", "SWIFT", "ACH", "SEPA", "WIRE", "T2T", "S2S"];
    if (!allowedMethods.includes(method)) {
      throw new ValidationError(`method must be one of: ${allowedMethods.join(", ")}`);
    }
    const senderBankName = requireField(body, "senderBankName");
    const sourceAccount = body.sourceAccount ? String(body.sourceAccount).trim() : undefined;
    const mti = body.mti ? String(body.mti).trim() : undefined;
    const destinationAccount = body.destinationAccount
      ? String(body.destinationAccount).trim()
      : `PLATFORM:RESERVE:${currency}`;
    const authorizedBy = requireField(body, "authorizedBy");
    const notes = body.notes ? String(body.notes).trim() : undefined;

    return recordFundLoad(req, reply, {
      source: "BANK_SERVER",
      action: "BANK_SERVER_FUND_RECEIPT",
      entity: "JournalEntry",
      sourceAccount: {
        code: `BANK:INCOMING:${currency}`,
        name: `Bank Incoming (${currency})`,
        subtype: "INCOMING",
      },
      destinationAccount: {
        code: destinationAccount,
        name: destinationAccount.includes("RESERVE") ? "Platform Reserve" : destinationAccount,
        subtype: "RESERVE",
      },
      amount: normalized,
      currency,
      reference,
      description: `Bank server ${method} receipt — ${reference} — ${senderBankName}`,
      metadata: {
        method,
        senderBankName,
        sourceAccount,
        mti,
        authorizedBy,
        notes,
      },
    });
  });

  // ── List recent server fund loads ────────────────
  app.get("/admin/server-funds", { preHandler: app.authenticate }, async (req, reply) => {
    assertAdmin(req);
    const q = req.query as { limit?: string; source?: string };
    const limit = Math.min(parseInt(q.limit || "20", 10), 100);

    const sourceFilter = q.source ? { source: q.source.toUpperCase() } : {};
    const entries = await prisma.journalEntry.findMany({
      where: {
        source: { in: ["GLOBAL_SERVER", "VISA_SERVER", "M1_SERVER", "M1_DIRECT", "BANK_SERVER"] },
        ...sourceFilter,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        reference: true,
        source: true,
        description: true,
        createdAt: true,
        status: true,
        metadata: true,
        lines: {
          select: { credit: true, account: { select: { code: true } } },
          where: { credit: { not: "0" } },
          take: 1,
        },
      },
    });

    const loads = entries.map((e) => {
      const meta = (e.metadata as Record<string, unknown> | null) || {};
      const creditLine = e.lines[0];
      return {
        source: e.source,
        reference: (meta.originalReference as string) || e.reference,
        journalRef: e.reference,
        amount: creditLine?.credit || "0",
        currency: (meta.currency as string) || "USD",
        destination: creditLine?.account.code || "",
        authorizedBy: (meta.authorizedBy as string) || "",
        status: e.status === "POSTED" ? "CREDITED" : e.status,
        createdAt: e.createdAt,
        description: e.description,
      };
    });

    return sendSuccess(reply, { loads, count: loads.length });
  });
}
