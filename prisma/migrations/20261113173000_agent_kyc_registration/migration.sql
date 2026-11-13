CREATE TABLE "AgentKycProfile" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "encryptedProfile" TEXT NOT NULL,
    "encryptedIdentityDocument" TEXT NOT NULL,
    "encryptedProfilePhoto" TEXT NOT NULL,
    "verificationStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "encryptedReviewNotes" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentKycProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentKycProfile_agentId_key" ON "AgentKycProfile"("agentId");

CREATE INDEX "AgentKycProfile_verificationStatus_createdAt_idx"
ON "AgentKycProfile"("verificationStatus", "createdAt");

ALTER TABLE "AgentKycProfile"
ADD CONSTRAINT "AgentKycProfile_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentCredential" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "pinFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentCredential_agentId_key" ON "AgentCredential"("agentId");
CREATE UNIQUE INDEX "AgentCredential_pinFingerprint_key" ON "AgentCredential"("pinFingerprint");

ALTER TABLE "AgentCredential"
ADD CONSTRAINT "AgentCredential_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
