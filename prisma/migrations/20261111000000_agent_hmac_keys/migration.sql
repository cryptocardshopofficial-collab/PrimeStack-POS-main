ALTER TABLE "HmacKey"
ADD COLUMN "agentId" TEXT;

ALTER TABLE "HmacKey"
ADD CONSTRAINT "HmacKey_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HmacKey"
ADD CONSTRAINT "HmacKey_merchantId_agentId_check"
CHECK ("merchantId" IS NULL OR "agentId" IS NULL);

CREATE INDEX "HmacKey_agentId_idx" ON "HmacKey"("agentId");

CREATE UNIQUE INDEX "HmacKey_agentId_active_key"
ON "HmacKey"("agentId")
WHERE "agentId" IS NOT NULL AND "status" = 'ACTIVE';
