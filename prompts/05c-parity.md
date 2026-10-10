# 05c — Prove behavioral equivalence

Prerequisite: current smoke receipt, validated judge and explicit parity approval.
Run `run_migration.mjs parity`; it reruns the original suite on the original
implementation and then the new-vs-old public-surface parity suite.

For each divergence, classify regression, inherited failure, environmental failure
or comparator defect by running the same input against the original. Debug the
judge before trusting a report that everything diverges. Preserve meaningful
numeric, encoding and whitespace behavior.

Report both suite counts, scenario coverage and all unresolved differences.
A failing original suite or parity command blocks completion. No skipping,
deleting or weakening tests. Keep the old code runnable through the final gate.
After the user reviews parity, approve post-parity separately.
