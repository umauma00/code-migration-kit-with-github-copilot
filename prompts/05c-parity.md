# 05c — Prove behavioral equivalence

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

For verificationMode source-only, mark parity unverified / not run in this mode.
Never create a passed parity receipt. After successful reviewed smoke, follow
[source-only handoff](../docs/SOURCE-ONLY.md) and prompt 06. Runtime keeps every
original/parity requirement below.

Runtime prerequisite: current smoke receipt, validated judge and explicit parity approval.
Run `run_migration.mjs parity`; it reruns the original suite on the original
implementation and then the new-vs-old public-surface parity suite.

For each divergence, classify regression, inherited failure, environmental failure
or comparator defect by running the same input against the original. Debug the
judge before trusting a report that everything diverges. Preserve meaningful
numeric, encoding and whitespace behavior.

Burn the regressions down (upstream Step 6): for a parity failure the original
suite passed, run `run_migration.mjs repair-round --stage parity`. Output lines that
name translated files become the reviewed repair queue (rounds in
`migration/parity-rounds.tsv`). When the comparator reports cases rather than file
lines, write each confirmed regression as a `file<TAB>module<TAB>code<TAB>message`
row naming its owning target, run `diagnostic_queue.mjs --stage parity --diagnostics
migration/PATH.tsv`, then `repair --queue migration/repair-queue.json`. A failing
original suite is inherited or environmental: the runner refuses to queue it.
Repaired outputs need fresh build, smoke and parity approvals, unless the person
granted `build-loop --through parity`, which reruns all three under that one grant. The same error class
three times is a rule bug: propose the amendment instead of another round.

Report both suite counts, scenario coverage and all unresolved differences.
A failing original suite or parity command blocks completion. No skipping,
deleting or weakening tests. Keep the old code runnable through the final gate.
After the user reviews parity, approve post-parity separately.
