import type { AgentKycUpload } from "../admin/agent-kyc-vault.js";
import { decodeKycUpload } from "../admin/agent-kyc-vault.js";
import type { RegisterMerchantPublicInput } from "./merchant-registration.types.js";

export const MAX_MERCHANT_COMPANY_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MERCHANT_ID_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MERCHANT_PROFILE_PHOTO_BYTES = 2 * 1024 * 1024;

const COMPANY_DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
const PROFILE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface MerchantKycUploads {
  certificateOfIncorporation: AgentKycUpload;
  tradeLicense: AgentKycUpload;
  directorIdDocument: AgentKycUpload;
  profilePhoto: AgentKycUpload;
}

/**
 * Decode and validate the four merchant registration uploads. Each file's
 * magic bytes must match its declared MIME type before it is accepted.
 */
export function decodeMerchantKycFiles(
  input: RegisterMerchantPublicInput,
): MerchantKycUploads {
  return {
    certificateOfIncorporation: decodeKycUpload(
      input.certificateOfIncorporation,
      COMPANY_DOCUMENT_TYPES,
      MAX_MERCHANT_COMPANY_DOCUMENT_BYTES,
    ),
    tradeLicense: decodeKycUpload(
      input.tradeLicense,
      COMPANY_DOCUMENT_TYPES,
      MAX_MERCHANT_COMPANY_DOCUMENT_BYTES,
    ),
    directorIdDocument: decodeKycUpload(
      input.directorIdDocument,
      COMPANY_DOCUMENT_TYPES,
      MAX_MERCHANT_ID_DOCUMENT_BYTES,
    ),
    profilePhoto: decodeKycUpload(
      input.profilePhoto,
      PROFILE_PHOTO_TYPES,
      MAX_MERCHANT_PROFILE_PHOTO_BYTES,
    ),
  };
}
