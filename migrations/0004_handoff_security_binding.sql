ALTER TABLE browser_handoffs ADD COLUMN approval_id TEXT REFERENCES approvals(id);
ALTER TABLE browser_handoffs ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE browser_handoffs ADD COLUMN session_binding TEXT;
ALTER TABLE browser_handoffs ADD COLUMN exact_target_username TEXT;
ALTER TABLE browser_handoffs ADD COLUMN target_platform_id TEXT;
ALTER TABLE browser_handoffs ADD COLUMN capability_issued_at TEXT;
ALTER TABLE browser_handoffs ADD COLUMN lease_generation INTEGER;
