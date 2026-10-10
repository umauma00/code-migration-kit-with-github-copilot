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
