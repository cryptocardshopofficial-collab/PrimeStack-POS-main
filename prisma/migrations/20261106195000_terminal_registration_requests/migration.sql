CREATE TABLE "TerminalRegistrationRequest" (
    "id" TEXT NOT NULL,
    "agentCode" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "senderPublicIp" TEXT NOT NULL,
    "senderTerminalId" TEXT NOT NULL,
    "senderServerUrl" TEXT NOT NULL,
    "operatingCurrency" TEXT NOT NULL,
    "businessPurpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalRegistrationRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TerminalRegistrationRequest_agentCode_idx" ON "TerminalRegistrationRequest"("agentCode");
CREATE INDEX "TerminalRegistrationRequest_status_idx" ON "TerminalRegistrationRequest"("status");
CREATE INDEX "TerminalRegistrationRequest_createdAt_idx" ON "TerminalRegistrationRequest"("createdAt");
