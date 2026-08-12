# Instructions for AI assistants working in this repo

## THIS REPO IS PUBLIC — NEVER COMMIT PII. NO EXCEPTIONS.

Git history is permanent and this project serves a youth organization, so a
leaked name is a child's name. Before EVERY commit, scan the full diff
(`git diff --cached`) for the items below; if any appear, fix them BEFORE
committing — never plan to "clean it up later," and treat anything that
slipped into an earlier commit as an incident that requires a history
rewrite, not just a follow-up commit.

Never commit, in any file (code, tests, docs, fixtures, comments, commit
messages, screenshots):

- Real names of troop members, youth, parents/guardians, or leaders —
  test fixtures use invented names ("Andrews, Ben", "Danny Anderson", the
  synthetic-roster generator), never names from the real roster
- Phone numbers, email addresses, home addresses, birthdates (test phones
  are 555-xxxx; test emails end in @example.com)
- Trail Life Connect identifiers: user/event hashids, member numbers,
  badge codes — docs use `<userHashid>`-style placeholders
- Real roster counts, real event titles, or anything else that profiles
  the troop; keep examples generic ("Weekly Meeting", "~90 members")
- Credentials of any kind: passwords, tokens, cookies, API keys, .env
  values — mock creds must be self-evidently fake
  ("fake-password-never-real")
- Database files, roster exports (xlsx/csv), signature images, anything
  under data/ — the .gitignore fences these; never weaken it

Troop-identifying references (troop number, deployment domain) stay out of
new code and docs — this codebase is troop-agnostic; branding belongs in
env/config on the deployment, not in the source.

## Housekeeping

- `npm test` must pass before any push (Node's built-in runner; no globs)
- Changes to files cached by public/sw.js require a VERSION bump (tc-vNN)
  or kiosks keep the stale shell
- DB changes go through numbered files in server/migrations/ — never edit
  an applied migration
- Deployment is a human-triggered Claude Code session on the Pi — never
  push anything that changes runtime behavior silently (features ship
  behind admin-UI switches, off by default)
