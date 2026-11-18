import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from "./totp.js";

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890".
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("verifyTotp — RFC 6238 SHA-1 vectors", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The RFC prints eight digits; six digits are the low six of the same code.
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  for (const [seconds, code] of vectors) {
    it(`accepts the RFC code at T=${seconds}`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(seconds * 1000);
      expect(verifyTotp(RFC_SECRET, code, 0)).toBe(true);
      expect(verifyTotp(RFC_SECRET, "000000", 0)).toBe(false);
    });
  }

  it("tolerates one step of drift in either direction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1111111109 * 1000);
    expect(verifyTotp(RFC_SECRET, "050471", 1)).toBe(true); // T+30s
    expect(verifyTotp(RFC_SECRET, "081804", 1)).toBe(true); // exact
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyTotp(RFC_SECRET, "", 0)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abcdef", 0)).toBe(false);
    expect(verifyTotp("not-base32-!!!", "123456", 0)).toBe(false);
  });
});

describe("TOTP enrolment helpers", () => {
  it("mints a 160-bit base32 secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret).toHaveLength(32);
  });

  it("builds an otpauth provisioning URI an authenticator app can consume", () => {
    const secret = generateTotpSecret();
    const uri = totpProvisioningUri(secret, "admin@primestack.io");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
