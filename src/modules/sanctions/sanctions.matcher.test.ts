import { describe, expect, it } from "vitest";
import {
  jaro,
  jaroWinkler,
  nameSimilarity,
  nameTokens,
  normalizeName,
  screen,
} from "./sanctions.matcher.js";
import type { SanctionsCandidate } from "./sanctions.types.js";

/** All names below are invented; none refers to a real person or company. */

function candidate(
  overrides: Partial<SanctionsCandidate> & { id: string; primaryName: string },
): SanctionsCandidate {
  return {
    listSource: "OFAC",
    entityType: "PERSON",
    aliases: [],
    country: null,
    bankName: null,
    ...overrides,
  };
}

describe("normalizeName", () => {
  it("strips diacritics, punctuation and case", () => {
    expect(normalizeName("José  O'Brien-López")).toBe("JOSE O BRIEN LOPEZ");
  });

  it("drops corporate suffixes when tokenising", () => {
    expect(nameTokens("ACME TRADING GMBH")).toEqual(["ACME", "TRADING"]);
    expect(nameTokens("Beta Holdings PLC")).toEqual(["BETA", "HOLDINGS"]);
  });
});

describe("jaro / jaroWinkler", () => {
  it("returns 1 for identical strings and 0 when one side is empty", () => {
    expect(jaro("SAME", "SAME")).toBe(1);
    expect(jaro("SAME", "")).toBe(0);
  });

  it("scores a transposition highly", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeGreaterThan(0.9);
  });
});

describe("nameSimilarity", () => {
  it("is order-insensitive", () => {
    expect(nameSimilarity("DOE JOHN", "JOHN DOE")).toBe(1);
  });

  it("treats punctuation and legal suffixes as noise", () => {
    expect(nameSimilarity("AL-RASHID TRADING CO", "Al Rashid Trading")).toBe(1);
  });

  it("keeps unrelated names apart", () => {
    expect(nameSimilarity("JOHN DOE", "GAMMA INDUSTRIES")).toBeLessThan(0.6);
  });
});

describe("screen", () => {
  it("flags an exact watchlist hit as POTENTIAL_MATCH", () => {
    const result = screen(
      { name: "IVAN PETROV", entityType: "PERSON" },
      [candidate({ id: "e1", primaryName: "IVAN PETROV", listSource: "EU", country: "RU" })],
    );

    expect(result.status).toBe("POTENTIAL_MATCH");
    expect(result.score).toBe(100);
    expect(result.matchedEntryId).toBe("e1");
    expect(result.matchedList).toBe("EU");
    expect(result.matchDetail?.countryMatch).toBeNull();
  });

  it("matches an alias rather than the primary name", () => {
    const result = screen(
      { name: "BETA", entityType: "COMPANY" },
      [
        candidate({
          id: "e2",
          primaryName: "GAMMA INDUSTRIES",
          aliases: ["BETA GROUP"],
          entityType: "COMPANY",
        }),
      ],
    );

    expect(result.status).toBe("POTENTIAL_MATCH");
    expect(result.matchDetail?.matchedOn).toBe("BETA GROUP");
  });

  it("returns CLEAR when nothing clears the threshold", () => {
    const result = screen(
      { name: "JOHN DOE", entityType: "PERSON" },
      [candidate({ id: "e3", primaryName: "GAMMA INDUSTRIES" })],
    );

    expect(result.status).toBe("CLEAR");
    expect(result.matchedEntryId).toBeNull();
    expect(result.matchedName).toBeNull();
    expect(result.matchedList).toBeNull();
    expect(result.candidatesEvaluated).toBe(1);
    // The near-miss breakdown is still exposed for the audit trail.
    expect(result.matchDetail?.candidateId).toBe("e3");
  });

  it("lowers the score when the country contradicts the entry", () => {
    const same = screen(
      { name: "IVAN PETROV", entityType: "PERSON", country: "RU" },
      [candidate({ id: "e4", primaryName: "IVAN PETROV", country: "RU" })],
    );
    const conflicting = screen(
      { name: "IVAN PETROV", entityType: "PERSON", country: "DE" },
      [candidate({ id: "e5", primaryName: "IVAN PETROV", country: "RU" })],
    );

    expect(same.status).toBe("POTENTIAL_MATCH");
    expect(conflicting.score).toBeLessThan(same.score);
    expect(conflicting.matchDetail?.countryMatch).toBe(false);
    expect(conflicting.status).toBe("CLEAR");
  });

  it("combines the institution name into the score", () => {
    const result = screen(
      { name: "BANK OF EXAMPLE", entityType: "BANK", bankName: "EXAMPLE BANK" },
      [
        candidate({
          id: "e6",
          primaryName: "BANK OF EXAMPLE",
          entityType: "BANK",
          bankName: "EXAMPLE BANK PLC",
        }),
      ],
    );

    expect(result.matchDetail?.bankScore).toBe(100);
    expect(result.score).toBe(100);
  });

  it("honours a caller-supplied threshold", () => {
    const candidates = [candidate({ id: "e7", primaryName: "JON SMITH" })];
    const lenient = screen({ name: "JOHN SMITH", entityType: "PERSON" }, candidates);
    const strict = screen({ name: "JOHN SMITH", entityType: "PERSON" }, candidates, { threshold: 100 });

    expect(lenient.status).toBe("POTENTIAL_MATCH");
    expect(strict.status).toBe("CLEAR");
  });

  it("never exceeds a score of 100", () => {
    const result = screen(
      { name: "IVAN PETROV", entityType: "PERSON", country: "RU" },
      [candidate({ id: "e8", primaryName: "IVAN PETROV", country: "RU" })],
    );
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("returns CLEAR with score 0 for an empty candidate set", () => {
    const result = screen({ name: "ANY ONE", entityType: "PERSON" }, []);
    expect(result.status).toBe("CLEAR");
    expect(result.score).toBe(0);
    expect(result.candidatesEvaluated).toBe(0);
  });
});
