# 04 — Translation and independent review

Prerequisites: reviewed feasibility/stress reports, RULEBOOK, inventory,
manifest, audited review dependency map, validated judge, installed profiles and
explicit translation approval.

Use `node migration-kit/scripts/run_migration.mjs translate` from the target
repository. Use the path without `migration-kit/` only when running this kit itself.
Do not replace the runner with fleet or an unrestricted chat loop.

The runner performs implementation → two independent reviews → arbitration of
findings → confirmed fixes → re-review → hash-bound completion. Workers use
explicit models from config and structured results. Reviewers have no tools and
receive identical frozen inputs; other workers have read/search-only tools.
Only the coordinator writes the assigned manifest target. Existing output files
without reviewed receipts are unfinished and must be reviewed.

Keep source, judge, rulebook, inventory, review dependency map and execution settings immutable inside
the run. Missing decisions get TODO(port), BUG(port) or PERF(port) markers.
No source “improvement” is mixed into faithful translation. Expensive compiler
and test commands wait for their phases; an explicitly configured cheap
per-target typecheck is owned by the coordinator.

On timeout, rejected permission, invalid JSON or interrupted execution, inspect
`migration/state/units/` and the run summary. Reinvoke `translate` to resume.
Do not manually fabricate done receipts. A stale process lock requires checking
the owner process before `unlock --pid`. Respect the configured call/repair limits.

Report reviewed done/total, blocked targets, measured time and actual usage when
available. Unknown usage stays unknown. Stop before build approval.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
