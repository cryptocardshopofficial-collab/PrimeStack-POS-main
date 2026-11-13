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
});
