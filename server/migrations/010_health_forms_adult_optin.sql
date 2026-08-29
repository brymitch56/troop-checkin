-- Health-form tracking + adult SMS opt-in.
--
-- health_form_date / high_risk_form_date: populated by roster imports from
-- the TLC export's "Health Form" and "High Risk Form" columns (submission
-- dates, normalized to ISO YYYY-MM-DD when recognizable, raw string otherwise
-- — compare-time code parses defensively, same convention as
-- membership_expires). "High Risk Form" is the High Adventure medical
-- clearance — a separate form, kept a separate field. Both are
-- admin-editable; hand edits lock the field against imports like every
-- import-managed field. Forms are treated as valid for 12 months from
-- submission (see server/lib/healthForms.js).
ALTER TABLE person ADD COLUMN health_form_date TEXT;
ALTER TABLE person ADD COLUMN high_risk_form_date TEXT;

-- Adult self-consent for SMS messaging. Youth messaging consent stays on the
-- person_guardian link (001/004) — these columns are meaningful only for
-- adults (is_youth = 0), mirroring the link table's semantics: strictly
-- opt-in, 'yes' requires a stored signed consent form.
ALTER TABLE person ADD COLUMN sms_opt_in TEXT NOT NULL DEFAULT 'unknown'
  CHECK (sms_opt_in IN ('unknown','yes','stop'));
ALTER TABLE person ADD COLUMN consent_form_id INTEGER REFERENCES consent_form(id);
