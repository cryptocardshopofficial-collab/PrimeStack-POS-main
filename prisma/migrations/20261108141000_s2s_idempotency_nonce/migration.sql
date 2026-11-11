CREATE TABLE IF NOT EXISTS "S2sIdempotency" (
  "id" TEXT PRIMARY KEY,
  "connectionId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "S2sIdempotency_connectionId_idempotencyKey_key"
  ON "S2sIdempotency"("connectionId", "idempotencyKey");

CREATE TABLE IF NOT EXISTS "S2sNonce" (
  "nonce" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
