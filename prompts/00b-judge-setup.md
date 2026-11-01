# 00b — Establish a trustworthy judge

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: feasibility reviewed. Stop after the judge report.

Save the judge design and preparation results in `migration/judge-report.md`,
including test/scenario paths, configured commands, coverage and failures. This
report is not the runner's validation receipt. The formal judge runs after 02:
its receipt is `migration/results/judge.json` and phase 03's report states its
result. Write no pending-judge status here and never come back to update this
file for it: the 00b record binds the file, so a later edit makes 00b to 02 be
recorded again, which ends a prepared pilot.

For verificationMode source-only, follow [source-only preparation](../docs/SOURCE-ONLY.md).
Do not require an executable original environment or original/mutation commands.
Prepare migration/judge-plan.json with real source and scenario inputs, inferred
contracts and explicit unverified limitations; save the explanation in judge-report.md.
After 01/02, judge validates this preparation without executing the original.
Never describe inferred expected values as observed. The report alone is not a receipt.

The following executable harness requirements apply to runtime mode only.
Keep the old code executable. Decide whether inherited tests exercise the public
surface (API, CLI, wire format, exported interface). If so, retain them. Otherwise
build a language-neutral parity harness before any production translation.

- Include ordinary, boundary, error, numeric, Unicode and serialization cases.
- Define normalization narrowly and explicitly; do not erase meaningful whitespace,
  collapse NaN/infinity into null, or hide ordering differences accidentally.
- Validate the harness against the original, then against intentionally broken
  implementations. It must accept the original and reject each intended defect.
- Put the judge and scenario files under config `verificationRoots` so changing
  them invalidates approvals and receipts.
- In runtime mode, configure `commands.original`, `commands.mutation` and `commands.parity` as argv
  arrays. The mutation command exits zero only when the judge catches the defects.
- Use `run_migration.mjs judge-prepare` now, before maps/rules exist, and record
  existing-judge reuse where adequate. Later `judge` binds the complete 01/02
  inputs, explicitly reusing unchanged early command evidence where available.
- Follow the [preparation audit contract](../docs/PREPARATION-AUDITS.md): when
  assertions are ported, two independent hostile auditors compare disjoint
  assertion batches against the old assertions and narrow normalization rules.
  Confirm weaknesses, repair and re-audit the repaired assertions once with fresh
  contexts; report weaknesses still confirmed after that one round as open
  limitations instead of repairing again. Mutation detection
  is an additional check, not a substitute for assertion comparison.
  Run each audit request with `audit_inputs.mjs freeze` then `audit_inputs.mjs run
  --directory DIR` (`run-pending` runs every unsubmitted request). Never pass a
  request or its path to a task/agent subagent.

Report scenario counts, mutation detection, inherited failures and environment
failures separately. Resolve inherited failures before the final clean gate;
never delete or weaken a test to improve the numbers. Stop for review.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

## Source as the only specification

When `preparationProfile` is `source-as-spec` (no runnable original, no
specification), follow [source-as-spec](../docs/SOURCE-AS-SPEC.md) instead of the
runtime harness above: run `source-spec init`, which writes the judge plan and
a mechanical source index (`migration/source-spec/sources.md`). There is no
per-file contract memo to draft: the source is the specification and reviewers
read cited source lines directly. Write `judge-report.md` (scope, method and the
unverified limits), and continue straight into 01 and 02 without stopping for a
00b-only review. The user reviews 00b–02 once as a package.

Before its inventory survey, follow 02's "Before the survey: generated files and
policies" (generated files, policy questions, coverage and a trial).

Do not run the `contracts` survey kind for source-as-spec. It is kept only for
projects whose judge plan, drafted before 0.10.0, still names
`migration/source-spec/contracts.md`. See [surveys](../docs/SURVEYS.md).

Preserve completed scopes and validated rows. The runner supplies original line
numbers and makes one correction of bad citations/missing rows (counted against
a call budget only when the person chose one). Rows still uncited after that
finish as UNKNOWN / TODO(port) marked `uncited`, and a file too large for one
survey input finishes as UNKNOWN without model calls; the survey completes, and
you report those counts in the review package instead of asking. Do not ask for
a decision at any repair attempt.
Do not resurvey the whole repository, discard sites or edit citations to make
validation pass. Monitor the same terminal using `status --fast --format
markdown`; silence alone does not justify cancellation, and elapsed time or CPU
use is never a reason to stop. Ask only when a scope, model or budget change
needs a new decision, or the same command fails again on rerun with no progress.
