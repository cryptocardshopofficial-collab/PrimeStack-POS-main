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

  async getPortalDashboard(agentId: string, page: number, pageSize: number) {
    const profile = await this.getPortalProfile(agentId);
    const assignedMerchantWhere: Prisma.MerchantWhereInput = { agentId };
    const assignedTransactionWhere: Prisma.TransactionWhereInput = {
      merchant: { is: { agentId } },
    };

    const [merchants, transactions, totalTransactions, controlRequests] = await Promise.all([
      this.prisma.merchant.findMany({
        where: assignedMerchantWhere,
        select: {
          id: true,
          code: true,
          legalName: true,
          displayName: true,
          country: true,
          status: true,
          createdAt: true,
          _count: { select: { transactions: true, terminals: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.transaction.findMany({
        where: assignedTransactionWhere,
        select: {
          id: true,
          stan: true,
          rrn: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          responseCode: true,
          createdAt: true,
          merchant: {
            select: { id: true, code: true, displayName: true, legalName: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where: assignedTransactionWhere }),
      this.prisma.agentTransactionControlRequest.findMany({
        where: { agentId },
        select: {
          id: true,
          transactionId: true,
          action: true,
          status: true,
          reason: true,
          agentResponse: true,
          adminRemarks: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);

    return {
      profile,
      merchants,
      transactions: transactions.map((transaction) => ({
        ...transaction,
        amount: transaction.amount.toString(),
      })),
      controlRequests,
      meta: {
        page,
        pageSize,
        total: totalTransactions,
        totalPages: Math.ceil(totalTransactions / pageSize),
      },
    };
  }

  async requestTransactionControl(
    agentId: string,
    transactionId: string,
    action: "HOLD" | "RESUME",
    reason: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    await this.getPortalProfile(agentId);
    const transaction = await this.prisma.transaction.findFirst({
      where: {
        id: transactionId,
        merchant: { is: { agentId } },
      },
      select: {
        id: true,
        stan: true,
        status: true,
        settledAt: true,
        merchantId: true,
      },
    });
    if (!transaction) throw new NotFoundError("Assigned transaction", transactionId);

    let previousStatus: "AUTHORIZED" | "CAPTURED" | null = null;
    if (action === "HOLD") {
      if (
        transaction.settledAt ||
        (transaction.status !== "AUTHORIZED" && transaction.status !== "CAPTURED")
      ) {
        throw new ConflictError("Only unsettled authorized or captured transactions can be held");
      }
      previousStatus = transaction.status;
    } else {
      if (transaction.status !== "ON_HOLD" || transaction.settledAt) {
        throw new ConflictError("Only held, unsettled transactions can be resumed");
      }
      const priorHold = await this.prisma.agentTransactionControlRequest.findFirst({
        where: {
          transactionId,
          action: "HOLD",
          status: "APPROVED",
          previousStatus: { in: ["AUTHORIZED", "CAPTURED"] },
        },
        orderBy: { reviewedAt: "desc" },
        select: { previousStatus: true },
      });
      if (
        priorHold?.previousStatus !== "AUTHORIZED" &&
        priorHold?.previousStatus !== "CAPTURED"
      ) {
        throw new ConflictError("The transaction has no approved hold to resume");
      }
      previousStatus = priorHold.previousStatus;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await tx.agentTransactionControlRequest.create({
          data: {
            transactionId,
            agentId,
            action,
            reason: reason.trim(),
            previousStatus,
          },
          select: {
            id: true,
            transactionId: true,
            action: true,
            status: true,
            reason: true,
            previousStatus: true,
            createdAt: true,
          },
        });
        const admins = await tx.user.findMany({
          where: { role: { in: ["SUPER_ADMIN", "ADMIN"] }, isActive: true },
          select: { id: true },
        });
        if (admins.length) {
          await tx.notification.createMany({
            data: admins.map(({ id }) => ({
              merchantId: transaction.merchantId,
              type: "ALERT",
              channel: "IN_APP",
              title: `Agent ${action.toLowerCase()} request`,
              message: `An agent requested ${action.toLowerCase()} for transaction ${transaction.stan}.`,
              recipient: id,
              metadata: { requestId: request.id, transactionId, agentId, action },
            })),
          });
        }
        await tx.auditLog.create({
          data: {
            merchantId: transaction.merchantId,
            action: `AGENT_TRANSACTION_${action}_REQUESTED`,
            entity: "Transaction",
            entityId: transactionId,
            before: { status: transaction.status },
            after: { requestId: request.id, action, reason: reason.trim() },
            ipAddress,
            userAgent,
          },
        });
        return request;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictError("A transaction control request is already awaiting review");
      }
      throw error;
    }
  }

  async respondToTransactionControlRequest(
    agentId: string,
    requestId: string,
    response: string,
  ) {
    const request = await this.prisma.agentTransactionControlRequest.findFirst({
      where: { id: requestId, agentId, status: "INFO_REQUESTED" },
      select: { id: true, transactionId: true },
    });
    if (!request) throw new NotFoundError("Information request", requestId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.agentTransactionControlRequest.updateMany({
        where: { id: requestId, agentId, status: "INFO_REQUESTED" },
        data: { agentResponse: response.trim(), status: "PENDING" },
      });
      if (updated.count !== 1) {
        throw new ConflictError("The request status changed; refresh and try again");
      }
      await tx.auditLog.create({
        data: {
          action: "AGENT_TRANSACTION_CONTROL_INFO_PROVIDED",
          entity: "AgentTransactionControlRequest",
          entityId: requestId,
          after: { response: response.trim() },
        },
      });
      return tx.agentTransactionControlRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { id: true, action: true, status: true, agentResponse: true, updatedAt: true },
      });
    });
  }

  async listTransactionControlRequests(
    status: "PENDING" | "INFO_REQUESTED" | "APPROVED" | "REJECTED" | undefined,
    page: number,
    pageSize: number,
  ) {
    const where: Prisma.AgentTransactionControlRequestWhereInput = status ? { status } : {};
    const [data, total] = await Promise.all([
      this.prisma.agentTransactionControlRequest.findMany({
        where,
        include: {
          agent: { select: { id: true, code: true, name: true } },
          transaction: {
            select: {
              id: true,
              stan: true,
              rrn: true,
              status: true,
              amount: true,
              currency: true,
              merchant: { select: { id: true, code: true, legalName: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.agentTransactionControlRequest.count({ where }),
    ]);
    return {
      data: data.map((item) => ({
        ...item,
        transaction: { ...item.transaction, amount: item.transaction.amount.toString() },
      })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async reviewTransactionControlRequest(
    requestId: string,
    decision: "APPROVE" | "REJECT" | "REQUEST_INFO",
    adminRemarks: string,
    reviewedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.agentTransactionControlRequest.findUnique({
        where: { id: requestId },
        include: {
          transaction: {
            select: { id: true, status: true, settledAt: true, merchantId: true },
          },
        },
      });
      if (!request) throw new NotFoundError("Agent transaction control request", requestId);
      if (request.status !== "PENDING") {
        throw new ConflictError(`Request is ${request.status} and cannot be reviewed`);
      }

      let nextStatus: "APPROVED" | "REJECTED" | "INFO_REQUESTED";
      if (decision === "REQUEST_INFO") {
        nextStatus = "INFO_REQUESTED";
      } else {
        nextStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
        if (decision === "APPROVE") {
          let nextTransactionStatus: "AUTHORIZED" | "CAPTURED" | "ON_HOLD";
          let expectedStatus: "AUTHORIZED" | "CAPTURED" | "ON_HOLD";
          if (request.action === "HOLD") {
            if (
              request.previousStatus !== "AUTHORIZED" &&
              request.previousStatus !== "CAPTURED"
            ) {
              throw new ConflictError("The request does not contain a valid transaction status to hold");
            }
            expectedStatus = request.previousStatus;
            nextTransactionStatus = "ON_HOLD";
          } else {
            if (
              request.previousStatus !== "AUTHORIZED" &&
              request.previousStatus !== "CAPTURED"
            ) {
              throw new ConflictError("The request does not contain a valid transaction status to restore");
            }
            expectedStatus = "ON_HOLD";
            nextTransactionStatus = request.previousStatus;
          }
          const updated = await tx.transaction.updateMany({
            where: {
              id: request.transactionId,
              status: expectedStatus,
              settledAt: null,
            },
            data: { status: nextTransactionStatus },
          });
          if (updated.count !== 1) {
            throw new ConflictError("Transaction status changed or settled before the request was approved");
          }
          await tx.transactionLog.create({
            data: {
              transactionId: request.transactionId,
              stage: request.action === "HOLD" ? "AGENT_HOLD_APPROVED" : "AGENT_RESUME_APPROVED",
              message: adminRemarks.trim(),
            },
          });
        }
      }

      const updated = await tx.agentTransactionControlRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: {
          status: nextStatus,
          adminRemarks: adminRemarks.trim(),
          reviewedBy,
          reviewedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new ConflictError("The request was reviewed by another administrator");
      }
      await tx.auditLog.create({
        data: {
          userId: reviewedBy,
          merchantId: request.transaction.merchantId,
          action: `ADMIN_TRANSACTION_${request.action}_${decision}`,
          entity: "AgentTransactionControlRequest",
          entityId: requestId,
          before: { requestStatus: request.status, transactionStatus: request.transaction.status },
          after: {
            requestStatus: nextStatus,
            transactionStatus:
              decision === "APPROVE"
                ? request.action === "HOLD" ? "ON_HOLD" : request.previousStatus
                : request.transaction.status,
            adminRemarks: adminRemarks.trim(),
          },
          ipAddress,
          userAgent,
        },
      });
      await tx.notification.create({
        data: {
          merchantId: request.transaction.merchantId,
          type: "ALERT",
          channel: "IN_APP",
          title: `Transaction ${request.action.toLowerCase()} request update`,
          message: `Your ${request.action.toLowerCase()} request was ${decision.toLowerCase().replace("_", " ")}.`,
          recipient: `agent:${request.agentId}`,
          metadata: { requestId, decision, status: nextStatus },
        },
      });
      return tx.agentTransactionControlRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          transaction: { select: { id: true, stan: true, status: true, settledAt: true } },
        },
      });
    });
  }

  async setAssignedMerchantStatus(
    agentId: string,
    merchantId: string,
    action: "pause" | "resume",
    ipAddress?: string,
    userAgent?: string,
  ) {
    const fromStatus = action === "pause" ? "ACTIVE" : "SUSPENDED";
    const toStatus = action === "pause" ? "SUSPENDED" : "ACTIVE";

    return this.prisma.$transaction(async (transaction) => {
      const profile = await transaction.agentKycProfile.findUnique({
        where: { agentId },
        select: {
          verificationStatus: true,
          agent: { select: { status: true } },
        },
      });
      if (
        !profile ||
        profile.verificationStatus !== "APPROVED" ||
        profile.agent.status !== "APPROVED"
      ) {
        throw new UnauthorizedError("Agent KYC approval is required");
      }

      const current = await transaction.merchant.findFirst({
        where: { id: merchantId, agentId },
        select: { id: true, status: true },
      });
      if (!current) throw new NotFoundError("Assigned merchant", merchantId);
      if (current.status !== fromStatus) {
        throw new ConflictError(
          `Merchant must be ${fromStatus.toLowerCase()} to ${action}`,
        );
      }

      const updated = await transaction.merchant.updateMany({
        where: { id: merchantId, agentId, status: fromStatus },
        data: { status: toStatus },
      });
      if (updated.count !== 1) {
        throw new ConflictError("Merchant status changed; refresh and try again");
      }

      await transaction.auditLog.create({
        data: {
          merchantId,
          action: action === "pause" ? "AGENT_PAUSE_MERCHANT" : "AGENT_RESUME_MERCHANT",
          entity: "Merchant",
          entityId: merchantId,
          before: { status: fromStatus, changedByAgentId: agentId },
          after: {
            status: toStatus,
            changedByAgentId: agentId,
            source: "AGENT_PORTAL",
          },
          ipAddress,
          userAgent,
        },
      });

      return { id: merchantId, status: toStatus };
    });
  }
}
