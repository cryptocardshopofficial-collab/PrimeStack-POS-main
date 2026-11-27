import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "../../core/decimal.js";
import {
  AppError,
  NotFoundError,
  ValidationError,
} from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { generateReference } from "../../shared/utils/crypto.js";
import { encryptSecret, decryptSecret } from "../s2s-engine/s2s-crypto.js";
import {
  VAULT_SERVER_NODE_ID,
  VAULT_SERVER_VERSION,
  type CreateVaultConnectorInput,
  type UpdateVaultConnectorInput,
  type VaultReceiveInput,
  type VaultPayoutInput,
} from "./vault-server.types.js";

const VAULT_MAX_AMOUNT = "50000000";
const VAULT_INCOMING_SUBTYPE = "VAULT_INCOMING";
const VAULT_SUBTYPE = "VAULT";

/**
 * Vault Server Service
 *
 * The platform's own private receiving server. Responsibilities:
 *   1. Identity — exposes the VSN (Vault Server Node) identity
 *   2. Connectors — links real bank accounts to vault ledger accounts
 *   3. Receive — accepts inbound fund notifications via signed webhook
 *   4. Payout — moves funds from vault to any destination
 *   5. Balance poll — calls bank API to fetch real balance
 *   6. API key management — generates and rotates vault API keys
 */
export class VaultServerService {
  constructor(
    private prisma: PrismaClient,
    private ledgerService: LedgerService,
  ) {}

  // ── Identity ─────────────────────────────────────────────────

  getIdentity() {
    return {
      nodeId:    VAULT_SERVER_NODE_ID,
      version:   VAULT_SERVER_VERSION,
      terminalId: "EP022162",
      msn:       "PSM-4AA182A2",
      merchantId: "100000000036000",
      serverIps:  ["74.220.49.0/24", "74.220.57.0/24"],
      receiveEndpoint: "/vault/receive",
      apiKeyHeader:    "x-vault-api-key",
      signatureHeader: "x-vault-signature",
      description: "PrimeStack Private Vault Server — secure fund receiving and disbursement node",
    };
  }

  // ── API Key Management ────────────────────────────────────────

  /**
   * Generate a new vault API key for a connector.
   * Returns the plaintext key ONCE — it is encrypted before storage.
   */
  async generateApiKey(connectorId: string): Promise<{ keyId: string; apiKey: string; maskedKey: string }> {
    const connector = await this.requireConnector(connectorId);
    const apiKey = `vsk_live_${randomBytes(32).toString("hex")}`;
    const keyId  = `VK-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
    const encryptedKey = encryptSecret(apiKey);

    await this.prisma.$executeRaw`
      UPDATE "VaultConnector"
      SET "apiKey"    = ${encryptedKey},
          "apiKeyId"  = ${keyId},
          "updatedAt" = NOW()
      WHERE "id" = ${connectorId}
    `;

    logger.info({ connectorId, keyId, label: connector.label }, "Vault API key generated");

    return {
      keyId,
      apiKey,  // returned once only
      maskedKey: `vsk_live_${"*".repeat(32)}${apiKey.slice(-8)}`,
    };
  }

  /**
   * Verify an inbound vault API key.
   * Returns the connector if valid, throws if not.
   */
  async verifyApiKey(apiKey: string): Promise<VaultConnectorRow> {
    const connectors = await this.prisma.$queryRaw<VaultConnectorRow[]>`
      SELECT * FROM "VaultConnector" WHERE "status" = 'ACTIVE' LIMIT 100
    `;
    for (const connector of connectors) {
      if (!connector.apiKey) continue;
      try {
        const decrypted = decryptSecret(connector.apiKey);
        const a = Buffer.from(apiKey);
        const b = Buffer.from(decrypted);
        if (a.length === b.length && timingSafeEqual(a, b)) {
          return connector;
        }
      } catch {
        continue;
      }
    }
    throw new AppError("Invalid vault API key", 401, "VAULT_AUTH_FAILED");
  }

  // ── Connectors ────────────────────────────────────────────────

  async createConnector(input: CreateVaultConnectorInput): Promise<VaultConnectorRow> {
    // Ensure vault ledger accounts exist
    await this.ensureVaultAccounts(input.vaultAccountCode, input.currency);

    const encryptedApiKey = input.bankApiKey
      ? encryptSecret(input.bankApiKey)
      : null;

    const id = randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "VaultConnector"
        ("id","label","vaultAccountCode","currency","bankName","accountNumber",
         "swiftCode","accountHolder","country","bankApiEndpoint","apiKey",
         "pollingIntervalSeconds","autoCreditEnabled","status","metadata",
         "createdAt","updatedAt")
      VALUES (
        ${id}, ${input.label}, ${input.vaultAccountCode}, ${input.currency},
        ${input.bankName}, ${input.accountNumber},
        ${input.swiftCode ?? null}, ${input.accountHolder}, ${input.country},
        ${input.bankApiEndpoint ?? null}, ${encryptedApiKey},
        ${input.pollingIntervalSeconds ?? null}, ${input.autoCreditEnabled},
        'ACTIVE',
        ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb,
        NOW(), NOW()
      )
    `;

    logger.info({ connectorId: id, label: input.label }, "Vault connector created");
    return this.requireConnector(id);
  }

  async listConnectors(): Promise<VaultConnectorRow[]> {
    const rows = await this.prisma.$queryRaw<VaultConnectorRow[]>`
      SELECT id, label, "vaultAccountCode", currency, "bankName",
             "accountNumber", "swiftCode", "accountHolder", country,
             "bankApiEndpoint", "apiKeyId", "pollingIntervalSeconds",
             "autoCreditEnabled", status, metadata, "createdAt", "updatedAt"
      FROM "VaultConnector"
      ORDER BY "createdAt" DESC
    `;
    return rows;
  }

  async getConnector(id: string): Promise<VaultConnectorRow> {
    return this.requireConnector(id);
  }

  async updateConnector(id: string, input: UpdateVaultConnectorInput): Promise<VaultConnectorRow> {
    await this.requireConnector(id);

    if (input.label !== undefined) {
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "label"=${input.label},"updatedAt"=NOW() WHERE id=${id}`;
    }
    if (input.bankName !== undefined) {
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "bankName"=${input.bankName},"updatedAt"=NOW() WHERE id=${id}`;
    }
    if (input.accountNumber !== undefined) {
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "accountNumber"=${input.accountNumber},"updatedAt"=NOW() WHERE id=${id}`;
    }
    if (input.swiftCode !== undefined) {
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "swiftCode"=${input.swiftCode},"updatedAt"=NOW() WHERE id=${id}`;
    }
    if (input.bankApiEndpoint !== undefined) {
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "bankApiEndpoint"=${input.bankApiEndpoint},"updatedAt"=NOW() WHERE id=${id}`;
    }
    if (input.bankApiKey !== undefined) {
      const enc = encryptSecret(input.bankApiKey);
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "apiKey"=${enc},"updatedAt"=NOW() WHERE id=${id}`;
    }
    if (input.autoCreditEnabled !== undefined) {
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "autoCreditEnabled"=${input.autoCreditEnabled},"updatedAt"=NOW() WHERE id=${id}`;
    }
    if (input.pollingIntervalSeconds !== undefined) {
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "pollingIntervalSeconds"=${input.pollingIntervalSeconds},"updatedAt"=NOW() WHERE id=${id}`;
    }
    if (input.status !== undefined) {
      await this.prisma.$executeRaw`UPDATE "VaultConnector" SET "status"=${input.status},"updatedAt"=NOW() WHERE id=${id}`;
    }

    return this.requireConnector(id);
  }

  // ── Receive Funds ─────────────────────────────────────────────

  /**
   * Credit the vault ledger from an external notification.
   * Idempotent on eventId — safe to retry.
   */
  async receiveInbound(input: VaultReceiveInput): Promise<{
    duplicate: boolean;
    journalEntryRef: string;
    amount: string;
    currency: string;
    vaultAccountCode: string;
    balance: string | null;
  }> {
    const amount = new Decimal(input.amount);
    if (!amount.isFinite() || amount.lte(0)) {
      throw new ValidationError("amount must be positive");
    }
    if (amount.gt(VAULT_MAX_AMOUNT)) {
      throw new ValidationError("amount exceeds the maximum vault limit");
    }

    const normalizedAmount = amount.toFixed(4);
    const currency = input.currency.toUpperCase();

    // Idempotency — derive a deterministic journal reference from eventId
    const journalRef = `VAULT-${createHash("sha256")
      .update(`${input.eventId}:${input.vaultAccountCode}:${currency}`)
      .digest("hex")
      .slice(0, 32)
      .toUpperCase()}`;

    // Check for duplicate
    const existing = await this.prisma.journalEntry.findUnique({
      where: { reference: journalRef },
      select: { reference: true },
    });
    if (existing) {
      logger.info({ journalRef, eventId: input.eventId }, "Vault receive: duplicate ignored");
      return {
        duplicate: true,
        journalEntryRef: journalRef,
        amount: normalizedAmount,
        currency,
        vaultAccountCode: input.vaultAccountCode,
        balance: await this.getAccountBalance(input.vaultAccountCode),
      };
    }

    // Ensure accounts exist
    await this.ensureVaultAccounts(input.vaultAccountCode, currency);
    const incomingCode = `VAULT:INCOMING:${currency}`;

    // Post double-entry
    await this.ledgerService.postEntry({
      reference:   journalRef,
      entryType:   "TRANSFER",
      description: `Vault inbound: ${input.senderName ?? "external"} — ${input.bankReference ?? input.eventId}`,
      source:      "VAULT_RECEIVE",
      postedBy:    "vault-server",
      metadata: {
        eventId:        input.eventId,
        senderName:     input.senderName,
        senderBank:     input.senderBank,
        senderAccount:  input.senderAccount,
        bankReference:  input.bankReference,
        valueDate:      input.valueDate,
        transferMethod: input.transferMethod,
        ...(input.metadata ?? {}),
      },
      lines: [
        { accountCode: incomingCode,            debit: normalizedAmount, credit: "0" },
        { accountCode: input.vaultAccountCode,  debit: "0", credit: normalizedAmount },
      ],
    });

    logger.info(
      { journalRef, amount: normalizedAmount, currency, vault: input.vaultAccountCode },
      "Vault inbound credited",
    );

    return {
      duplicate: false,
      journalEntryRef: journalRef,
      amount: normalizedAmount,
      currency,
      vaultAccountCode: input.vaultAccountCode,
      balance: await this.getAccountBalance(input.vaultAccountCode),
    };
  }

  // ── Payout ────────────────────────────────────────────────────

  /**
   * Move funds from a vault account to any destination.
   * Posts a double-entry journal entry atomically.
   */
  async payout(input: VaultPayoutInput): Promise<{
    reference: string;
    journalEntryRef: string;
    amount: string;
    currency: string;
    sourceVaultCode: string;
    destinationCode: string;
    destinationType: string;
  }> {
    const amount = new Decimal(input.amount);
    if (!amount.isFinite() || amount.lte(0)) {
      throw new ValidationError("amount must be positive");
    }
    if (amount.gt(VAULT_MAX_AMOUNT)) {
      throw new ValidationError("amount exceeds maximum vault payout limit");
    }

    const currency = input.currency.toUpperCase();
    const normalizedAmount = amount.toFixed(4);

    // Resolve destination account code
    const destCode = this.resolveDestinationCode(input);

    // Ensure destination account exists for vault-to-vault or vault-to-terminal
    if (input.destinationType === "VAULT_ACCOUNT") {
      await this.ensureVaultAccounts(destCode, currency);
    }

    const reference = generateReference("VBP");
    const journalRef = `JE-${reference}`;

    await this.ledgerService.postEntry({
      reference:   journalRef,
      entryType:   "TRANSFER",
      description: input.description ?? `Vault payout to ${destCode} — ${reference}`,
      source:      "VAULT_PAYOUT",
      postedBy:    input.authorizedBy ?? "vault-server",
      metadata: {
        reference,
        destinationType:  input.destinationType,
        destinationCode:  destCode,
        beneficiaryName:  input.beneficiaryName,
        swiftCode:        input.swiftCode,
        authorizedBy:     input.authorizedBy,
        ...(input.metadata ?? {}),
      },
      lines: [
        { accountCode: input.sourceVaultCode, debit: normalizedAmount, credit: "0" },
        { accountCode: destCode,              debit: "0", credit: normalizedAmount },
      ],
    });

    logger.info(
      { reference, journalRef, amount: normalizedAmount, currency,
        source: input.sourceVaultCode, dest: destCode, type: input.destinationType },
      "Vault payout posted",
    );

    return {
      reference,
      journalEntryRef: journalRef,
      amount: normalizedAmount,
      currency,
      sourceVaultCode: input.sourceVaultCode,
      destinationCode: destCode,
      destinationType: input.destinationType,
    };
  }

  // ── Bank Balance Poll ─────────────────────────────────────────

  /**
   * Call the bank's API to fetch the real balance.
   * Returns the raw response from the bank API.
   * The caller decides whether to auto-credit based on the delta.
   */
  async pollBankBalance(connectorId: string): Promise<{
    connectorId: string;
    label: string;
    bankApiEndpoint: string;
    httpStatus: number;
    balance: string | null;
    currency: string;
    rawResponse: unknown;
    error: string | null;
    polledAt: string;
  }> {
    const connector = await this.requireConnector(connectorId);

    if (!connector.bankApiEndpoint) {
      throw new ValidationError("This connector has no bank API endpoint configured");
    }
    if (!connector.apiKey) {
      throw new ValidationError("This connector has no bank API key configured");
    }

    const decryptedKey = decryptSecret(connector.apiKey);
    const polledAt = new Date().toISOString();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(connector.bankApiEndpoint, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${decryptedKey}`,
          "x-api-key":     decryptedKey,
          "Accept":        "application/json",
          "Content-Type":  "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timer);
      const text = await response.text();

      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { parsed = text; }

      // Try to extract balance from common bank API response shapes
      const balance = this.extractBalance(parsed);

      logger.info(
        { connectorId, label: connector.label, status: response.status, balance },
        "Vault bank balance polled",
      );

      return {
        connectorId,
        label:           connector.label,
        bankApiEndpoint: connector.bankApiEndpoint,
        httpStatus:      response.status,
        balance,
        currency:        connector.currency,
        rawResponse:     parsed,
        error:           response.ok ? null : `HTTP ${response.status}`,
        polledAt,
      };
    } catch (error) {
      const message = error instanceof Error
        ? (error.name === "AbortError" ? "Request timed out after 15s" : error.message)
        : "Unknown error";

      logger.warn({ connectorId, error: message }, "Vault bank poll failed");

      return {
        connectorId,
        label:           connector.label,
        bankApiEndpoint: connector.bankApiEndpoint,
        httpStatus:      0,
        balance:         null,
        currency:        connector.currency,
        rawResponse:     null,
        error:           message,
        polledAt,
      };
    }
  }

  // ── Vault Ledger History ──────────────────────────────────────

  async listTransactions(filters: {
    vaultAccountCode?: string;
    page: number;
    pageSize: number;
  }) {
    const where: string[] = ["(e.source IN ('VAULT_RECEIVE','VAULT_PAYOUT','VAULT_CREDIT','VAULT_MOVE'))"];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.vaultAccountCode) {
      where.push(`(jl."accountCode" = $${idx++})`);
      params.push(filters.vaultAccountCode);
    }

    const offset = (filters.page - 1) * filters.pageSize;
    params.push(filters.pageSize, offset);

    const rows = await this.prisma.$queryRawUnsafe<VaultTxRow[]>(
      `SELECT e.id, e.reference, e."entryType", e.source, e.description,
              e.status, e.metadata, e."createdAt",
              e."postedBy",
              (SELECT SUM(l.debit)  FROM "JournalLine" l WHERE l."entryId" = e.id) AS "totalDebits",
              (SELECT SUM(l.credit) FROM "JournalLine" l WHERE l."entryId" = e.id) AS "totalCredits"
       FROM "JournalEntry" e
       ${where.length ? "LEFT JOIN \"JournalLine\" jl ON jl.\"entryId\" = e.id" : ""}
       WHERE ${where.join(" AND ")}
       GROUP BY e.id
       ORDER BY e."createdAt" DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      ...params,
    );

    return {
      data: rows,
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: rows.length,
        totalPages: Math.ceil(rows.length / filters.pageSize),
      },
    };
  }

  // ── Private Helpers ───────────────────────────────────────────

  private async ensureVaultAccounts(vaultCode: string, currency: string): Promise<void> {
    // Vault account (LIABILITY — holds the credited funds)
    await this.ensureAccount(vaultCode,
      `Vault: ${vaultCode}`, "ASSET", VAULT_SUBTYPE, currency);

    // Incoming funding account (ASSET — the debit side of inbound credits)
    await this.ensureAccount(`VAULT:INCOMING:${currency}`,
      `Vault Incoming (${currency})`, "ASSET", VAULT_INCOMING_SUBTYPE, currency);
  }

  private async ensureAccount(
    code: string, name: string,
    type: "ASSET" | "LIABILITY" | "REVENUE" | "EXPENSE" | "EQUITY",
    subtype: string, currency: string,
  ): Promise<void> {
    const existing = await this.prisma.account.findUnique({
      where: { code }, select: { code: true },
    });
    if (existing) return;
    try {
      await this.prisma.account.create({
        data: { code, name, type, subtype, currency, balance: 0 },
      });
    } catch {
      // Race condition — another request created it simultaneously
    }
  }

  private async getAccountBalance(code: string): Promise<string | null> {
    const rows = await this.prisma.$queryRawUnsafe<{ balance: string }[]>(
      `SELECT balance::text AS balance FROM "Account" WHERE code = $1 LIMIT 1`, code,
    );
    return rows[0]?.balance ?? null;
  }

  private async requireConnector(id: string): Promise<VaultConnectorRow> {
    const rows = await this.prisma.$queryRaw<VaultConnectorRow[]>`
      SELECT id, label, "vaultAccountCode", currency, "bankName",
             "accountNumber", "swiftCode", "accountHolder", country,
             "bankApiEndpoint", "apiKey", "apiKeyId",
             "pollingIntervalSeconds", "autoCreditEnabled",
             status, metadata, "createdAt", "updatedAt"
      FROM "VaultConnector" WHERE id = ${id} LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundError("Vault connector", id);
    return rows[0];
  }

  private resolveDestinationCode(input: VaultPayoutInput): string {
    switch (input.destinationType) {
      case "VAULT_ACCOUNT":
        return input.destinationCode;
      case "TERMINAL":
        return `TERMINAL-${input.destinationCode}-${input.currency}`;
      case "WALLET":
        return input.destinationCode;
      case "BANK_ACCOUNT":
        return `BANK:OUTGOING:${input.currency}`;
      case "S2S_SERVER":
        return `S2S:OUTGOING:${input.currency}`;
      default:
        return input.destinationCode;
    }
  }

  /**
   * Try to extract a balance value from common bank API response shapes.
   * Banks return balance in wildly different structures —
   * this covers the most common patterns.
   */
  private extractBalance(response: unknown): string | null {
    if (!response || typeof response !== "object") return null;
    const r = response as Record<string, unknown>;

    // Direct fields
    for (const key of ["balance", "availableBalance", "available_balance",
                        "ledgerBalance", "currentBalance", "amount",
                        "balanceAmount", "closingBalance"]) {
      if (r[key] !== undefined) return String(r[key]);
    }

    // Nested: data.balance, account.balance, accounts[0].balance
    if (r.data && typeof r.data === "object") {
      const inner = r.data as Record<string, unknown>;
      if (inner.balance !== undefined) return String(inner.balance);
      if (inner.availableBalance !== undefined) return String(inner.availableBalance);
    }
    if (r.account && typeof r.account === "object") {
      const inner = r.account as Record<string, unknown>;
      if (inner.balance !== undefined) return String(inner.balance);
    }
    if (Array.isArray(r.accounts) && r.accounts[0]) {
      const inner = r.accounts[0] as Record<string, unknown>;
      if (inner.balance !== undefined) return String(inner.balance);
    }

    return null;
  }
}

// ── Row Types ─────────────────────────────────────────────────────

export interface VaultConnectorRow {
  id: string;
  label: string;
  vaultAccountCode: string;
  currency: string;
  bankName: string;
  accountNumber: string;
  swiftCode: string | null;
  accountHolder: string;
  country: string;
  bankApiEndpoint: string | null;
  apiKey: string | null;        // encrypted — never expose
  apiKeyId: string | null;      // safe to expose
  pollingIntervalSeconds: number | null;
  autoCreditEnabled: boolean;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultTxRow {
  id: string;
  reference: string;
  entryType: string;
  source: string;
  description: string;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  postedBy: string | null;
  totalDebits: string | null;
  totalCredits: string | null;
}
