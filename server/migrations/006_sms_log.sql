-- Full SMS message log: every message sent or received, including broadcast
-- replies (which previously were answered with a canned hint and discarded).
CREATE TABLE sms_message (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind TEXT NOT NULL DEFAULT 'reply'
    CHECK (kind IN ('lingering', 'custom', 'reply', 'keyword')),
  guardian_id INTEGER REFERENCES person(id),
  phone TEXT,
  body TEXT,
  twilio_sid TEXT,
  status TEXT
);
CREATE INDEX idx_sms_message_at ON sms_message(at);
CREATE INDEX idx_sms_message_sid ON sms_message(twilio_sid);
