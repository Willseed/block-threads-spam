CREATE TABLE oauth_attempts (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES threads_connections(id) ON DELETE CASCADE,
  session_binding TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  job_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_oauth_attempts_expiry
  ON oauth_attempts(expires_at, consumed_at);
