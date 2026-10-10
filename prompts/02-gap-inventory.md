# 02 — Semantic gap inventory

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

Report coverage, missing decisions and proposed amendments. Keep the rulebook
read-only during worker loops. Stop at the inventory gate.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
