# 05 — Survey build and repair

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: every translation unit has a current reviewed receipt. The user
approves build for these outputs, then run `run_migration.mjs build` once.

Read `migration/results/build.json`. Exit code, diagnostics and the source/output
fingerprints are the evidence. A failed command never counts as a clean build.
The retained Bash daemon writes an exit-code sidecar and --once propagates failure;
the Node runner is the portable reference path.

Parse diagnostics with the target toolchain into a machine queue by file, module,
error code and message. The kit does not supply one parser for every language.
Resolve each affected file to its manifest unit. Put a concise diagnostic slice
under `migration/`, then use:

`run_migration.mjs repair --target ported/PATH --evidence migration/ERROR-SLICE`

Reviewers verify the evidence against the code; the arbiter confirms findings;
fixers apply confirmed changes and receive no compiler tool. Review again.
Approve and run a fresh build after repaired outputs invalidate the previous gate.

If several rounds repeat the same error class, stop and propose a rule amendment.
Do not have every worker independently build the whole tree. Report counts by
round and stop at the clean-build gate. If a cheap typecheck ran in-loop, still
perform the agreed final integration build/check before smoke.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
