-- Outbound webhook deliveries for the Integration API (docs/13-integration-api.md).
-- One row per event the app decided to send; a background sweep POSTs each
-- payload to the configured URL with an HMAC signature and retries with
-- backoff (1m, 5m, 30m, then 2h steps; ~24h of attempts before 'failed').
-- Payloads carry identifiers only (txn/event/person ids, member numbers,
-- TLC hashids) — never names or contact data. 'sent' rows are pruned after
-- TLC_RETAIN_DAYS (default 30 here); failed rows stay until retried.
CREATE TABLE webhook_delivery (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                 -- txn.created | txn.voided | ical.synced | test
  payload TEXT NOT NULL,              -- JSON body exactly as sent
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX idx_webhook_delivery_status ON webhook_delivery(status, next_attempt_at);
