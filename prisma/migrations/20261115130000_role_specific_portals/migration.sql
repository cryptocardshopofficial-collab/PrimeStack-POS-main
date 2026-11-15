ALTER TYPE "UserRole" ADD VALUE 'MERCHANT';

ALTER TABLE "User"
ADD COLUMN "merchantId" TEXT,
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "User_merchantId_key" ON "User"("merchantId");

ALTER TABLE "User"
ADD CONSTRAINT "User_merchantId_fkey"
FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
