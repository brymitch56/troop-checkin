-- Automated roster sync (docs/10-roster-sync.md): a successful fetch stages
-- exactly one PENDING import — preview only, replacing any prior pending row.
-- Committing is always a human decision in the admin UI (Approve/Discard).
CREATE TABLE pending_import (
  id INTEGER PRIMARY KEY,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  file_path TEXT NOT NULL,          -- under data/roster-exports/ (gitignored PII)
  rows INTEGER NOT NULL,            -- parsed people count
  source TEXT NOT NULL DEFAULT 'sync',
  preview_json TEXT NOT NULL,       -- {total,youth,adults,added[],updated[],deactivated[]}
  replaced_count INTEGER NOT NULL DEFAULT 0
);
