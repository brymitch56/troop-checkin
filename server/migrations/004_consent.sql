-- SMS consent (opt-in gating). A consent form (scanned paper) can cover many
-- youth/guardian pairs; each pair links to the form that authorizes it.
CREATE TABLE consent_form (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  signed_by TEXT,
  signed_on TEXT,
  notes TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  staff_id INTEGER REFERENCES staff(id)
);
ALTER TABLE person_guardian ADD COLUMN consent_form_id INTEGER REFERENCES consent_form(id);
