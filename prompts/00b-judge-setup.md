# 00b — Establish a trustworthy judge

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: feasibility reviewed. Stop after the judge report.

Save the judge design and preparation results in `migration/judge-report.md`,
including test/scenario paths, configured commands, coverage, failures and any
deferred formal validation. This report is not the runner's validation receipt.

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
  Confirm weaknesses, repair and re-audit with fresh contexts. Mutation detection
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
runtime harness above: run `source-spec init`, fill `migration/source-spec/contracts.md`
from cited source lines (write "unknown" where the source cannot decide), write
`judge-report.md`, and continue straight into 01 and 02 without stopping for a
00b-only review. The user reviews 00b–02 once as a package.

For source-as-spec, draft the contracts with `survey run --kind contracts` and
`survey merge --kind contracts` instead of reading every file yourself; the merge
fills `migration/source-spec/contracts.md` only while it is the untouched skeleton.
See [surveys](../docs/SURVEYS.md).

Preserve completed scopes and validated rows. The runner supplies original line
numbers and makes one bounded correction of bad citations/missing rows (counted
against a call budget only when the person chose one); do not ask for another decision at each repair attempt.
Do not resurvey the whole repository, discard sites or edit citations to make
validation pass. Monitor the same terminal using `status --fast --format
markdown`; silence alone does not justify cancellation. Ask only after bounded
recovery is exhausted or a scope/model/budget change needs a new decision.
