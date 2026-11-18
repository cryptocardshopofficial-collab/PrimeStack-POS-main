-- Persist real Wise receiving-account details alongside the local wallet identifier.
ALTER TABLE "VirtualAccount" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "VirtualAccount" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "VirtualAccount" ADD COLUMN IF NOT EXISTS "details" JSONB;
