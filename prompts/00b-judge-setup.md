# 00b — Establish a trustworthy judge

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: feasibility reviewed. Stop after the judge report.

Save the judge design and preparation results in `migration/judge-report.md`,
including test/scenario paths, configured commands, coverage, failures and any
deferred formal validation. This report is not the runner's validation receipt.

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
- Configure `commands.original`, `commands.mutation` and `commands.parity` as argv
  arrays. The mutation command exits zero only when the judge catches the defects.
- Use `run_migration.mjs judge` after the rulebook, inventory and manifest exist;
  this saves the validation receipt required before translation approval.

Report scenario counts, mutation detection, inherited failures and environment
failures separately. Resolve inherited failures before the final clean gate;
never delete or weaken a test to improve the numbers. Stop for review.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
