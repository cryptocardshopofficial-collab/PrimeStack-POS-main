-- Payment hub extensions: sanctions screening + webhook orchestration.
--
-- Sanctions watchlists are imported by an operator (OFAC SDN, UN Consolidated,
-- EU, UK HMT, UAE local). No list data ships with the platform.
--
-- Webhook subscriptions carry an AES-256-GCM encrypted signing secret; only the
-- last four characters are ever returned to callers.

-- CreateEnum
CREATE TYPE "SanctionsListSource" AS ENUM ('OFAC', 'UN', 'EU', 'UK_HMT', 'UAE_LOCAL', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SanctionsEntityType" AS ENUM ('PERSON', 'COMPANY', 'BANK', 'COUNTRY');

-- CreateEnum
CREATE TYPE "SanctionsScreeningStatus" AS ENUM ('CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH', 'FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'EXHAUSTED');

-- CreateTable
CREATE TABLE "SanctionsListEntry" (
    "id" TEXT NOT NULL,
    "listSource" "SanctionsListSource" NOT NULL,
    "entityType" "SanctionsEntityType" NOT NULL,
    "primaryName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "country" TEXT,
    "bankName" TEXT,
    "program" TEXT,
    "listRef" TEXT,
    "remarks" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SanctionsListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SanctionsScreening" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "entityType" "SanctionsEntityType" NOT NULL,
    "inputName" TEXT NOT NULL,
    "inputCountry" TEXT,
    "bankName" TEXT,
    "status" "SanctionsScreeningStatus" NOT NULL DEFAULT 'CLEAR',
    "score" INTEGER NOT NULL DEFAULT 0,
    "matchedEntryId" TEXT,
    "matchedName" TEXT,
    "matchedList" "SanctionsListSource",
    "matchDetail" JSONB,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SanctionsScreening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL DEFAULT 'MERCHANT',
    "merchantId" TEXT,
    "eventNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "callbackUrl" TEXT NOT NULL,
    "description" TEXT,
    "secretCipher" TEXT NOT NULL,
    "secretLast4" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "reference" TEXT,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SanctionsListEntry_listSource_listRef_key" ON "SanctionsListEntry"("listSource", "listRef");

-- CreateIndex
CREATE INDEX "SanctionsListEntry_listSource_active_idx" ON "SanctionsListEntry"("listSource", "active");

-- CreateIndex
CREATE INDEX "SanctionsListEntry_entityType_idx" ON "SanctionsListEntry"("entityType");

-- CreateIndex
CREATE INDEX "SanctionsListEntry_country_idx" ON "SanctionsListEntry"("country");

-- CreateIndex
CREATE INDEX "SanctionsListEntry_primaryName_idx" ON "SanctionsListEntry"("primaryName");

-- CreateIndex
CREATE UNIQUE INDEX "SanctionsScreening_reference_key" ON "SanctionsScreening"("reference");

-- CreateIndex
CREATE INDEX "SanctionsScreening_status_createdAt_idx" ON "SanctionsScreening"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SanctionsScreening_inputName_idx" ON "SanctionsScreening"("inputName");

-- CreateIndex
CREATE INDEX "SanctionsScreening_matchedEntryId_idx" ON "SanctionsScreening"("matchedEntryId");

-- CreateIndex
CREATE INDEX "WebhookSubscription_active_eventNames_idx" ON "WebhookSubscription"("active", "eventNames");

-- CreateIndex
CREATE INDEX "WebhookSubscription_merchantId_idx" ON "WebhookSubscription"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_subscriptionId_eventId_key" ON "WebhookDelivery"("subscriptionId", "eventId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_eventName_createdAt_idx" ON "WebhookDelivery"("eventName", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_createdAt_idx" ON "WebhookDelivery"("subscriptionId", "createdAt");

-- AddForeignKey
ALTER TABLE "SanctionsScreening" ADD CONSTRAINT "SanctionsScreening_matchedEntryId_fkey" FOREIGN KEY ("matchedEntryId") REFERENCES "SanctionsListEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
