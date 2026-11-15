-- Merchant portal access PIN.
-- Stores a bcrypt hash of the admin-issued numeric PIN that merchants must
-- supply in addition to their email and password. Staff accounts leave it null.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "portalPinHash" TEXT;
