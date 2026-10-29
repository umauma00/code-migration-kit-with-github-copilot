# 06 — Post-parity cleanup

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Runtime prerequisite: both suites pass in the current parity receipt and the user has
reviewed the final evidence. Never mix this phase with reaching initial parity.

For source-only mode this is a separate smoke-to-handoff path, not post-parity.
Prepare migration/handoff.md with current reviewed outputs, actual build/smoke
receipts, source-inferred contracts, assumptions, unresolved risks and future runtime
parity steps. Explicitly say behavioral equivalence unverified. After user review,
record approve handoff then run handoff as described in [source-only](../docs/SOURCE-ONLY.md).
Final wording: ソース基準の移植完了・動作同等性未検証. No parity receipt is created.

In runtime mode, follow the post-parity steps below.

Mechanically collect BUG(port), TODO(port) and PERF(port) markers. Classify each
as fix now or document and close, with a reason. Propose each behavioral change
separately. Obtain the user's authorization for the changed specification.

In runtime mode, make one reviewed change per accepted issue; rerun parity with an explicitly
reviewed adjustment for the intended behavior change. Do not silently edit the
judge to match the new implementation. A change that affects unrelated behavior
needs separate justification. New source or judge changes invalidate old receipts.

Report marker counts, per-change verification and remaining known issues. Neither
the runner nor this prompt automatically commits, merges, pushes or deploys.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
