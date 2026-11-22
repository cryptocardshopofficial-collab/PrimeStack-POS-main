import type {
  SanctionsCandidate,
  SanctionsMatchDetail,
  SanctionsScreenInput,
  SanctionsScreenResult,
} from "./sanctions.types.js";

/**
 * Sanctions name-matching engine (pure functions, no I/O).
 *
 * Similarity combines three signals:
 *   - Jaro-Winkler on the whole normalised name (rewards shared prefixes),
 *   - Jaro-Winkler on order-insensitive token strings,
 *   - a token-set (Jaccard) ratio that tolerates inserted/missing words.
 *
 * Legal suffixes are stripped before comparison so "ACME GMBH" and "ACME"
 * score as the same entity, while keeping the check conservative enough that
 * unrelated names do not collide.
 */

const DEFAULT_THRESHOLD = 85;

/**
 * Corporate suffixes that carry no identifying weight. Only true legal-form
 * designators are stripped — generic words like "GROUP" or "TRADING" are kept,
 * because dropping them would make unrelated names collide.
 */
const LEGAL_SUFFIXES = new Set([
  "LTD", "LIMITED", "LLC", "LLP", "LP", "INC", "INCORPORATED", "CO", "COMPANY",
  "CORP", "CORPORATION", "GMBH", "AG", "KG", "SA", "SAS", "SARL", "SAR", "PLC",
  "PTE", "PTY", "BV", "NV", "AB", "AS", "OY", "SPA", "SRL", "SL", "SRO",
]);

/** Strip diacritics/punctuation and uppercase, so comparison is script-safe. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalised tokens with legal suffixes removed — empty tokens dropped. */
export function nameTokens(value: string): string[] {
  return normalizeName(value)
    .split(" ")
    .filter((token) => token !== "" && !LEGAL_SUFFIXES.has(token));
}

/** Jaro similarity (0–1). */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aFlags: boolean[] = new Array<boolean>(la).fill(false);
  const bFlags: boolean[] = new Array<boolean>(lb).fill(false);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, lb);
    for (let j = start; j < end; j++) {
      if (bFlags[j] || a[i] !== b[j]) continue;
      aFlags[i] = true;
      bFlags[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aFlags[i]) continue;
    while (!bFlags[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const t = transpositions / 2;
  return (matches / la + matches / lb + (matches - t) / matches) / 3;
}

/** Jaro-Winkler similarity (0–1), boosting a shared prefix of up to 4 chars. */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  if (j === 0) return 0;
  const max = Math.min(4, a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

/** Token-set (Jaccard) similarity over normalised tokens. */
export function tokenSetRatio(aTokens: string[], bTokens: string[]): number {
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Best-case name similarity (0–1) across whole-name, sorted-token and token-set views. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === "" || nb === "") return 0;
  if (na === nb) return 1;

  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  const sortedA = [...tokensA].sort().join(" ");
  const sortedB = [...tokensB].sort().join(" ");

  return Math.max(
    jaroWinkler(na, nb),
    jaroWinkler(sortedA, sortedB),
    tokenSetRatio(tokensA, tokensB),
  );
}

/** Score one candidate against the screening input. */
export function scoreCandidate(
  input: SanctionsScreenInput,
  candidate: SanctionsCandidate,
): SanctionsMatchDetail {
  const names = [candidate.primaryName, ...candidate.aliases].filter((n) => n && n.trim() !== "");

  let bestName = 0;
  let matchedOn = candidate.primaryName;
  for (const name of names) {
    const similarity = nameSimilarity(input.name, name);
    if (similarity > bestName) {
      bestName = similarity;
      matchedOn = name;
    }
  }

  let bankScore: number | null = null;
  if (input.bankName && candidate.bankName) {
    bankScore = nameSimilarity(input.bankName, candidate.bankName);
  }

  const namePart = bankScore === null ? bestName : bestName * 0.85 + bankScore * 0.15;

  let countryMatch: boolean | null = null;
  if (input.country && candidate.country) {
    countryMatch = input.country.trim().toUpperCase() === candidate.country.trim().toUpperCase();
  }

  let score = Math.round(namePart * 100);
  if (countryMatch === true) score = Math.min(100, score + 5);
  else if (countryMatch === false) score = Math.round(score * 0.6);

  return {
    candidateId: candidate.id,
    listSource: candidate.listSource,
    entityType: candidate.entityType,
    primaryName: candidate.primaryName,
    matchedOn,
    nameScore: Math.round(bestName * 100),
    bankScore: bankScore === null ? null : Math.round(bankScore * 100),
    countryMatch,
    score,
  };
}

/**
 * Screen an input against a candidate set. Returns the best-scoring candidate
 * when it clears the threshold, otherwise CLEAR. The score breakdown is always
 * returned (when any candidate was evaluated) so operators can see how close a
 * near-miss was — only the `matched*` fields are gated by the threshold.
 */
export function screen(
  input: SanctionsScreenInput,
  candidates: SanctionsCandidate[],
  options: { threshold?: number } = {},
): SanctionsScreenResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  let best: SanctionsMatchDetail | null = null;
  for (const candidate of candidates) {
    const detail = scoreCandidate(input, candidate);
    if (!best || detail.score > best.score) best = detail;
  }

  const match = best && best.score >= threshold ? best : null;

  return {
    status: match ? "POTENTIAL_MATCH" : "CLEAR",
    score: best?.score ?? 0,
    threshold,
    matchedEntryId: match?.candidateId ?? null,
    matchedName: match?.primaryName ?? null,
    matchedList: match?.listSource ?? null,
    matchDetail: best,
    candidatesEvaluated: candidates.length,
  };
}
