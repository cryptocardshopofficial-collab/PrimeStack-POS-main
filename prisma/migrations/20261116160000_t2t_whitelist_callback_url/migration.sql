-- Sender callback URL that receives a signed whitelist/ping notice so the
-- sender's own system is told when its egress IP is allowlisted and reachable.
ALTER TABLE "T2tIpWhitelist" ADD COLUMN IF NOT EXISTS "callback_url" TEXT;
