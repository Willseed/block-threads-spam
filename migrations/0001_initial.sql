PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  identity_subject TEXT NOT NULL UNIQUE,
  email TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT
) STRICT;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
) STRICT;

CREATE TABLE threads_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  protected_username TEXT NOT NULL,
  platform_user_id TEXT,
  connection_mode TEXT NOT NULL CHECK (connection_mode IN ('meta_oauth', 'manual_handoff')),
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_identity_confirmation', 'connected', 'reauth_required', 'challenge_required',
    'revoking', 'revoked'
  )),
  revocation_version INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (tenant_id, protected_username)
) STRICT;

CREATE INDEX idx_threads_connections_tenant
  ON threads_connections(tenant_id, status);

CREATE TABLE candidate_rules (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES threads_connections(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  quota INTEGER NOT NULL CHECK (quota > 0),
  configuration_json TEXT NOT NULL,
  UNIQUE (connection_id, rule_type)
) STRICT;

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES threads_connections(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('generated', 'manual', 'historical')),
  source_rules_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'new', 'pending_review', 'watching', 'ignored', 'preparing_block', 'blocking',
    'blocked', 'needs_review', 'not_found', 'lookup_unavailable' -- NOSONAR - required by independent status domains.
  )),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  first_seen_at TEXT NOT NULL,
  last_checked_at TEXT,
  next_check_at TEXT,
  current_snapshot_id TEXT,
  UNIQUE (connection_id, normalized_username)
) STRICT;

CREATE INDEX idx_candidates_tenant_connection
  ON candidates(tenant_id, connection_id, status, priority);

CREATE TABLE candidate_snapshots (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('meta_api', 'manual_handoff', 'fixture')),
  platform_id TEXT,
  username TEXT NOT NULL,
  display_name TEXT,
  biography_excerpt TEXT,
  profile_picture_hash TEXT,
  external_link_summary TEXT,
  similarity_reasons_json TEXT NOT NULL,
  raw_response_hash TEXT,
  checked_at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence_objects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES threads_connections(id) ON DELETE CASCADE,
  candidate_id TEXT REFERENCES candidates(id) ON DELETE SET NULL,
  job_id TEXT,
  evidence_type TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retention_until TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES threads_connections(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN (
    'connect', 'scan', 'candidate_refresh', 'manual_block', 'health_check', 'revoke'
  )),
  scope_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'running', 'succeeded', 'stopped', 'needs_review')),
  phase TEXT NOT NULL,
  workflow_instance_id TEXT,
  idempotency_key_hash TEXT NOT NULL,
  error_class TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (tenant_id, idempotency_key_hash)
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  connection_id TEXT NOT NULL REFERENCES threads_connections(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  exact_target_username TEXT NOT NULL,
  target_platform_id TEXT,
  evidence_version TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'awaiting_reauth', 'issued', 'consuming', 'consumed', 'expired', 'revoked', 'needs_review'
  )),
  issued_at TEXT,
  expires_at TEXT,
  consumed_at TEXT
) STRICT;

CREATE TABLE browser_handoffs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES threads_connections(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id),
  browser_session_id TEXT NOT NULL,
  target_id TEXT,
  exchange_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'created', 'exchanged', 'active', 'completed', 'cancelled', 'expired', 'terminated'
  )),
  expires_at TEXT NOT NULL,
  exchanged_at TEXT,
  terminated_at TEXT
) STRICT;

CREATE TABLE schedule_preferences (
  connection_id TEXT PRIMARY KEY REFERENCES threads_connections(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  timezone TEXT NOT NULL,
  frequency_policy TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  lease_until TEXT
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id),
  connection_id TEXT REFERENCES threads_connections(id),
  job_id TEXT REFERENCES jobs(id),
  event_type TEXT NOT NULL,
  target_ref TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_events_tenant_created
  ON audit_events(tenant_id, created_at DESC);
