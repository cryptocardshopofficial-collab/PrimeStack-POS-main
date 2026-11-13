import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto";
import { config } from "../../config/index.js";
import { AppError, ValidationError } from "../../core/errors.js";
import type { RegisterAgentKycInput } from "./agent-registration.types.js";

export const MAX_AGENT_ID_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_AGENT_PROFILE_PHOTO_BYTES = 2 * 1024 * 1024;

export interface AgentKycUpload {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

function encryptionKey(): Buffer {
  const encoded = config.agentKyc.encryptionKey;
  if (!encoded) {
    throw new AppError("Agent KYC encryption is not configured", 503, "ENCRYPTION_NOT_CONFIGURED");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
    throw new AppError("Agent KYC encryption is not configured", 503, "ENCRYPTION_NOT_CONFIGURED");
  }
  return key;
}

export function encryptAgentKycValue(value: string | Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptAgentKycValue(envelope: string): Buffer {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = envelope.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext || extra !== undefined) {
    throw new AppError("Stored agent KYC data cannot be decrypted", 500, "AGENT_KYC_DECRYPTION_FAILED");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]);
  } catch {
    throw new AppError("Stored agent KYC data cannot be decrypted", 500, "AGENT_KYC_DECRYPTION_FAILED");
  }
}

export function fingerprintAgentPin(pin: string): string {
  const pepper = config.agentKyc.pinPepper;
  if (!pepper || (config.app.env === "production" && pepper.length < 32)) {
    throw new AppError("Agent PIN protection is not configured", 503, "PIN_PROTECTION_NOT_CONFIGURED");
  }
  return createHmac("sha256", pepper)
    .update(pin)
    .digest("hex");
}

export function generateAgentLoginPin(): string {
  return randomInt(0, 1_000_000_000_000).toString().padStart(12, "0");
}

export function generateAgentCode(): string {
  return `AGT-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function detectedMimeType(bytes: Buffer): string | undefined {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function decodeBase64(contentBase64: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    throw new ValidationError("KYC files must be valid base64-encoded uploads");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (!bytes.length || bytes.toString("base64") !== contentBase64) {
    throw new ValidationError("KYC files must be valid base64-encoded uploads");
  }
  return bytes;
}

function safeFileName(fileName: string): string {
  const leafName = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  const safeName = leafName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return safeName || "document";
}

function decodeUpload(
  upload: RegisterAgentKycInput["idDocument"],
  allowedTypes: readonly string[],
  maxBytes: number,
): AgentKycUpload {
  const bytes = decodeBase64(upload.contentBase64);
  if (bytes.length > maxBytes) {
    throw new ValidationError(`KYC file exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
  }
  const detected = detectedMimeType(bytes);
  if (!detected || detected !== upload.mimeType || !allowedTypes.includes(detected)) {
    throw new ValidationError("KYC file type does not match the file contents");
  }
  return { fileName: safeFileName(upload.fileName), mimeType: detected, bytes };
}

export function decodeAgentKycFiles(input: RegisterAgentKycInput): {
  identityDocument: AgentKycUpload;
  profilePhoto: AgentKycUpload;
} {
  return {
    identityDocument: decodeUpload(
      input.idDocument,
      ["application/pdf", "image/jpeg", "image/png"],
      MAX_AGENT_ID_DOCUMENT_BYTES,
    ),
    profilePhoto: decodeUpload(
      input.profilePhoto,
      ["image/jpeg", "image/png", "image/webp"],
      MAX_AGENT_PROFILE_PHOTO_BYTES,
    ),
  };
}
