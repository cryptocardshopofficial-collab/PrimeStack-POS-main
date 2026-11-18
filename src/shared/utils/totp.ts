import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP (time-based one-time passwords) for authenticator apps.
 *
 * Implemented directly on node:crypto so the switch does not have to pull in
 * the speakeasy/otplib dependency chain. The defaults match what Google
 * Authenticator, 1Password, Authy and Aegis expect: HMAC-SHA1, 30-second
 * steps and six digits.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const STEP_SECONDS = 30;

/** Encode a buffer as RFC 4648 base32 (no padding). */
function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Decode RFC 4648 base32, ignoring padding and whitespace. */
function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character in TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generate a fresh base32 TOTP secret — 160 bits, the RFC 4226 recommendation. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** Compute the TOTP code for an explicit counter value. */
function totpForCounter(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter % 0x100000000, 4);

  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/**
 * Verify a user-supplied code against the secret.
 *
 * One step of drift either side is accepted so a slightly skewed clock or a
 * slow typist does not lock people out.
 */
export function verifyTotp(secret: string, code: string, window = 1): boolean {
  const candidate = (code || "").replace(/\D/g, "");
  if (candidate.length !== DIGITS) return false;

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  const actual = Buffer.from(candidate, "utf8");
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = Buffer.from(totpForCounter(secret, counter + drift), "utf8");
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true;
  }
  return false;
}

/** Build the otpauth:// URI an authenticator app scans or accepts manually. */
export function totpProvisioningUri(secret: string, account: string, issuer = "PrimeStack"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
