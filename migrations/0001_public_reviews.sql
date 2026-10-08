CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delete_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_rate_limits (
  address_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_rate_limits_expiry ON review_rate_limits (reset_at);
