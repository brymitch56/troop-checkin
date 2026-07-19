-- Phase 2: override auditing
ALTER TABLE txn ADD COLUMN forced INTEGER NOT NULL DEFAULT 0;
