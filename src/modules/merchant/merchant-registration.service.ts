import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ConflictError, ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { encryptAgentKycValue as encryptKycValue } from "../admin/agent-kyc-vault.js";
import { decodeMerchantKycFiles } from "./merchant-kyc-vault.js";
import type { RegisterMerchantPublicInput } from "./merchant-registration.types.js";

/**
 * Registration subscription tiers. AGENT_CODE is the reduced agent-referred
 * tier; DIRECT is the standard tier. The fee is recorded on the registration —
 * the subscription/payment gateway is wired in a later step.
 */
const REGISTRATION_FEES = {
  AGENT_CODE: { amount: "200.00", currency: "USD", tier: "AGENT_REFERRAL" },
  DIRECT: { amount: "500.00", currency: "USD", tier: "STANDARD" },
} as const;

// Agent codes are issued as AGT-<12 uppercase hex chars> by generateAgentCode().
const AGENT_CODE_PATTERN = /^AGT-[A-F0-9]{12}$/;

type TransactionClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

function maskDocumentNumber(value: string): string {
  const visibleCharacters = Math.min(4, Math.max(1, value.length - 1));
  return `${"*".repeat(value.length - visibleCharacters)}${value.slice(-visibleCharacters)}`;
}

export class MerchantRegistrationService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Pre-flight check used by the registration page so a wrong agent number is
   * caught before the form is submitted. Never reveals more than one code.
   */
  async validateAgentCode(rawCode: string) {
    const agentCode = rawCode.trim().toUpperCase();
    if (!AGENT_CODE_PATTERN.test(agentCode)) {
      return { valid: false, reason: "Agent code format is invalid" };
    }
    const agent = await this.prisma.agent.findUnique({
      where: { code: agentCode },
      select: { code: true, name: true },
    });
    if (!agent) {
      return { valid: false, reason: "No agent is registered with this code" };
    }
    return { valid: true, agentCode: agent.code, agentName: agent.name };
  }

  async register(input: RegisterMerchantPublicInput) {
    const agent = input.mode === "AGENT_CODE" ? await this.requireValidAgent(input.agentCode) : null;
    const fee = REGISTRATION_FEES[input.mode];
    const files = decodeMerchantKycFiles(input);

    const existing = await this.prisma.merchant.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError("A merchant with this email address already exists");
    }

    const registration = {
      mode: input.mode,
      agentCode: agent?.code ?? null,
      agentName: agent?.name ?? null,
      fee,
      feeStatus: "PENDING_PAYMENT",
      submittedAt: new Date().toISOString(),
    };

    const metadata = {
      registration,
      business: {
        dbaName: input.dbaName ?? null,
        registrationNumber: input.registrationNumber,
        businessType: input.businessType,
        industry: input.industry,
        businessAddress: input.businessAddress,
      },
      contact: { contactName: input.contactName, email: input.email, phone: input.phone },
      aml: {
        expectedMonthlyVolume: input.expectedMonthlyVolume,
        expectedMonthlyTransactions: input.expectedMonthlyTransactions,
        sourceOfFunds: input.sourceOfFunds,
        purposeOfAccount: input.purposeOfAccount,
        pepDeclaration: input.pepDeclaration,
        sanctionsDeclaration: input.sanctionsDeclaration,
      },
      identity: {
        fullName: input.fullName,
        dateOfBirth: input.dateOfBirth,
        nationality: input.nationality,
        residentialAddress: input.residentialAddress,
        governmentIdType: input.governmentIdType,
        governmentIdMasked: maskDocumentNumber(input.governmentIdNumber),
        governmentIdIssuingCountry: input.governmentIdIssuingCountry,
        governmentIdExpiry: input.governmentIdExpiry ?? null,
      },
    };

    // Full personal profile (unmasked) is encrypted before it touches the DB.
    const encryptedProfile = encryptKycValue(
      JSON.stringify({
        ...metadata.identity,
        governmentIdNumber: input.governmentIdNumber,
      }),
    );
    const encryptedFiles = (
      [
        ["certificateOfIncorporation", files.certificateOfIncorporation],
        ["tradeLicense", files.tradeLicense],
        ["directorIdDocument", files.directorIdDocument],
        ["profilePhoto", files.profilePhoto],
      ] as const
    ).map(([kind, upload]) => ({
      kind,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.bytes.byteLength,
      envelope: encryptKycValue(upload.bytes),
    }));

    const merchant = await this.prisma.$transaction(async (tx) => {
      const code = await this.allocateMerchantCode(tx);
      const created = await tx.merchant.create({
        data: {
          code,
          legalName: input.legalName,
          dbaName: input.dbaName,
          email: input.email,
          phone: input.phone,
          country: input.country,
          website: input.website,
          taxId: input.taxId,
          status: "PENDING",
          agentId: agent?.id ?? null,
          metadata,
        },
      });

      await tx.kycRecord.create({
        data: {
          merchantId: created.id,
          status: "UNDER_REVIEW",
          documents: { contentProfile: encryptedProfile, uploads: encryptedFiles },
          submittedAt: new Date(),
        },
      });

      await tx.merchantKycDocument.createMany({
        data: [
          {
            merchantId: created.id,
            documentType: "ARTICLES_OF_INCORPORATION",
            documentReference: files.certificateOfIncorporation.fileName,
          },
          {
            merchantId: created.id,
            documentType: "TRADE_LICENSE",
            documentReference: files.tradeLicense.fileName,
          },
          {
            merchantId: created.id,
            documentType: input.governmentIdType,
            documentReference: files.directorIdDocument.fileName,
          },
        ],
      });

      await tx.account.create({
        data: {
          code: `MERCHANT-${code}-USD`,
          name: `Merchant Account: ${code}`,
          type: "LIABILITY",
          subtype: "MERCHANT",
          currency: "USD",
        },
      });

      return created;
    });

    logger.info(
      { merchantId: merchant.id, code: merchant.code, mode: input.mode, agentCode: agent?.code ?? null },
      "Merchant self-registration submitted",
    );

    return {
      id: merchant.id,
      code: merchant.code,
      status: merchant.status,
      registrationMode: input.mode,
      agentCode: agent?.code ?? null,
      registrationFee: fee,
      kycStatus: "UNDER_REVIEW",
    };
  }

  private async requireValidAgent(rawCode?: string) {
    const agentCode = (rawCode ?? "").trim().toUpperCase();
    if (!agentCode) {
      throw new ValidationError(
        "An agent code is required for agent-referred registration",
      );
    }
    if (!AGENT_CODE_PATTERN.test(agentCode)) {
      throw new ValidationError(
        "Agent code is invalid. Enter the code issued when the agent was registered.",
      );
    }
    const agent = await this.prisma.agent.findUnique({ where: { code: agentCode } });
    if (!agent) {
      throw new ValidationError(
        "Agent code was not found. Registration cannot complete without a valid agent code.",
      );
    }
    return agent;
  }

  private async allocateMerchantCode(tx: TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = `MER-${randomBytes(6).toString("hex").toUpperCase()}`;
      const clash = await tx.merchant.findUnique({ where: { code }, select: { id: true } });
      if (!clash) return code;
    }
    throw new ConflictError("Could not allocate a unique merchant code");
  }
}

export { REGISTRATION_FEES };
