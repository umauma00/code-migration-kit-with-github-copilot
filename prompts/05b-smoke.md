# 05b — Execute the smallest meaningful scenario

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: clean build receipt and explicit smoke approval for these outputs.
Run `run_migration.mjs smoke`. The configured command should start the program,
execute a minimal public operation, assert the expected result and terminate.
A process that merely starts or exits zero without checking behavior is not enough.
Keep logs and report the scenario and exit status. Stop before parity approval.

If smoke fails because of the translation, run `run_migration.mjs repair-round --stage smoke`:
output lines that name translated files become the reviewed repair queue (the same
review, arbitration and fix path as build errors, rounds in `migration/smoke-rounds.tsv`).
When no line names a target, triage the failure, write the confirmed defects as
`file<TAB>module<TAB>code<TAB>message` rows and run `diagnostic_queue.mjs --stage smoke
--diagnostics migration/PATH.tsv`, then `repair --queue migration/repair-queue.json`.
The repaired outputs need fresh build and smoke approvals.
