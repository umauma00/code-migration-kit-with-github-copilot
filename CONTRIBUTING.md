# Maintaining this Copilot adaptation

Preserve the executable-original, fixed-rulebook and parity-first migration method.
Keep vendor-specific integration separate from the shared engine. Do not replace a
failed model call with mock output in production. Test doubles belong in tests only.

Run `npm test` and `npm run demo` before proposing a runner change. Preserve the
original dependency-map fixture output. Add focused regression coverage when changing
path validation, completion receipts, gate fingerprints or interruption behavior.
Update the JSON contracts and user instructions when changing their behavior.

CLI/SDK/IDE documentation changes frequently. Record the version or commit checked
in `UPSTREAM.json`; distinguish help/schema checks from real authenticated execution.
Do not label mocked model tests as live Copilot tests. Do not commit credentials,
user-level Copilot settings, actual migration inputs or usage/session logs.

Keep Apache-2.0 attribution and mark modified upstream files. Original experiment
results in RUN-NOTES.md are historical; add Copilot validation results separately.

## Documents

- User documents come in Japanese and English pairs (`X.md` and `X.en.md`) that link
  to each other. Change both in the same pull request.
- Every pull request bumps the plugin version in `plugin.json`, `package.json` and
  `.github/plugin/marketplace.json`, adds a `CHANGELOG.md` entry and an entry in
  `docs/UPGRADING.md` / `docs/UPGRADING.en.md` that says whether approvals go stale.
- `tests/doc-links.test.mjs` fails on a relative link that does not resolve and on a
  missing language twin. Link to past records by a pinned GitHub URL; they are no longer
  kept in the repository.
- Write Copilot usage as GitHub AI Credits. Date facts about Copilot CLI, VS Code and the
  Copilot app that were checked against their documentation.
