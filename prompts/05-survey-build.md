# 05 — Survey build and repair

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: every translation unit has a current reviewed receipt. The user
approves build for these outputs, then run `run_migration.mjs build` once.

Read `migration/results/build.json`. Exit code, diagnostics and the source/output
fingerprints are the evidence. A failed command never counts as a clean build.
The retained Bash daemon writes an exit-code sidecar and --once propagates failure;
the Node runner is the portable reference path.

After a failed build, run `run_migration.mjs repair-round` (or `diagnose` to
only build the queue). The bundled parsers read the recorded build output
(Python, Java/Maven, JavaScript/Node/ESLint/tsc, shell/ShellCheck, rustc and the
generic FILE:LINE:COL: error form), map each error to its manifest target and
write `migration/build-diagnostics/<build>.tsv`, `migration/repair-queue.json` and
a row in `migration/build-rounds.tsv`. Never re-derive the list by judgment. If
the command reports no mapped diagnostic, show the human the unmapped lines and
build record; for an unsupported format, produce the same TSV with a reviewed
adapter. Report the round-over-round counts from `migration/build-rounds.tsv`.
For a single manual slice you can still use:

`run_migration.mjs repair --target ported/PATH --evidence migration/ERROR-SLICE`

For multiple independent targets, use the [single-coordinator queue](../docs/EXECUTION-SCOPES.md):
write file/module/code/message TSV from this build, run diagnostic_queue.mjs,
then repair --queue migration/repair-queue.json. Ensure those targets are within
the current explicit translation/repair approval. The coordinator keeps one lock,
caps all AI calls and waits for dependent slice reviews; do not run competing
repair processes or disable the global lock. Join repairs before one whole build.
The coordinator admits every queued job durably before dispatch. On Stop, inspect
status pendingRepairs and resume translate within the existing approval; unfinished
jobs cannot reuse their old done receipts. Keep the immutable intent archives.
Do not replay a stale queue, drop its unstarted jobs, or replace frozen diagnostics.
Count TODO(port) lines mechanically against the final PORT STATUS todos value;
with todo-lines-v1 the measured check is also bound to Node's completion receipt.

Reviewers verify the evidence against the code; the arbiter confirms findings;
fixers apply confirmed changes and receive no compiler tool. Review again.
Approve and run a fresh build after repaired outputs invalidate the previous gate.

If several rounds repeat the same error class, stop and propose a rule amendment.
Do not have every worker independently build the whole tree. Report counts by
round and stop at the clean-build gate. If a cheap typecheck ran in-loop, still
perform the agreed final integration build/check before smoke.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
