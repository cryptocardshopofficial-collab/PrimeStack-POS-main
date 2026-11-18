import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../../shared/utils/crypto.js";
import {
  decryptAgentKycValue,
  encryptAgentKycValue,
} from "./agent-kyc-vault.js";
import { AgentRegistrationService } from "./agent-registration.service.js";
import { registerAgentKycSchema } from "./agent-registration.types.js";

const pdf = Buffer.from("%PDF-1.7\nagent identity");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const registeredAt = new Date("2026-01-01T00:00:00.000Z");
const createdAgent = {
  id: "agent-id",
  code: "AGT-123456789ABC",
  status: "PENDING",
  createdAt: registeredAt,
};

function registrationInput() {
  return registerAgentKycSchema.parse({
    fullName: "Example Agent",
    email: "agent@example.com",
    mobileNumber: "+1 555 0100",
    residentialAddress: "10 Example Street",
    dateOfBirth: "1990-01-01",
    nationality: "Example",
    country: "Example",
    governmentIdType: "PASSPORT",
    governmentIdNumber: "EXAMPLE-1234",
    governmentIdIssuingCountry: "Example",
    idDocument: {
      fileName: "passport.pdf",
      mimeType: "application/pdf",
      contentBase64: pdf.toString("base64"),
    },
    profilePhoto: {
      fileName: "profile.png",
      mimeType: "image/png",
      contentBase64: png.toString("base64"),
    },
  });
}

function createService() {
  const transaction = {
    agent: { create: vi.fn().mockResolvedValue(createdAgent), update: vi.fn() },
    agentKycProfile: { create: vi.fn(), update: vi.fn() },
    agentCredential: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
    agentKycProfile: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    agentCredential: { findFirst: vi.fn() },
  };
  return {
    service: new AgentRegistrationService(prisma as unknown as PrismaClient),
    prisma,
    transaction,
  };
}

function createPortalService() {
  const transaction = {
    agentKycProfile: { findUnique: vi.fn() },
    merchant: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    agentTransactionControlRequest: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    user: { findMany: vi.fn() },
    notification: { createMany: vi.fn(), create: vi.fn() },
    transaction: { updateMany: vi.fn() },
    transactionLog: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
    agentKycProfile: { findUnique: vi.fn() },
    merchant: { findMany: vi.fn() },
    transaction: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    agentTransactionControlRequest: { findMany: vi.fn() },
  };
  prisma.agentKycProfile.findUnique.mockResolvedValue({
    verificationStatus: "APPROVED",
    encryptedProfile: encryptAgentKycValue(JSON.stringify({
      fullName: "Example Agent",
      email: "agent@example.com",
      mobileNumber: "+1 555 0100",
      residentialAddress: "10 Example Street",
      dateOfBirth: "1990-01-01",
      nationality: "Example",
      country: "Example",
      governmentIdType: "PASSPORT",
      governmentIdNumber: "EXAMPLE-1234",
      governmentIdIssuingCountry: "Example",
      idDocumentFileName: "identity.pdf",
      idDocumentMimeType: "application/pdf",
      idDocumentSize: 10,
      profilePhotoFileName: "profile.png",
      profilePhotoMimeType: "image/png",
      profilePhotoSize: 10,
    })),
    agent: { id: createdAgent.id, code: createdAgent.code, status: "APPROVED" },
  });
  transaction.agentKycProfile.findUnique.mockResolvedValue({
    verificationStatus: "APPROVED",
    agent: { status: "APPROVED" },
  });
  return {
    service: new AgentRegistrationService(prisma as unknown as PrismaClient),
    prisma,
    transaction,
  };
}

describe("AgentRegistrationService", () => {
  it("stores encrypted KYC and a hashed PIN, returning the PIN only at registration", async () => {
    const { service, prisma, transaction } = createService();
    const result = await service.register(registrationInput(), "admin-id");
    const storedProfile = transaction.agentKycProfile.create.mock.calls[0][0].data;
    const storedCredential = transaction.agentCredential.create.mock.calls[0][0].data;

    expect(storedProfile.encryptedProfile).not.toContain("agent@example.com");
    expect(storedProfile.encryptedProfile).not.toContain("EXAMPLE-1234");
    expect(decryptAgentKycValue(storedProfile.encryptedIdentityDocument)).toEqual(pdf);
    expect(decryptAgentKycValue(storedProfile.encryptedProfilePhoto)).toEqual(png);
    expect(storedCredential.pinHash).not.toBe(result.loginPin);
    expect(storedCredential.pinFingerprint).not.toContain(result.loginPin);
    expect(await verifyPassword(result.loginPin, storedCredential.pinHash)).toBe(true);
    expect(JSON.stringify(transaction.auditLog.create.mock.calls[0][0].data)).not.toContain(
      result.loginPin,
    );

    prisma.agentKycProfile.findMany.mockResolvedValue([
      {
        agent: createdAgent,
        encryptedProfile: storedProfile.encryptedProfile,
        encryptedReviewNotes: null,
        verificationStatus: "PENDING",
        createdAt: registeredAt,
      },
    ]);
    prisma.agentKycProfile.count.mockResolvedValue(1);
    const listed = await service.list(1, 10);

    expect(JSON.stringify(listed)).not.toContain(result.loginPin);
    expect(JSON.stringify(listed)).not.toContain("EXAMPLE-1234");
  });

  it("encrypts KYC review notes in the database", async () => {
    const { service, prisma, transaction } = createService();
    prisma.agentKycProfile.findUnique.mockResolvedValue({
      verificationStatus: "PENDING",
      agent: { code: createdAgent.code },
    });
    transaction.agentKycProfile.update.mockImplementation(async ({ data }) => ({
      agentId: createdAgent.id,
      verificationStatus: data.verificationStatus,
      encryptedReviewNotes: data.encryptedReviewNotes,
      reviewedAt: registeredAt,
    }));

    const result = await service.updateStatus(
      createdAgent.id,
      "REJECTED",
      "admin-id",
      "Please provide a clearer identity document",
    );
    const persistedNotes =
      transaction.agentKycProfile.update.mock.calls[0][0].data.encryptedReviewNotes;

    expect(persistedNotes).not.toContain("clearer identity document");
    expect(decryptAgentKycValue(persistedNotes).toString("utf8")).toBe(
      "Please provide a clearer identity document",
    );
    expect(result.reviewNotes).toBe("Please provide a clearer identity document");
  });

  it("revokes portal profile access when KYC approval is removed", async () => {
    const { service, prisma } = createService();
    prisma.agentKycProfile.findUnique.mockResolvedValue({
      verificationStatus: "REJECTED",
      agent: { id: createdAgent.id, code: createdAgent.code, status: "REJECTED" },
    });

    await expect(service.getPortalProfile(createdAgent.id)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("limits the agent dashboard transaction query to assigned merchants", async () => {
    const { service, prisma } = createPortalService();
    prisma.merchant.findMany.mockResolvedValue([]);
    prisma.transaction.findMany.mockResolvedValue([]);
    prisma.transaction.count.mockResolvedValue(0);
    prisma.agentTransactionControlRequest.findMany.mockResolvedValue([]);

    await service.getPortalDashboard(createdAgent.id, 1, 25);

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { merchant: { is: { agentId: createdAgent.id } } },
      }),
    );
    expect(prisma.transaction.count).toHaveBeenCalledWith({
      where: { merchant: { is: { agentId: createdAgent.id } } },
    });
  });

  it("creates an agent hold request without changing transaction status", async () => {
    const { service, prisma, transaction } = createPortalService();
    prisma.transaction.findFirst.mockResolvedValue({
      id: "tx-1",
      stan: "123456",
      status: "CAPTURED",
      settledAt: null,
      merchantId: "merchant-1",
    });
    transaction.agentTransactionControlRequest.create.mockResolvedValue({
      id: "request-1",
      transactionId: "tx-1",
      action: "HOLD",
      status: "PENDING",
    });
    transaction.user.findMany.mockResolvedValue([{ id: "admin-1" }]);

    await service.requestTransactionControl(
      createdAgent.id,
      "tx-1",
      "HOLD",
      "Review suspicious activity",
      "203.0.113.1",
      "agent-browser",
    );

    expect(prisma.transaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tx-1", merchant: { is: { agentId: createdAgent.id } } },
      }),
    );
    expect(transaction.agentTransactionControlRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "HOLD",
          reason: "Review suspicious activity",
          previousStatus: "CAPTURED",
        }),
      }),
    );
    expect(transaction.transaction.updateMany).not.toHaveBeenCalled();
  });

  it("changes a transaction to ON_HOLD only after an administrator approves", async () => {
    const { service, transaction } = createPortalService();
    transaction.agentTransactionControlRequest.findUnique.mockResolvedValue({
      id: "request-1",
      transactionId: "tx-1",
      agentId: createdAgent.id,
      action: "HOLD",
      status: "PENDING",
      previousStatus: "CAPTURED",
      transaction: {
        id: "tx-1",
        status: "CAPTURED",
        settledAt: null,
        merchantId: "merchant-1",
      },
    });
    transaction.transaction.updateMany.mockResolvedValue({ count: 1 });
    transaction.agentTransactionControlRequest.updateMany.mockResolvedValue({ count: 1 });
    transaction.agentTransactionControlRequest.findUniqueOrThrow.mockResolvedValue({
      id: "request-1",
      status: "APPROVED",
    });

    await service.reviewTransactionControlRequest(
      "request-1",
      "APPROVE",
      "Verified and approved",
      "admin-1",
    );

    expect(transaction.transaction.updateMany).toHaveBeenCalledWith({
      where: { id: "tx-1", status: "CAPTURED", settledAt: null },
      data: { status: "ON_HOLD" },
    });
    expect(transaction.agentTransactionControlRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "request-1", status: "PENDING" },
        data: expect.objectContaining({ status: "APPROVED", reviewedBy: "admin-1" }),
      }),
    );
    expect(transaction.transactionLog.create).toHaveBeenCalledOnce();
  });

  it("records agent identity and merchant status in the same pause transaction", async () => {
    const { service, transaction } = createPortalService();
    transaction.merchant.findFirst.mockResolvedValue({
      id: "merchant-id",
      status: "ACTIVE",
    });
    transaction.merchant.updateMany.mockResolvedValue({ count: 1 });

    await service.setAssignedMerchantStatus(
      createdAgent.id,
      "merchant-id",
      "pause",
      "203.0.113.1",
      "agent-browser",
    );

    expect(transaction.merchant.updateMany).toHaveBeenCalledWith({
      where: { id: "merchant-id", agentId: createdAgent.id, status: "ACTIVE" },
      data: { status: "SUSPENDED" },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        merchantId: "merchant-id",
        action: "AGENT_PAUSE_MERCHANT",
        before: { status: "ACTIVE", changedByAgentId: createdAgent.id },
        after: expect.objectContaining({
          status: "SUSPENDED",
          changedByAgentId: createdAgent.id,
        }),
        ipAddress: "203.0.113.1",
      }),
    });
  });

  it("does not allow an agent to pause an unassigned merchant", async () => {
    const { service, transaction } = createPortalService();
    transaction.merchant.findFirst.mockResolvedValue(null);

    await expect(
      service.setAssignedMerchantStatus(
        createdAgent.id,
        "other-merchant",
        "pause",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(transaction.merchant.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });
});
