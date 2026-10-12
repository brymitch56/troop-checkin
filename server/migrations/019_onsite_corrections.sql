-- On-site corrections across concurrent events.
--
-- When two events overlap, a youth is sometimes signed into the wrong one (the
-- kiosk had the other event selected) or belongs in both. Door staff fix that
-- from the On-site screen:
--   move — the person's open sign-in is re-filed under the other event
--          (a new sign-in txn there, same time / signer / signature; the
--          person's row moves onto it — other people on the original group
--          sign-in are untouched)
--   copy — a linked second sign-in in the other event; one sign-out later
--          closes every linked sign-in and records attendance for each event
--   remove — undo a copy: the person leaves one of their linked sign-ins
-- Each correction is one row here: who, from which sign-in, to which, when.
-- Linked sign-ins are found by walking move/copy rows for the same person.
CREATE TABLE txn_correction (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('move', 'copy', 'remove')),
  person_id   INTEGER NOT NULL REFERENCES person(id),
  from_txn_id INTEGER NOT NULL REFERENCES txn(id),
  to_txn_id   INTEGER REFERENCES txn(id),
  staff_id    INTEGER REFERENCES staff(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_txn_correction_person ON txn_correction(person_id);
