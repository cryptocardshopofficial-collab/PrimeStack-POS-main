CREATE TABLE IF NOT EXISTS "T2tIpWhitelist" (
  ip TEXT NOT NULL PRIMARY KEY,
  note TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "T2tIpWhitelist_added_at_idx"
  ON "T2tIpWhitelist"(added_at DESC);
