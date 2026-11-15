-- Merchant-scoped T2T IP whitelist.
-- Administrators keep the global list (merchant_id IS NULL); each merchant
-- manages its own sender IPs, so one merchant can never whitelist IPs for
-- another.

ALTER TABLE "T2tIpWhitelist" ADD COLUMN IF NOT EXISTS "id" TEXT;
UPDATE "T2tIpWhitelist"
  SET "id" = md5(random()::text || clock_timestamp()::text)
  WHERE "id" IS NULL;
ALTER TABLE "T2tIpWhitelist" ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE "T2tIpWhitelist" ADD COLUMN IF NOT EXISTS "merchant_id" TEXT;

ALTER TABLE "T2tIpWhitelist" DROP CONSTRAINT IF EXISTS "T2tIpWhitelist_pkey";
ALTER TABLE "T2tIpWhitelist" ADD CONSTRAINT "T2tIpWhitelist_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX IF NOT EXISTS "T2tIpWhitelist_merchant_ip_key"
  ON "T2tIpWhitelist"("merchant_id", "ip");
CREATE INDEX IF NOT EXISTS "T2tIpWhitelist_ip_idx"
  ON "T2tIpWhitelist"("ip");
