# 04 — Translation and independent review

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Command guardrails: `phase start 04` refuses to start until the human has copied
`templates/guardrails.json` to `migration/guardrails.json` (adapted to this target) or
recorded a waiver there. Never create, edit or relax that file yourself: installing it is
the human's act, because that is when they decide the referee price. If a guardrail
denies a command, that is the design working; report it instead of routing around it.
Run `doctor` and confirm `repository hooks load in Copilot CLI` is not failing.

Prerequisites: reviewed feasibility/stress reports, RULEBOOK, inventory,
manifest, audited review dependency map, validated judge, installed profiles and
explicit translation approval.

Use [bounded translation batches](../docs/EXECUTION-SCOPES.md) where the human
wants intermediate gates: approve translation --batch N or --targets CSV binds
concrete units, separate from maxAgentCalls. Stop after that approved scope,
report burndown/unknown timing and wait for the next batch instruction. Never
convert a completed batch into permission for build or remaining translation.
When markerPolicy is configured, both reviews receive measured TODO line counts;
the coordinator rejects a mismatched final trailer before recording done.

Use `node migration-kit/scripts/run_migration.mjs translate` from the target
repository for repository-copy installations. For plugin installations, use
`node "<absolute-plugin-root>/scripts/run_migration.mjs" translate` with the same
target repository as cwd. Resolve the plugin root from the loaded skill/agent.
Do not replace the runner with fleet or an unrestricted chat loop.

Select the execution path from config.workerBackend. For native, follow
[native workers](../docs/NATIVE-WORKERS.md): keep the Node runner active, claim
pending tasks, invoke the named tool-free host subagents with the requested model
and exact prompt, and submit their unchanged JSON. Do not wait on the runner
without servicing its tasks. Never silently fall back to Copilot CLI.

The runner performs implementation → two independent reviews → arbitration of
findings → confirmed fixes → re-review → hash-bound completion. Workers use
explicit models from config and structured results. Reviewers have no tools and
receive identical frozen inputs; other CLI workers have read/search-only tools.
Native workers all have no tools and receive self-contained frozen inputs.
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

Keep orchestration in the user-facing parent. For native, launch translate in a
continuing terminal and service claim/delegate/submit while it runs; do not block
the parent waiting for the terminal to finish. The runner refills available slots
and orders manifest jobs by audited dependencies. Non-manifest dependencies stay
fixed source evidence. Cycles use fixed source when typecheck is deferred; with
unit typecheck configured, resolve/group the cycle or explicitly defer that check
with user authorization. All AI calls, including both reviewers, share concurrency.
Read status --format markdown for blockers and actual active roles.
