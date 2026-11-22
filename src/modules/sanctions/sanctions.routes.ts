import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "../../core/errors.js";
import { parsePagination, sendCreated, sendPaginated, sendSuccess } from "../../shared/utils/response.js";
import type { SanctionsEntityType, SanctionsListSource } from "./sanctions.types.js";
import { SanctionsService } from "./sanctions.service.js";

const ENTITY_TYPES: SanctionsEntityType[] = ["PERSON", "COMPANY", "BANK", "COUNTRY"];

/**
 * Sanctions screening routes.
 * Base path: /sanctions
 */
export function registerSanctionsRoutes(app: FastifyInstance, service: SanctionsService): void {
  /** Watchlist sources this deployment can screen against. */
  app.get("/sanctions/sources", async (_request: FastifyRequest, reply: FastifyReply) =>
    sendSuccess(reply, service.describeSources()),
  );

  /** Screen a party against every active watchlist entry of its entity type. */
  app.post("/sanctions/screen", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = body.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new ValidationError("name is required");
    }
    const entityType = readEntityType(body.entityType);

    const result = await service.screen({
      name,
      entityType,
      bankName: typeof body.bankName === "string" ? body.bankName : undefined,
      country: typeof body.country === "string" ? body.country : undefined,
      reference: typeof body.reference === "string" ? body.reference : undefined,
      threshold: typeof body.threshold === "number" ? body.threshold : undefined,
    });
    return sendCreated(reply, result);
  });

  /** Screening history, newest first. */
  app.get("/sanctions/screenings", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = parsePagination(query);
    const result = await service.listScreenings({
      status: query.status as string | undefined,
      entityType: query.entityType as string | undefined,
      name: query.name as string | undefined,
      page,
      pageSize,
    });
    return sendPaginated(reply, result.data, result.meta);
  });

  app.get("/sanctions/screenings/:reference", async (request: FastifyRequest, reply: FastifyReply) => {
    const { reference } = request.params as { reference: string };
    return sendSuccess(reply, await service.getScreening(reference));
  });

  /** Record a reviewer's decision on a screening. */
  app.post("/sanctions/screenings/:reference/review", async (request: FastifyRequest, reply: FastifyReply) => {
    const { reference } = request.params as { reference: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const status = body.status;
    if (status !== "CLEAR" && status !== "POTENTIAL_MATCH" && status !== "CONFIRMED_MATCH" && status !== "FALSE_POSITIVE") {
      throw new ValidationError("status must be CLEAR, POTENTIAL_MATCH, CONFIRMED_MATCH or FALSE_POSITIVE");
    }
    const reviewedBy = body.reviewedBy;
    if (typeof reviewedBy !== "string" || reviewedBy.trim() === "") {
      throw new ValidationError("reviewedBy is required");
    }
    const record = await service.review(reference, {
      status,
      reviewedBy,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return sendSuccess(reply, record);
  });

  /** Browse imported watchlist entries. */
  app.get("/sanctions/lists", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = parsePagination(query);
    const result = await service.listEntries({
      listSource: query.listSource as string | undefined,
      entityType: query.entityType as string | undefined,
      country: query.country as string | undefined,
      active: query.active === undefined ? undefined : String(query.active) !== "false",
      page,
      pageSize,
    });
    return sendPaginated(reply, result.data, result.meta);
  });

  /** Import (upsert) watchlist entries for one source. */
  app.post("/sanctions/lists/import", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const listSource = body.listSource;
    if (typeof listSource !== "string") {
      throw new ValidationError("listSource is required");
    }
    if (!Array.isArray(body.entries)) {
      throw new ValidationError("entries must be an array");
    }
    const result = await service.importEntries(
      listSource as SanctionsListSource,
      body.entries as never,
    );
    return sendCreated(reply, result);
  });
}

function readEntityType(value: unknown): SanctionsEntityType {
  if (typeof value === "string" && (ENTITY_TYPES as string[]).includes(value)) {
    return value as SanctionsEntityType;
  }
  throw new ValidationError(`entityType must be one of ${ENTITY_TYPES.join(", ")}`);
}
