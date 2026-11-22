-- Payment ingestion orchestration.
--
-- Adds the IncomingPayment record that tracks every inbound payment through
-- parse -> sanctions -> fraud -> resolve -> ledger post -> notify.
-- `reference` is unique per rail so a replayed message can never double-post.

-- CreateEnum
CREATE TYPE "PaymentRail" AS ENUM ('SWIFT_MT103', 'SWIFT_MT202', 'ISO20022', 'ACH', 'SEPA', 'FEDWIRE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECEIVED', 'SCREENING', 'SCREENED', 'FRAUD_CHECK', 'UNDER_REVIEW', 'PENDING_ASSIGNMENT', 'POSTING', 'POSTED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "IncomingPayment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "rail" "PaymentRail" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECEIVED',
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "valueDate" TEXT,
    "operationCode" TEXT,
    "charges" TEXT,
    "debtorName" TEXT,
    "debtorAccount" TEXT,
    "debtorBic" TEXT,
    "debtorCountry" TEXT,
    "creditorName" TEXT,
    "creditorAccount" TEXT,
    "creditorBic" TEXT,
    "creditorCountry" TEXT,
    "merchantId" TEXT,
    "walletId" TEXT,
    "journalEntryRef" TEXT,
    "sanctionsScreeningIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fraudVerdict" TEXT,
    "fraudRiskScore" INTEGER,
    "failureReason" TEXT,
    "reviewedBy" TEXT,
    "reviewNotes" TEXT,
    "metadata" JSONB,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncomingPayment_rail_reference_key" ON "IncomingPayment"("rail", "reference");

-- CreateIndex
CREATE INDEX "IncomingPayment_status_idx" ON "IncomingPayment"("status");

-- CreateIndex
CREATE INDEX "IncomingPayment_merchantId_idx" ON "IncomingPayment"("merchantId");

-- CreateIndex
CREATE INDEX "IncomingPayment_createdAt_idx" ON "IncomingPayment"("createdAt");

-- CreateIndex
CREATE INDEX "IncomingPayment_creditorAccount_idx" ON "IncomingPayment"("creditorAccount");

-- AddForeignKey
ALTER TABLE "IncomingPayment" ADD CONSTRAINT "IncomingPayment_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingPayment" ADD CONSTRAINT "IncomingPayment_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
