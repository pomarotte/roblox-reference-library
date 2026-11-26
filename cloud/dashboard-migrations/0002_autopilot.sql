CREATE TABLE IF NOT EXISTS autopilot_games (
  owner TEXT NOT NULL,
  universe TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL,
  state TEXT NOT NULL,
  next_check INTEGER,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, universe)
);
CREATE INDEX IF NOT EXISTS autopilot_due ON autopilot_games (next_check) WHERE next_check IS NOT NULL;
