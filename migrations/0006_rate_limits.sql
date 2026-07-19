CREATE TABLE rate_limit_windows (
  action TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (action, scope_hash, window_start)
) STRICT;

CREATE INDEX idx_rate_limit_windows_expiry
  ON rate_limit_windows(expires_at);
