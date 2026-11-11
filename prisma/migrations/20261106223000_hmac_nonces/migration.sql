CREATE TABLE "HmacNonce" (
  "id" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HmacNonce_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HmacNonce_keyId_nonce_key" ON "HmacNonce"("keyId", "nonce");
CREATE INDEX "HmacNonce_expiresAt_idx" ON "HmacNonce"("expiresAt");
