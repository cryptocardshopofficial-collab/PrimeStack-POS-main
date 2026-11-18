ALTER TYPE "TransactionStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';

CREATE TYPE "AgentTransactionControlAction" AS ENUM ('HOLD', 'RESUME');
CREATE TYPE "AgentTransactionControlStatus" AS ENUM (
  'PENDING',
  'INFO_REQUESTED',
  'APPROVED',
  'REJECTED'
);

CREATE TABLE "AgentTransactionControlRequest" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "action" "AgentTransactionControlAction" NOT NULL,
  "status" "AgentTransactionControlStatus" NOT NULL DEFAULT 'PENDING',
  "reason" VARCHAR(1000) NOT NULL,
  "agentResponse" VARCHAR(1000),
  "previousStatus" "TransactionStatus",
  "adminRemarks" VARCHAR(1000),
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentTransactionControlRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentTransactionControlRequest_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentTransactionControlRequest_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentTransactionControlRequest_agentId_status_createdAt_idx"
  ON "AgentTransactionControlRequest"("agentId", "status", "createdAt");
CREATE INDEX "AgentTransactionControlRequest_transactionId_createdAt_idx"
  ON "AgentTransactionControlRequest"("transactionId", "createdAt");
CREATE UNIQUE INDEX "AgentTransactionControlRequest_one_open_per_transaction_idx"
  ON "AgentTransactionControlRequest"("transactionId")
  WHERE "status" IN ('PENDING', 'INFO_REQUESTED');
