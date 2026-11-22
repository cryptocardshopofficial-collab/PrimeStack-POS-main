import { z } from "zod";

/**
 * SUPE — Secure Upload Processing Engine types.
 *
 * Two responsibilities live here:
 *  1. Inbound  — parse an incoming fund document and credit the ledger.
 *  2. Outbound — the bank-grade settlement/transmission service: build a
 *     settlement instruction from ledger data and transmit it to a bank in a
 *     format the bank accepts, tracking the bank validation/execution
 *     lifecycle (DRAFT → SUBMITTED → ACCEPTED → EXECUTED).
 *
 * This file holds the Zod schemas + derived types for the outbound flow.
 */

// ── Constants / allow-lists ──────────────────────

export const SUPE_SETTLEMENT_FORMATS = ["ISO_20022", "CSV", "JSON"] as const;
export type SupeSettlementFormat = (typeof SUPE_SETTLEMENT_FORMATS)[number];

export const SUPE_TRANSMISSION_CHANNELS = ["BANK_API", "SFTP", "FILE_UPLOAD", "MANUAL"] as const;
export type SupeTransmissionChannel = (typeof SUPE_TRANSMISSION_CHANNELS)[number];

export const SUPE_INSTRUCTION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "ACCEPTED",
  "EXECUTED",
  "REJECTED",
  "CANCELLED",
] as const;
export type SupeInstructionStatus = (typeof SUPE_INSTRUCTION_STATUSES)[number];

/** The outbound side accepts a small, explicit currency allow-list. */
export const SUPE_OUTBOUND_CURRENCIES = ["USD", "EUR", "GBP", "AED", "SAR", "SGD", "JPY", "CHF"] as const;

// ── Shared field validators ─────────────────────

const xmlText = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(xmlText, "Control characters are not allowed");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(xmlText, "Control characters are not allowed")
    .optional();

/** ISO 3166-1 alpha-2 country code. */
const countryCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, "Enter a valid 2-letter country code"));

/** ISO 4217 currency, restricted to the outbound allow-list. */
const currencyCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.enum(SUPE_OUTBOUND_CURRENCIES));

function hasValidIbanChecksum(value: string): boolean {
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits =
      character >= "A" && character <= "Z"
        ? String(character.charCodeAt(0) - 55)
        : character;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

const iban = z
  .string()
  .transform((v) => v.replace(/\s+/g, "").toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, "Enter a valid IBAN"))
  .refine(hasValidIbanChecksum, "IBAN checksum is invalid");

const bic = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(
    z.string().regex(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/, "Enter an 8- or 11-character BIC"),
  );

/** Positive decimal amount, no separators, up to 18 integer / 4 fractional digits. */
const amount = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d{0,17})(?:\.\d{1,4})?$/,
    "Amount must be positive, without separators, and have at most 18 integer and 4 decimal digits",
  )
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }, "Enter a valid date (YYYY-MM-DD)");

// ── Party (debtor / creditor) ────────────────────

export const supePartySchema = z.object({
  name: text(140),
  iban,
  agentBic: bic,
  agentName: optionalText(140),
  streetName: optionalText(70),
  buildingNumber: optionalText(16),
  postalCode: optionalText(16),
  townName: optionalText(35),
  country: countryCode,
});

export type SupeParty = z.infer<typeof supePartySchema>;

// ── Create settlement instruction ────────────────

export const createInstructionSchema = z
  .object({
    format: z.enum(SUPE_SETTLEMENT_FORMATS),
    channel: z.enum(SUPE_TRANSMISSION_CHANNELS),
    amount: amount.optional(),
    currency: currencyCode,
    valueDate: isoDate.optional(),
    endToEndId: z
      .string()
      .trim()
      .max(35)
      .regex(/^[A-Za-z0-9?/\-:.()+,' ]*$/)
      .optional(),
    debtor: supePartySchema,
    creditor: supePartySchema,
    remittanceInformation: optionalText(140),
    /** Ledger entries this instruction settles. Used as provenance and, when
     *  `amount` is omitted, to derive the amount from the ledger. */
    sourceJournalRefs: z.array(z.string().min(1)).max(100).optional(),
    /** For BANK_API channel: override the configured bank endpoint. */
    bankApiUrl: z.string().url().optional(),
  })
  .refine((d) => d.amount || (d.sourceJournalRefs && d.sourceJournalRefs.length > 0), {
    message: "Either an explicit amount or sourceJournalRefs is required",
    path: ["amount"],
  });

export type CreateInstructionInput = z.infer<typeof createInstructionSchema>;

// ── Transmit ─────────────────────────────────────

export const transmitInstructionSchema = z.object({
  /** For BANK_API only: override the configured bank endpoint. */
  bankApiUrl: z.string().url().optional(),
  /** Bearer/API key to send to the bank (overrides config). */
  bankApiKey: z.string().min(1).optional(),
});

export type TransmitInstructionInput = z.infer<typeof transmitInstructionSchema>;

// ── Bank callback (accept / reject / execute) ───

export const bankCallbackSchema = z
  .object({
    status: z.enum(["ACCEPTED", "REJECTED", "EXECUTED"]),
    bankTransactionRef: z.string().trim().max(200).optional(),
    rejectionReason: z.string().trim().max(500).optional(),
    response: z.record(z.unknown()).optional(),
  })
  .refine(
    (d) => d.status !== "REJECTED" || !!d.rejectionReason,
    { message: "rejectionReason is required when status is REJECTED", path: ["rejectionReason"] },
  )
  .refine(
    (d) => d.status !== "EXECUTED" || !!d.bankTransactionRef,
    { message: "bankTransactionRef is required when status is EXECUTED", path: ["bankTransactionRef"] },
  );

export type BankCallbackInput = z.infer<typeof bankCallbackSchema>;

// ── Manual reject ────────────────────────────────

export const rejectInstructionSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export type RejectInstructionInput = z.infer<typeof rejectInstructionSchema>;

// ── Manual execution confirmation ───────────────

export const confirmExecutionSchema = z.object({
  bankTransactionRef: z.string().trim().min(1).max(200),
});

export type ConfirmExecutionInput = z.infer<typeof confirmExecutionSchema>;

// ── List filters ─────────────────────────────────

export const listInstructionsSchema = z.object({
  status: z.enum(SUPE_INSTRUCTION_STATUSES).optional(),
  currency: z.string().trim().toUpperCase().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListInstructionsInput = z.infer<typeof listInstructionsSchema>;

// ── Inbound bank-feed confirmation ───────────────

export const SUPE_INBOUND_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "CREDITED",
  "REJECTED",
] as const;
export type SupeInboundStatus = (typeof SUPE_INBOUND_STATUSES)[number];

export const listInboundPaymentsSchema = z.object({
  status: z.enum(SUPE_INBOUND_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListInboundPaymentsInput = z.infer<typeof listInboundPaymentsSchema>;
