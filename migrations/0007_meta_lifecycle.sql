ALTER TABLE threads_connections
  ADD COLUMN oauth_granted_at INTEGER
  CHECK (oauth_granted_at IS NULL OR oauth_granted_at > 0);

CREATE INDEX idx_threads_connections_meta_lifecycle
  ON threads_connections(platform_user_id, oauth_granted_at, last_verified_at)
  WHERE connection_mode = 'meta_oauth' AND platform_user_id IS NOT NULL;

CREATE TABLE meta_lifecycle_requests (
  id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('deauthorize', 'data_deletion')),
  platform_user_id TEXT,
  platform_subject_digest TEXT NOT NULL CHECK (
    length(platform_subject_digest) = 64 AND
    platform_subject_digest NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  confirmation_code_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  lease_token TEXT UNIQUE,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  last_error_class TEXT,
  CHECK (
    (kind = 'data_deletion' AND confirmation_code_hash IS NOT NULL) OR
    (kind = 'deauthorize' AND confirmation_code_hash IS NULL)
  ),
  CHECK (
    (
      status = 'pending' AND platform_user_id IS NOT NULL AND
      lease_until IS NULL AND lease_token IS NULL AND completed_at IS NULL
    ) OR
    (
      status = 'processing' AND platform_user_id IS NOT NULL AND
      lease_until IS NOT NULL AND lease_token IS NOT NULL AND completed_at IS NULL
    ) OR
    (
      status = 'completed' AND platform_user_id IS NULL AND
      lease_until IS NULL AND lease_token IS NULL AND completed_at IS NOT NULL AND
      last_error_class IS NULL
    )
  )
) STRICT;

CREATE INDEX idx_meta_lifecycle_requests_retry
  ON meta_lifecycle_requests(status, next_attempt_at, lease_until);

CREATE INDEX idx_meta_lifecycle_requests_expiry
  ON meta_lifecycle_requests(status, expires_at);

CREATE INDEX idx_meta_lifecycle_requests_subject_cutoff
  ON meta_lifecycle_requests(platform_subject_digest, issued_at DESC);
