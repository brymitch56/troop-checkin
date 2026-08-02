# Contributing

Thanks for helping other troops run their own check-in! Ground rules that
keep this project shareable and safe:

- **Nothing troop-specific in source.** Troop identity, colors, portal URLs,
  phone numbers — all of it comes from `.env` / the setup wizard. PRs that
  hardcode a troop fail review.
- **No real PII anywhere.** Tests and fixtures use synthetic data only
  (`npm run make-roster`). All runtime PII stays under `data/`, which is
  gitignored.
- **No new npm dependencies** without discussing in an issue first. The app
  deliberately runs on a handful of vetted packages and a dependency-free
  frontend.
- **All tests green on both OSes.** `npm test` runs on ubuntu and windows in
  CI, plus a Docker build/boot smoke test; all are required.
- **Bump the service-worker `VERSION`** (public/sw.js) whenever any client
  asset changes, or deployed kiosks keep serving stale files.
- **SMS stays strictly opt-in** per youth↔guardian pair with stored, signed
  consent. Don't loosen that.

Releases are tagged on GitHub (zip + docker image) so adopters never need
`git clone` unless they want to. Maintainers: tag from a green main only.

Development: `npm test` for the suite, `node test/e2e-browser.js` for the
optional real-Chrome E2E (`npm install --no-save puppeteer` first).
