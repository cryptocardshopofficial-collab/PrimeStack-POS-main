ALTER TABLE "TerminalRegistrationRequest"
ADD COLUMN "customerMessage" TEXT NOT NULL DEFAULT '';

ALTER TABLE "TerminalRegistrationRequest"
ALTER COLUMN "customerMessage" DROP DEFAULT;
