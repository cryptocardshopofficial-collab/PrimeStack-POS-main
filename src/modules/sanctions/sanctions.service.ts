import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { generateReference } from "../../shared/utils/crypto.js";
import { screen } from "./sanctions.matcher.js";
import type {
  SanctionsCandidate,
  SanctionsEntityType,
  SanctionsListSource,
  SanctionsScreenInput,
  SanctionsScreenResult,
} from "./sanctions.types.js";

const LIST_SOURCES: SanctionsListSource[] = ["OFAC", "UN", "EU", "UK_HMT", "UAE_LOCAL", "INTERNAL"];
const ENTITY_TYPES: SanctionsEntityType[] = ["PERSON", "COMPANY", "BANK", "COUNTRY"];

/** Upper bound on watchlist rows compared in a single screen. */
const CANDIDATE_LIMIT = 10_000;

export interface SanctionsListEntryInput {
  entityType: SanctionsEntityType;
  primaryName: string;
  aliases?: string[];
  country?: string | null;
  bankName?: string | null;
  program?: string | null;
  /** The list's own id — supplying it makes re-imports idempotent. */
  listRef?: string | null;
  remarks?: string | null;
}

export interface SanctionsScreenRequest extends SanctionsScreenInput {
  /** Caller-supplied id so a retried screen updates the same record. */
  reference?: string;
  /** Override the default 85 match threshold. */
  threshold?: number;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Sanctions screening service.
 *
 * Watchlists are loaded by operators via {@link importEntries} — the platform
 * never ships list data, so a deployment can never screen against invented or
 * stale entries. Every screen is persisted with the score breakdown so a
 * reviewer can see exactly why a hit fired.
 */
export class SanctionsService {
  constructor(private prisma: PrismaClient) {}

  /** Supported watchlist sources and their jurisdiction. */
  describeSources() {
    return [
      { source: "OFAC" as const, name: "US Treasury OFAC SDN / Consolidated", jurisdiction: "United States" },
      { source: "UN" as const, name: "UN Security Council Consolidated List", jurisdiction: "United Nations" },
      { source: "EU" as const, name: "EU Consolidated Financial Sanctions List", jurisdiction: "European Union" },
      { source: "UK_HMT" as const, name: "UK HM Treasury Financial Sanctions List", jurisdiction: "United Kingdom" },
      { source: "UAE_LOCAL" as const, name: "UAE Local Terrorist List", jurisdiction: "United Arab Emirates" },
      { source: "INTERNAL" as const, name: "Platform internal watchlist", jurisdiction: "Internal" },
    ];
  }

  /** Import (upsert) watchlist entries for one source. */
  async importEntries(listSource: SanctionsListSource, entries: SanctionsListEntryInput[]) {
    if (!LIST_SOURCES.includes(listSource)) {
      throw new ValidationError(`listSource must be one of ${LIST_SOURCES.join(", ")}`);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ValidationError("entries must be a non-empty array");
    }

    let imported = 0;
    let skipped = 0;

    for (const entry of entries) {
      const primaryName = entry.primaryName?.trim();
      if (!primaryName || !ENTITY_TYPES.includes(entry.entityType)) {
        skipped++;
        continue;
      }
      const listRef = entry.listRef?.trim() || null;
      const data = {
        listSource,
        entityType: entry.entityType,
        primaryName,
        aliases: entry.aliases?.filter((a) => a && a.trim() !== "") ?? [],
        country: entry.country?.toUpperCase() ?? null,
        bankName: entry.bankName ?? null,
        program: entry.program ?? null,
        listRef,
        remarks: entry.remarks ?? null,
      };

      if (listRef) {
        await this.prisma.sanctionsListEntry.upsert({
          where: { listSource_listRef: { listSource, listRef } },
          create: data,
          update: data,
        });
      } else {
        await this.prisma.sanctionsListEntry.create({ data });
      }
      imported++;
    }

    return { listSource, imported, skipped };
  }

  /** Paginated watchlist entries. */
  async listEntries(filters: {
    listSource?: string;
    entityType?: string;
    country?: string;
    active?: boolean;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.SanctionsListEntryWhereInput = {};
    if (filters.listSource) where.listSource = filters.listSource as never;
    if (filters.entityType) where.entityType = filters.entityType as never;
    if (filters.country) where.country = filters.country.toUpperCase();
    if (typeof filters.active === "boolean") where.active = filters.active;

    const [data, total] = await Promise.all([
      this.prisma.sanctionsListEntry.findMany({
        where,
        orderBy: [{ listSource: "asc" }, { primaryName: "asc" }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.sanctionsListEntry.count({ where }),
    ]);

    return {
      data,
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  /** Screen one party and persist the outcome. */
  async screen(input: SanctionsScreenRequest): Promise<
    SanctionsScreenResult & { reference: string; screeningId: string; createdAt: Date }
  > {
    if (!input.name || input.name.trim() === "") {
      throw new ValidationError("name is required");
    }
    if (!ENTITY_TYPES.includes(input.entityType)) {
      throw new ValidationError(`entityType must be one of ${ENTITY_TYPES.join(", ")}`);
    }

    const candidates = await this.loadCandidates(input);
    const result = screen(input, candidates, { threshold: input.threshold });

    const reference = input.reference?.trim() || generateReference("SANC");
    const matchDetail = result.matchDetail === null
      ? Prisma.JsonNull
      : (result.matchDetail as unknown as Prisma.InputJsonValue);

    const data = {
      entityType: input.entityType,
      inputName: input.name.trim(),
      inputCountry: input.country?.toUpperCase() ?? null,
      bankName: input.bankName ?? null,
      status: result.status,
      score: result.score,
      matchedEntryId: result.matchedEntryId,
      matchedName: result.matchedName,
      matchedList: result.matchedList,
      matchDetail,
      metadata: input.metadata ?? Prisma.JsonNull,
    };

    const record = await this.prisma.sanctionsScreening.upsert({
      where: { reference },
      create: { reference, ...data },
      update: data,
    });

    return { reference, screeningId: record.id, createdAt: record.createdAt, ...result };
  }

  async getScreening(reference: string) {
    const record = await this.prisma.sanctionsScreening.findUnique({ where: { reference } });
    if (!record) throw new NotFoundError("Sanctions screening", reference);
    return record;
  }

  async listScreenings(filters: {
    status?: string;
    entityType?: string;
    name?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.SanctionsScreeningWhereInput = {};
    if (filters.status) where.status = filters.status as never;
    if (filters.entityType) where.entityType = filters.entityType as never;
    if (filters.name) where.inputName = { contains: filters.name, mode: "insensitive" };

    const [data, total] = await Promise.all([
      this.prisma.sanctionsScreening.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.sanctionsScreening.count({ where }),
    ]);

    return {
      data,
      meta: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  /** Record a human decision on a screening (clear, confirm or dismiss). */
  async review(
    reference: string,
    input: { status: "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH" | "FALSE_POSITIVE"; reviewedBy: string; notes?: string },
  ) {
    const existing = await this.prisma.sanctionsScreening.findUnique({ where: { reference } });
    if (!existing) throw new NotFoundError("Sanctions screening", reference);
    if (!input.reviewedBy || input.reviewedBy.trim() === "") {
      throw new ValidationError("reviewedBy is required");
    }

    return this.prisma.sanctionsScreening.update({
      where: { reference },
      data: {
        status: input.status,
        reviewedBy: input.reviewedBy.trim(),
        reviewedAt: new Date(),
        reviewNotes: input.notes ?? null,
      },
    });
  }

  /**
   * Load the watchlist rows to compare against. Filtered by entity type — a
   * person is not screened against country entries — then capped so a single
   * screen can never scan an unbounded list.
   */
  private async loadCandidates(input: SanctionsScreenInput): Promise<SanctionsCandidate[]> {
    const rows = await this.prisma.sanctionsListEntry.findMany({
      where: { active: true, entityType: input.entityType as never },
      orderBy: { primaryName: "asc" },
      take: CANDIDATE_LIMIT,
    });

    return rows.map((row) => ({
      id: row.id,
      listSource: row.listSource as SanctionsListSource,
      entityType: row.entityType as SanctionsEntityType,
      primaryName: row.primaryName,
      aliases: row.aliases,
      country: row.country,
      bankName: row.bankName,
    }));
  }
}
