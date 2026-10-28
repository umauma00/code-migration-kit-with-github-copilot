# 04 — Translation and independent review

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Command guardrails: `phase start 04` refuses to start without `migration/guardrails.json`
(adapted to this target) or a recorded waiver. Installing it is the human's act, because
that is when they decide the referee price: propose the list from `guardrails show` in
chat, and only after their agreement run `guardrails install` with exactly those options;
the host asks them to confirm it. Never create, edit or relax the file any other way. If a guardrail
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
Run `translate` in a background or continuing terminal and check it with
`status --fast --wait 600 --format markdown`. This waits for status only; keep
polling the same job after it returns. Never kill/cancel/relaunch work for CPU
at 100% or low CPU, silence, elapsed time or output volume. Normal execution is
continuous even with old 600-second/maxAgentCalls settings. Finite time/call/round
limits require the person's explicit choice (executionMode bounded or a command
budget). Execution-policy changes retain reviewed work and approvals.
Failures name the CLI's own cause (for example `session.error rate_limit 429`).
The configured `fixPolicy` decides whether a fixed output is reviewed again
(`rereview`) or judged by build/smoke/parity after one fix (`single-pass`,
upstream); `dependencyOrder` decides whether dependents wait for reviewed
dependencies. Report both settings with the burndown.

The runner performs implementation → two independent reviews → arbitration of
every finding (findings both reviewers raise at the same source path:line reach
the arbiter as a pair, since they can still ask for different changes; the
arbiter defaults to not confirmed) → confirmed fixes → re-review (skipped with `fixPolicy: single-pass`) →
hash-bound completion. Workers use
explicit models from config and structured results. Reviewers have no tools and
receive identical frozen inputs; other CLI workers have read/search-only tools.
If a unit's evidence exceeds maxReviewInputBytes, the CLI runner automatically
gives both reviewers the same SHA-256-bound file list on read-only `-read`
profiles. Report every `toolAssistedReviews` target and warning to the human.
Only the coordinator writes the assigned manifest target. Existing output files
without reviewed receipts are unfinished and must be reviewed.

Keep source, judge, rulebook, inventory, review dependency map and execution settings immutable inside
the run. Missing decisions get TODO(port), BUG(port) or PERF(port) markers.
No source “improvement” is mixed into faithful translation. Expensive compiler
and test commands wait for their phases; an explicitly configured cheap
per-target typecheck is owned by the coordinator; its failure becomes a confirmed
finding for the fixer (maxFixRounds applies only in bounded mode) (README Step 4 dissolved into Step 3).

On timeout, rejected permission, invalid JSON or interrupted execution, inspect
`migration/state/units/` and the run summary. Reinvoke `translate` to resume.
Do not manually fabricate done receipts. A lock whose owner process has stopped
on this host is removed by the rerun; use `unlock --pid` only for a lock from
another host, or a PID now reused by an unrelated process, after confirming that
run stopped. Respect the configured call/repair limits.

Report reviewed done/total, blocked targets, measured time and actual usage when
available. Unknown usage stays unknown. Stop before build approval.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

Keep orchestration in the user-facing parent: launch translate in a background
or continuing terminal and check `status --wait` while it runs; do not block the parent
waiting for the terminal to finish. The runner refills available slots and, per
`dependencyOrder`, orders manifest jobs by audited dependencies. Non-manifest dependencies stay
fixed source evidence. Cycles use fixed source when typecheck is deferred; with
unit typecheck configured, resolve/group the cycle or explicitly defer that check
with user authorization. All AI calls, including both reviewers, share concurrency.
Read status --format markdown for blockers and actual active roles.
