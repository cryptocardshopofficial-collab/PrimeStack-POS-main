/**
 * Sanctions screening types.
 *
 * Screening compares a party (person, company, bank or country) against
 * watchlist entries imported from OFAC, UN, EU, UK HMT and UAE local lists,
 * plus the platform's own INTERNAL list.
 */

export type SanctionsListSource =
  | "OFAC"
  | "UN"
  | "EU"
  | "UK_HMT"
  | "UAE_LOCAL"
  | "INTERNAL";

export type SanctionsEntityType = "PERSON" | "COMPANY" | "BANK" | "COUNTRY";

export type SanctionsScreeningStatus =
  | "CLEAR"
  | "POTENTIAL_MATCH"
  | "CONFIRMED_MATCH"
  | "FALSE_POSITIVE";

/** A watchlist row, shaped for the pure matching engine. */
export interface SanctionsCandidate {
  id: string;
  listSource: SanctionsListSource;
  entityType: SanctionsEntityType;
  primaryName: string;
  aliases: string[];
  country: string | null;
  /** For bank entries: the institution's trading name, compared separately. */
  bankName: string | null;
}

export interface SanctionsScreenInput {
  /** The party name to screen. */
  name: string;
  entityType: SanctionsEntityType;
  /** Optional institution name — raises confidence when it also matches. */
  bankName?: string | null;
  /** Optional ISO 3166 alpha-2 country — a mismatch lowers confidence. */
  country?: string | null;
}

/** How a score was arrived at. Stored on the screening record for audit. */
export interface SanctionsMatchDetail {
  candidateId: string;
  listSource: SanctionsListSource;
  entityType: SanctionsEntityType;
  primaryName: string;
  /** The candidate name (primary or alias) that produced the best score. */
  matchedOn: string;
  /** 0–100 name similarity. */
  nameScore: number;
  /** 0–100 institution-name similarity, or null when not comparable. */
  bankScore: number | null;
  /** null when either side omitted a country. */
  countryMatch: boolean | null;
  /** The combined 0–100 score used for the decision. */
  score: number;
}

export interface SanctionsScreenResult {
  status: Extract<SanctionsScreeningStatus, "CLEAR" | "POTENTIAL_MATCH">;
  score: number;
  threshold: number;
  matchedEntryId: string | null;
  matchedName: string | null;
  matchedList: SanctionsListSource | null;
  /** Breakdown for the best-scoring candidate; null only when none were evaluated. */
  matchDetail: SanctionsMatchDetail | null;
  /** Number of watchlist rows compared — useful for tuning. */
  candidatesEvaluated: number;
}
