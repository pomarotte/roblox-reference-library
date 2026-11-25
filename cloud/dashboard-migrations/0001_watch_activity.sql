CREATE TABLE IF NOT EXISTS watch_connections (
  owner TEXT NOT NULL,
  universe TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  PRIMARY KEY (owner, universe)
);

CREATE TABLE IF NOT EXISTS watch_events (
  owner TEXT NOT NULL,
  universe TEXT NOT NULL,
  event_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  challenger TEXT NOT NULL,
  next_check INTEGER,
  PRIMARY KEY (owner, universe, event_id)
);

CREATE INDEX IF NOT EXISTS watch_events_recent ON watch_events (owner, universe, at DESC, event_id DESC);
