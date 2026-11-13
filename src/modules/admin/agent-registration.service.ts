import { Prisma, type PrismaClient } from "@prisma/client";
import { AppError, ConflictError, NotFoundError, UnauthorizedError } from "../../core/errors.js";
import { hashPassword, verifyPassword } from "../../shared/utils/crypto.js";
import {
  decryptAgentKycValue,
  decodeAgentKycFiles,
  encryptAgentKycValue,
  fingerprintAgentPin,
  generateAgentCode,
  generateAgentLoginPin,
} from "./agent-kyc-vault.js";
import type { AgentKycStatusInput, RegisterAgentKycInput } from "./agent-registration.types.js";

type KycStatus = AgentKycStatusInput["status"];

interface AgentKycStoredProfile {
  fullName: string;
  email: string;
  mobileNumber: string;
  residentialAddress: string;
  dateOfBirth: string;
  nationality: string;
  country: string;
  governmentIdType: string;
  governmentIdNumber: string;
  governmentIdIssuingCountry: string;
  governmentIdExpiry?: string;
  idDocumentFileName: string;
  idDocumentMimeType: string;
  idDocumentSize: number;
  profilePhotoFileName: string;
  profilePhotoMimeType: string;
  profilePhotoSize: number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function parseStoredProfile(envelope: string): AgentKycStoredProfile {
  try {
    const parsed: unknown = JSON.parse(decryptAgentKycValue(envelope).toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid encrypted profile");
    const profile = parsed as Record<string, unknown>;
    const stringFields = [
      "fullName",
      "email",
      "mobileNumber",
      "residentialAddress",
      "dateOfBirth",
      "nationality",
      "country",
      "governmentIdType",
      "governmentIdNumber",
      "governmentIdIssuingCountry",
      "idDocumentFileName",
      "idDocumentMimeType",
      "profilePhotoFileName",
      "profilePhotoMimeType",
    ];
    if (stringFields.some((field) => typeof profile[field] !== "string")) {
      throw new Error("Invalid encrypted profile");
    }
    if (typeof profile.idDocumentSize !== "number" || typeof profile.profilePhotoSize !== "number") {
      throw new Error("Invalid encrypted profile");
    }
    return profile as unknown as AgentKycStoredProfile;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Stored agent KYC profile is invalid", 500, "AGENT_KYC_DECRYPTION_FAILED");
  }
}

function maskDocumentNumber(value: string): string {
  const visibleCharacters = Math.min(4, Math.max(1, value.length - 1));
  return `${"*".repeat(value.length - visibleCharacters)}${value.slice(-visibleCharacters)}`;
}

export class AgentRegistrationService {
  constructor(private readonly prisma: PrismaClient) {}

  async register(input: RegisterAgentKycInput, createdBy: string) {
    const files = decodeAgentKycFiles(input);
    const storedProfile: AgentKycStoredProfile = {
      fullName: input.fullName,
      email: input.email,
      mobileNumber: input.mobileNumber,
      residentialAddress: input.residentialAddress,
      dateOfBirth: input.dateOfBirth,
      nationality: input.nationality,
      country: input.country,
      governmentIdType: input.governmentIdType,
      governmentIdNumber: input.governmentIdNumber,
      governmentIdIssuingCountry: input.governmentIdIssuingCountry,
      governmentIdExpiry: input.governmentIdExpiry,
      idDocumentFileName: files.identityDocument.fileName,
      idDocumentMimeType: files.identityDocument.mimeType,
      idDocumentSize: files.identityDocument.bytes.byteLength,
      profilePhotoFileName: files.profilePhoto.fileName,
      profilePhotoMimeType: files.profilePhoto.mimeType,
      profilePhotoSize: files.profilePhoto.bytes.byteLength,
    };
    const encryptedProfile = encryptAgentKycValue(JSON.stringify(storedProfile));
    const encryptedIdentityDocument = encryptAgentKycValue(files.identityDocument.bytes);
    const encryptedProfilePhoto = encryptAgentKycValue(files.profilePhoto.bytes);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateAgentCode();
      const loginPin = generateAgentLoginPin();
      const pinHash = await hashPassword(loginPin);
      const pinFingerprint = fingerprintAgentPin(loginPin);

      try {
        const agent = await this.prisma.$transaction(async (transaction) => {
          const created = await transaction.agent.create({
            data: {
              code,
              name: `Agent ${code}`,
              status: "PENDING",
            },
            select: { id: true, code: true, status: true, createdAt: true },
          });
          await transaction.agentKycProfile.create({
            data: {
              agentId: created.id,
              encryptedProfile,
              encryptedIdentityDocument,
              encryptedProfilePhoto,
              verificationStatus: "PENDING",
            },
          });
          await transaction.agentCredential.create({
            data: {
              agentId: created.id,
              pinHash,
              pinFingerprint,
            },
          });
          await transaction.auditLog.create({
            data: {
              userId: createdBy,
              action: "REGISTER_AGENT_KYC",
              entity: "Agent",
              entityId: created.id,
              after: { code: created.code, status: "PENDING" },
            },
          });
          return created;
        });

        return { agent, loginPin };
      } catch (error) {
        if (isUniqueConstraintError(error)) continue;
        throw error;
      }
    }

    throw new ConflictError("Unable to allocate a unique agent code and login PIN; please try again");
  }

  async list(page: number, pageSize: number) {
    const where: Prisma.AgentKycProfileWhereInput = {};
    const [profiles, total] = await Promise.all([
      this.prisma.agentKycProfile.findMany({
        where,
        include: {
          agent: { select: { id: true, code: true, status: true, createdAt: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.agentKycProfile.count({ where }),
    ]);

    return {
      data: profiles.map((profile) => {
        const details = parseStoredProfile(profile.encryptedProfile);
        return {
          id: profile.agent.id,
          code: profile.agent.code,
          fullName: details.fullName,
          email: details.email,
          mobileNumber: details.mobileNumber,
          residentialAddress: details.residentialAddress,
          dateOfBirth: details.dateOfBirth,
          nationality: details.nationality,
          country: details.country,
          governmentIdType: details.governmentIdType,
          maskedGovernmentIdNumber: maskDocumentNumber(details.governmentIdNumber),
          governmentIdIssuingCountry: details.governmentIdIssuingCountry,
          governmentIdExpiry: details.governmentIdExpiry ?? null,
          idDocument: {
            fileName: details.idDocumentFileName,
            mimeType: details.idDocumentMimeType,
            size: details.idDocumentSize,
          },
          profilePhoto: {
            fileName: details.profilePhotoFileName,
            mimeType: details.profilePhotoMimeType,
            size: details.profilePhotoSize,
          },
          status: profile.verificationStatus,
          reviewNotes: profile.encryptedReviewNotes
            ? decryptAgentKycValue(profile.encryptedReviewNotes).toString("utf8")
            : null,
          createdAt: profile.createdAt,
        };
      }),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  async updateStatus(agentId: string, status: KycStatus, reviewedBy: string, reviewNotes?: string) {
    const current = await this.prisma.agentKycProfile.findUnique({
      where: { agentId },
      include: { agent: { select: { code: true } } },
    });
    if (!current) throw new NotFoundError("Agent KYC profile", agentId);

    const updated = await this.prisma.$transaction(async (transaction) => {
      const profile = await transaction.agentKycProfile.update({
        where: { agentId },
        data: {
          verificationStatus: status,
          encryptedReviewNotes: reviewNotes ? encryptAgentKycValue(reviewNotes) : null,
          reviewedBy,
          reviewedAt: new Date(),
        },
        select: {
          agentId: true,
          verificationStatus: true,
          encryptedReviewNotes: true,
          reviewedAt: true,
        },
      });
      await transaction.agent.update({
        where: { id: agentId },
        data: { status },
      });
      await transaction.auditLog.create({
        data: {
          userId: reviewedBy,
          action: "REVIEW_AGENT_KYC",
          entity: "Agent",
          entityId: agentId,
          before: { status: current.verificationStatus },
          after: { code: current.agent.code, status },
        },
      });
      return profile;
    });
    return {
      agentId: updated.agentId,
      verificationStatus: updated.verificationStatus,
      reviewNotes: updated.encryptedReviewNotes
        ? decryptAgentKycValue(updated.encryptedReviewNotes).toString("utf8")
        : null,
      reviewedAt: updated.reviewedAt,
    };
  }

  async getDocument(agentId: string, kind: "identity" | "photo") {
    const profile = await this.prisma.agentKycProfile.findUnique({
      where: { agentId },
      select: { encryptedProfile: true, encryptedIdentityDocument: true, encryptedProfilePhoto: true },
    });
    if (!profile) throw new NotFoundError("Agent KYC profile", agentId);

    const details = parseStoredProfile(profile.encryptedProfile);
    const isIdentityDocument = kind === "identity";
    return {
      mimeType: isIdentityDocument ? details.idDocumentMimeType : details.profilePhotoMimeType,
      bytes: decryptAgentKycValue(
        isIdentityDocument ? profile.encryptedIdentityDocument : profile.encryptedProfilePhoto,
      ),
    };
  }

  async authenticateAgent(code: string, pin: string) {
    const credential = await this.prisma.agentCredential.findFirst({
      where: { agent: { is: { code } } },
      include: {
        agent: {
          include: { kycProfile: true },
        },
      },
    });
    if (!credential) throw new UnauthorizedError("Invalid agent code or PIN");

    const validPin = await verifyPassword(pin, credential.pinHash);
    if (
      !validPin ||
      credential.agent.status !== "APPROVED" ||
      credential.agent.kycProfile?.verificationStatus !== "APPROVED"
    ) {
      throw new UnauthorizedError("Invalid agent code or PIN");
    }
    return { id: credential.agent.id, code: credential.agent.code };
  }

  async getPortalProfile(agentId: string) {
    const profile = await this.prisma.agentKycProfile.findUnique({
      where: { agentId },
      include: { agent: { select: { id: true, code: true, status: true } } },
    });
    if (!profile) throw new NotFoundError("Agent KYC profile", agentId);
    if (profile.agent.status !== "APPROVED" || profile.verificationStatus !== "APPROVED") {
      throw new UnauthorizedError("Agent KYC approval is required");
    }
    const details = parseStoredProfile(profile.encryptedProfile);
    return {
      code: profile.agent.code,
      fullName: details.fullName,
      status: profile.verificationStatus,
    };
  }
}
