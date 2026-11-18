import { Prisma, type PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import type {
  RegisterTerminalInput,
  UpdateTerminalInput,
  UpdateHealthInput,
  RemoteCommandInput,
} from "./types.js";

/**
 * Terminal Service
 *
 * Manages the lifecycle of payment terminals:
 *   - Registration and provisioning
 *   - Health monitoring (heartbeats, resource usage)
 *   - Remote commands (reboot, config push, key injection)
 *   - EMV parameter management
 *   - Firmware versioning
 */

export const TERMINAL_ACCOUNT_SUBTYPE = "TERMINAL";
export const DEFAULT_TERMINAL_CURRENCIES = ["USD"] as const;

/**
 * Terminal float is owed to the terminal's owner, so the account is a
 * LIABILITY: a credit (funds received) raises the balance and a debit (funds
 * sent) lowers it. This matches both the ledger engine's balance rules and the
 * raw balance updates T2T transfers perform.
 */
export function terminalAccountCode(tid: string, currency: string): string {
  return `TERMINAL-${tid}-${currency.toUpperCase()}`;
}

export function normalizeTerminalCurrencies(
  currencies: readonly string[] | undefined,
): string[] {
  const list = currencies?.length ? currencies : DEFAULT_TERMINAL_CURRENCIES;
  const normalized = list.map((currency) => currency.trim().toUpperCase());
  return [...new Set(normalized)];
}

/** Reads the currency list a terminal was registered for. */
export function configuredTerminalCurrencies(
  config: Prisma.JsonValue | null | undefined,
): string[] {
  const raw = (config as Record<string, unknown> | null)?.currencies;
  const currencies = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : undefined;
  return normalizeTerminalCurrencies(currencies);
}

/**
 * Creates the receiving account for a terminal currency on first use. A
 * concurrent registration may win the race, so a unique-code violation is
 * treated as success.
 */
export async function ensureTerminalAccount(
  db: PrismaClient,
  tid: string,
  currency: string,
): Promise<string> {
  const normalizedCurrency = currency.trim().toUpperCase();
  const code = terminalAccountCode(tid, normalizedCurrency);
  const existing = await db.account.findUnique({
    where: { code },
    select: { code: true },
  });
  if (existing) return existing.code;

  try {
    await db.account.create({
      data: {
        code,
        name: `Terminal Account: ${tid} (${normalizedCurrency})`,
        type: "LIABILITY",
        subtype: TERMINAL_ACCOUNT_SUBTYPE,
        currency: normalizedCurrency,
      },
    });
  } catch (error) {
    const created = await db.account.findUnique({
      where: { code },
      select: { code: true },
    });
    if (!created) throw error;
    return created.code;
  }

  logger.info({ tid, code }, "Terminal receiving account provisioned");
  return code;
}

export class TerminalService {
  constructor(private prisma: PrismaClient) {}

  // ── Terminal CRUD ────────────────────────────────

  async registerTerminal(input: RegisterTerminalInput) {
    // Check for duplicate TID or serial number
    const existing = await this.prisma.terminal.findFirst({
      where: {
        OR: [{ tid: input.tid }, { serialNumber: input.serialNumber }],
      },
    });
    if (existing) {
      throw new ConflictError("Terminal with this TID or serial number already exists");
    }

    // Verify merchant exists
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: input.merchantId },
    });
    if (!merchant) {
      throw new NotFoundError("Merchant", input.merchantId);
    }

    const currencies = normalizeTerminalCurrencies(input.currencies);

    const terminal = await this.prisma.terminal.create({
      data: {
        tid: input.tid,
        mid: input.mid,
        serialNumber: input.serialNumber,
        merchantId: input.merchantId,
        model: input.model,
        osVersion: input.osVersion,
        firmwareVersion: input.firmwareVersion,
        location: input.location,
        city: input.city,
        country: input.country,
        timezone: input.timezone,
        status: "REGISTERED",
        config: {
          ...(input.config ?? {}),
          currencies,
        } as Prisma.InputJsonValue,
      },
      include: { merchant: true },
    });

    // Create initial health record
    await this.prisma.terminalHealth.create({
      data: {
        terminalId: terminal.id,
        status: "OFFLINE",
      },
    });

    // Receiving accounts are provisioned up front: a transfer to this terminal
    // fails until its currency accounts exist, and activation must not be the
    // only path that creates them.
    for (const currency of currencies) {
      await ensureTerminalAccount(this.prisma, terminal.tid, currency);
    }

    logger.info({ terminalId: terminal.id, tid: terminal.tid, merchantId: input.merchantId }, "Terminal registered");
    return terminal;
  }

  async getTerminal(id: string) {
    const terminal = await this.prisma.terminal.findUnique({
      where: { id },
      include: { merchant: true, health: true },
    });

    if (!terminal) {
      throw new NotFoundError("Terminal", id);
    }

    return terminal;
  }

  async getTerminalByTid(tid: string) {
    const terminal = await this.prisma.terminal.findUnique({
      where: { tid },
      include: { merchant: true, health: true },
    });

    if (!terminal) {
      throw new NotFoundError("Terminal", tid);
    }

    return terminal;
  }

  async listTerminals(filters: {
    merchantId?: string;
    status?: string;
    country?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.TerminalWhereInput = {};
    if (filters.merchantId) where.merchantId = filters.merchantId;
    if (filters.status) where.status = filters.status as never;
    if (filters.country) where.country = filters.country;

    const [terminals, total] = await Promise.all([
      this.prisma.terminal.findMany({
        where,
        include: { merchant: { select: { code: true, legalName: true } }, health: true },
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.terminal.count({ where }),
    ]);

    return {
      data: terminals,
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  async updateTerminal(id: string, input: UpdateTerminalInput) {
    const terminal = await this.prisma.terminal.findUnique({ where: { id } });
    if (!terminal) {
      throw new NotFoundError("Terminal", id);
    }

    const currencies = input.currencies
      ? normalizeTerminalCurrencies(input.currencies)
      : configuredTerminalCurrencies(terminal.config);
    const existingConfig = (terminal.config as Record<string, unknown> | null) ?? {};

    const updated = await this.prisma.terminal.update({
      where: { id },
      data: {
        model: input.model,
        osVersion: input.osVersion,
        firmwareVersion: input.firmwareVersion,
        location: input.location,
        city: input.city,
        country: input.country,
        timezone: input.timezone,
        status: input.status as never,
        config: {
          ...existingConfig,
          ...(input.config ?? {}),
          currencies,
        } as Prisma.InputJsonValue,
        ...(input.status === "DECOMMISSIONED" ? { deactivatedAt: new Date() } : {}),
      },
      include: { merchant: true },
    });

    // Activating a terminal means it can now receive funds, so every configured
    // currency needs a receiving account before any transfer can land.
    if (input.status === "ACTIVE") {
      for (const currency of currencies) {
        await ensureTerminalAccount(this.prisma, updated.tid, currency);
      }
    }

    logger.info({ terminalId: id, status: input.status }, "Terminal updated");
    return updated;
  }

  async deleteTerminal(id: string) {
    const terminal = await this.prisma.terminal.findUnique({ where: { id } });
    if (!terminal) {
      throw new NotFoundError("Terminal", id);
    }

    // Soft delete — decommission instead of hard delete
    await this.prisma.terminal.update({
      where: { id },
      data: {
        status: "DECOMMISSIONED",
        deactivatedAt: new Date(),
      },
    });

    logger.info({ terminalId: id }, "Terminal decommissioned");
    return { id, status: "DECOMMISSIONED" };
  }

  // ── Terminal Health ──────────────────────────────

  async updateHealth(terminalId: string, input: UpdateHealthInput) {
    const terminal = await this.prisma.terminal.findUnique({
      where: { id: terminalId },
    });
    if (!terminal) {
      throw new NotFoundError("Terminal", terminalId);
    }

    // Upsert health record
    const health = await this.prisma.terminalHealth.upsert({
      where: { terminalId },
      update: {
        status: input.status as never,
        heartbeatAt: new Date(),
        cpuUsage: input.cpuUsage,
        memoryUsage: input.memoryUsage,
        diskUsage: input.diskUsage,
        temperature: input.temperature,
        batteryLevel: input.batteryLevel,
        networkLatencyMs: input.networkLatencyMs,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        lastCheckedAt: new Date(),
      },
      create: {
        terminalId,
        status: input.status as never,
        heartbeatAt: new Date(),
        cpuUsage: input.cpuUsage,
        memoryUsage: input.memoryUsage,
        diskUsage: input.diskUsage,
        temperature: input.temperature,
        batteryLevel: input.batteryLevel,
        networkLatencyMs: input.networkLatencyMs,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        lastCheckedAt: new Date(),
      },
    });

    // Update terminal's lastSeenAt
    await this.prisma.terminal.update({
      where: { id: terminalId },
      data: { lastSeenAt: new Date() },
    });

    logger.debug({ terminalId, status: input.status }, "Terminal health updated");
    return health;
  }

  async getHealth(terminalId: string) {
    const health = await this.prisma.terminalHealth.findUnique({
      where: { terminalId },
    });

    if (!health) {
      throw new NotFoundError("Terminal health", terminalId);
    }

    return health;
  }

  async listTerminalsByStatus(status: string) {
    return this.prisma.terminal.findMany({
      where: { status: status as never },
      include: { health: true, merchant: { select: { code: true, legalName: true } } },
      orderBy: { lastSeenAt: "desc" },
    });
  }

  // ── Remote Commands ──────────────────────────────

  async sendCommand(input: RemoteCommandInput) {
    const terminal = await this.prisma.terminal.findUnique({
      where: { id: input.terminalId },
    });
    if (!terminal) {
      throw new NotFoundError("Terminal", input.terminalId);
    }

    const command = await this.prisma.remoteCommand.create({
      data: {
        terminalId: input.terminalId,
        command: input.command,
        payload: input.payload as Prisma.InputJsonValue | undefined,
        status: "PENDING",
        expiresAt: new Date(Date.now() + input.expiresInMinutes * 60 * 1000),
      },
    });

    logger.info({ terminalId: input.terminalId, command: input.command, commandId: command.id }, "Remote command queued");
    return command;
  }

  async getPendingCommands(terminalId: string) {
    const terminal = await this.prisma.terminal.findUnique({
      where: { id: terminalId },
    });
    if (!terminal) {
      throw new NotFoundError("Terminal", terminalId);
    }

    return this.prisma.remoteCommand.findMany({
      where: {
        terminalId,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async ackCommand(commandId: string) {
    const command = await this.prisma.remoteCommand.findUnique({
      where: { id: commandId },
    });
    if (!command) {
      throw new NotFoundError("Remote command", commandId);
    }

    return this.prisma.remoteCommand.update({
      where: { id: commandId },
      data: {
        status: "ACK",
        ackedAt: new Date(),
        sentAt: command.sentAt ?? new Date(),
      },
    });
  }

  // ── EMV Parameters ──────────────────────────────

  async setEmvParameter(terminalId: string, aid: string, label: string, version?: string, config?: Record<string, unknown>) {
    return this.prisma.emvParameter.upsert({
      where: { terminalId_aid: { terminalId, aid } },
      update: {
        label,
        version,
        config: config as Prisma.InputJsonValue | undefined,
      },
      create: {
        terminalId,
        aid,
        label,
        version,
        config: config as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async getEmvParameters(terminalId: string) {
    return this.prisma.emvParameter.findMany({
      where: { terminalId },
    });
  }

  // ── Firmware Management ─────────────────────────

  async registerFirmwareVersion(input: {
    version: string;
    model: string;
    checksum: string;
    downloadUrl?: string;
    sizeBytes: number;
    releaseNotes?: string;
  }) {
    return this.prisma.firmwareVersion.create({
      data: {
        version: input.version,
        model: input.model,
        checksum: input.checksum,
        downloadUrl: input.downloadUrl,
        sizeBytes: input.sizeBytes,
        releaseNotes: input.releaseNotes,
      },
    });
  }

  async listFirmwareVersions(model?: string) {
    const where: Prisma.FirmwareVersionWhereInput = {};
    if (model) where.model = model;

    return this.prisma.firmwareVersion.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
  }
}
