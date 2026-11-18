-- Two-factor authentication (TOTP) for console/API sign-in.
--
-- mfaEnabled/mfaSecret were declared in schema.prisma but never captured in a
-- migration. ADD COLUMN IF NOT EXISTS keeps this safe to apply against a
-- database that already carries the columns (e.g. one originally created with
-- `prisma db push`).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT;
