import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../../core/errors.js";

export interface BankAccountDetails {
  bankName: string;
  bankAddress: string;
  accountName: string;
  accountSignatory: string;
  accountNumber: string;
  wireRoutingNumber: string;
  swiftUsd: string;
  swiftOtherCurrency: string;
}

function isBankAccountDetails(value: unknown): value is BankAccountDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return [
    "bankName",
    "bankAddress",
    "accountName",
    "accountSignatory",
    "accountNumber",
    "wireRoutingNumber",
    "swiftUsd",
    "swiftOtherCurrency",
  ].every((field) => typeof details[field] === "string");
}

function encryptionKey(): Buffer {
  const encoded = process.env.BANK_DETAILS_ENCRYPTION_KEY;
  if (!encoded) {
    throw new AppError("Bank details encryption is not configured", 503, "ENCRYPTION_NOT_CONFIGURED");
  }

  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
    throw new AppError("Bank details encryption is not configured", 503, "ENCRYPTION_NOT_CONFIGURED");
  }

  return key;
}

/**
 * Encrypt any JSON payload with the same AES-256-GCM envelope format. Used for
 * caller-defined shapes (for example a merchant's own saved bank account) that
 * do not carry the full corporate account field set.
 */
export function encryptVaultPayload(payload: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function encryptBankAccountDetails(details: BankAccountDetails): string {
  return encryptVaultPayload(details);
}

/** Last four digits of an account number, for masked display. */
export function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\s+/g, "");
  if (digits.length <= 4) return "*".repeat(Math.max(digits.length, 0));
  return `••••${digits.slice(-4)}`;
}

export function lastFour(accountNumber: string): string {
  const digits = accountNumber.replace(/\s+/g, "");
  return digits.slice(-4);
}

/** Decrypt any envelope produced by {@link encryptVaultPayload}. */
export function decryptVaultPayload(envelope: string): unknown {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = envelope.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext || extra !== undefined) {
    throw new AppError("Stored bank details cannot be decrypted", 500, "BANK_DETAILS_DECRYPTION_FAILED");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Stored bank details cannot be decrypted", 500, "BANK_DETAILS_DECRYPTION_FAILED");
  }
}

export function decryptBankAccountDetails(envelope: string): BankAccountDetails {
  const details = decryptVaultPayload(envelope);
  if (!isBankAccountDetails(details)) {
    throw new AppError("Stored bank details cannot be decrypted", 500, "BANK_DETAILS_DECRYPTION_FAILED");
  }
  return details;
}
