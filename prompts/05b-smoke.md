# 05b — Execute the smallest meaningful scenario

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: clean build receipt and explicit smoke approval for these outputs.
Run `run_migration.mjs smoke`. The configured command should start the program,
execute a minimal public operation, assert the expected result and terminate.
A process that merely starts or exits zero without checking behavior is not enough.
Keep logs and report the scenario and exit status. Stop before parity approval.
