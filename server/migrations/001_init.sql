-- Troop Check-In schema v1 (data model doc v0.2)
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE person (
  id INTEGER PRIMARY KEY,
  is_youth INTEGER NOT NULL DEFAULT 0,
  member_id TEXT UNIQUE,
  badge_code TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  nickname TEXT,
  role TEXT,
  patrol TEXT,
  level TEXT,
  email TEXT,
  tlc_username TEXT,
  phone_mobile TEXT,
  phone_home TEXT,
  phone_work TEXT,
  birthdate TEXT,
  last_emerg_phone_1 TEXT,
  last_emerg_phone_2 TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','visitor','merged')),
  merged_into_id INTEGER REFERENCES person(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_person_name   ON person(last_name, first_name);
CREATE INDEX idx_person_patrol ON person(patrol) WHERE is_youth = 1;

CREATE TABLE person_guardian (
  youth_id    INTEGER NOT NULL REFERENCES person(id),
  guardian_id INTEGER NOT NULL REFERENCES person(id),
  relationship TEXT,
  authorized  INTEGER NOT NULL DEFAULT 1,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('import_email','import_address','manual')),
  sms_opt_in  TEXT NOT NULL DEFAULT 'unknown'
    CHECK (sms_opt_in IN ('unknown','yes','stop')),
  PRIMARY KEY (youth_id, guardian_id)
);

CREATE TABLE staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'door' CHECK (role IN ('door','admin')),
  pin_hash TEXT,
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE session (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL
);

CREATE TABLE event (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('ical','manual')),
  ical_uid TEXT,
  title TEXT NOT NULL,
  location TEXT,
  description TEXT,
  start_at TEXT NOT NULL,
  end_at   TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  track_adults INTEGER NOT NULL DEFAULT 0,
  notify_after_min INTEGER,
  removed_from_feed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ical_uid, start_at)
);
CREATE INDEX idx_event_window ON event(start_at, end_at);

CREATE TABLE txn (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES event(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  signed_at   TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  signer_person_id INTEGER REFERENCES person(id),
  signer_name_override TEXT,
  signature_path TEXT,
  close_method TEXT CHECK (close_method IN ('signature','sms_confirm','admin_close')),
  sms_sid TEXT,
  voided_by_txn_id INTEGER REFERENCES txn(id)
);
CREATE INDEX idx_txn_event ON txn(event_id);

CREATE TABLE txn_person (
  txn_id    INTEGER NOT NULL REFERENCES txn(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  open INTEGER NOT NULL DEFAULT 0,
  in_txn_id INTEGER REFERENCES txn(id),
  emerg_phone_1 TEXT,
  emerg_phone_2 TEXT,
  PRIMARY KEY (txn_id, person_id)
);
CREATE INDEX idx_txn_person_open ON txn_person(person_id, open);

CREATE TABLE notification (
  id INTEGER PRIMARY KEY,
  person_id   INTEGER NOT NULL REFERENCES person(id),
  guardian_id INTEGER NOT NULL REFERENCES person(id),
  event_id    INTEGER NOT NULL REFERENCES event(id),
  channel TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','push')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent','delivered','replied_y','failed')),
  twilio_sid TEXT
);

CREATE TABLE roster_import (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  staff_id INTEGER REFERENCES staff(id),
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  deactivated INTEGER NOT NULL DEFAULT 0,
  linked_guardians INTEGER NOT NULL DEFAULT 0,
  raw_file_path TEXT
);
