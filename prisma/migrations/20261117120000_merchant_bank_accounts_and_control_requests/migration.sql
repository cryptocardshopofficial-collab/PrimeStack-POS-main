-- Merchant-owned saved bank accounts: details are typed once, stored encrypted
-- and only ever returned masked, so payouts select an account instead of asking
-- for the account number again.
CREATE TABLE "MerchantBankAccount" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "bankName" VARCHAR(160) NOT NULL,
    "accountName" VARCHAR(160) NOT NULL,
    "accountLast4" VARCHAR(4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "encryptedDetails" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantBankAccount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MerchantBankAccount_merchantId_createdAt_idx" ON "MerchantBankAccount"("merchantId", "createdAt");

ALTER TABLE "MerchantBankAccount" ADD CONSTRAINT "MerchantBankAccount_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Merchant-initiated hold/resume requests. A merchant asks an administrator to
-- pause a transaction (optionally reported as suspicious) or to release a hold;
-- the transaction only changes once an administrator approves the request.
CREATE TABLE "MerchantTransactionControlRequest" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "action" "AgentTransactionControlAction" NOT NULL,
    "suspicious" BOOLEAN NOT NULL DEFAULT false,
    "status" "AgentTransactionControlStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(1000) NOT NULL,
    "merchantResponse" VARCHAR(1000),
    "previousStatus" "TransactionStatus",
    "adminRemarks" VARCHAR(1000),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantTransactionControlRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MerchantTransactionControlRequest_merchantId_status_createdAt_idx" ON "MerchantTransactionControlRequest"("merchantId", "status", "createdAt");

CREATE INDEX "MerchantTransactionControlRequest_transactionId_createdAt_idx" ON "MerchantTransactionControlRequest"("transactionId", "createdAt");

ALTER TABLE "MerchantTransactionControlRequest" ADD CONSTRAINT "MerchantTransactionControlRequest_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MerchantTransactionControlRequest" ADD CONSTRAINT "MerchantTransactionControlRequest_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MerchantTransactionControlRequest" ADD CONSTRAINT "MerchantTransactionControlRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
