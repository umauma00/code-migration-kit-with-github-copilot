# 02 — Semantic gap inventory

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: map and draft rulebook reviewed. Produce inventory and stop.

Find every site where the target requires a decision the source leaves implicit:
ownership/lifetime, nullability, exception/error returns, interface contracts,
number ranges/rounding, character classes, iteration order and concurrency.

Write `migration/inventory.tsv` using the template. Every row names a source
location, the risk, the chosen rule and evidence. Distinguish allocation failures
from structural/precondition failures; one shared sentinel is not one policy.

Count relevant constructs mechanically and reconcile the inventory coverage.
Have independent reviewers check disjoint samples and the highest-risk classes.
Findings cite source lines and rule sections. Unknown cases get a searchable
marker and an amendment proposal, not invented policy. Do not read the entire
inventory into every worker context; workers query their unit's relevant rows.
Use the template's first column `file` with exact project-relative paths. Revisit
the review dependency map from phase 01: evidence that depends on another source
file requires that file in the unit's declared dependency closure. Global rules
belong in RULEBOOK; # inventory notes are retained for all reviewers.

Report coverage, missing decisions and proposed amendments. Keep the rulebook
read-only during worker loops. Stop at the inventory gate.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

Save the concrete phase report to `migration/gap-report.md`. After its actual user review, record `phase complete 02 --note TEXT` as described in [ordered workflow](../docs/ORDERED-WORKFLOW.md).
