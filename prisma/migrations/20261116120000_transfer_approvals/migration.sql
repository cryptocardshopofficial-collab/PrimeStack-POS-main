-- Merchant transfer approval workflow + platform commission.

ALTER TYPE "TransferStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TYPE "TransferType" ADD VALUE IF NOT EXISTS 'BANK_PAYOUT';
ALTER TYPE "TransferType" ADD VALUE IF NOT EXISTS 'CRYPTO_PAYOUT';

CREATE TYPE "TransferApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Transfer"
ADD COLUMN "approvalStatus" "TransferApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN "approvalRequestedBy" TEXT,
ADD COLUMN "approvedBy" TEXT,
ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "rejectedBy" TEXT,
ADD COLUMN "rejectedAt" TIMESTAMP(3),
ADD COLUMN "rejectionReason" TEXT,
ADD COLUMN "commissionAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
ADD COLUMN "commissionAccountId" TEXT,
ADD COLUMN "commissionProfileId" TEXT;

CREATE INDEX "Transfer_approvalStatus_idx" ON "Transfer"("approvalStatus");
