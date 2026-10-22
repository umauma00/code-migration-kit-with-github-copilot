# 02 — Semantic gap inventory

Follow [preparation audits](../docs/PREPARATION-AUDITS.md): show the first 20
rows to the human before fan-out, give every batch to two independent auditors
of the SAME batch, and keep classification workers on separately owned category
shards. Only the coordinator merges against a complete site census using the
file/symbol/source_construct key. Confirm findings, fix and independently
re-audit. Finish with a joint RULEBOOK/inventory audit citing rule, row and a
concrete wrong translation example. Do not silently authorize rule amendments.
Run each audit request with `audit_inputs.mjs freeze` then `audit_inputs.mjs run
--directory DIR` (`run-pending` runs every unsubmitted request). Never pass a
request or its path to a task/agent subagent.

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
Have two independent reviewers check the same classifier batch, including its
highest-risk classes. Supplementary disjoint sampling may follow those paired
batch reviews; it never replaces either review of a batch.
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

## Source as the only specification

With `preparationProfile: source-as-spec`, draft RULEBOOK and inventory from how the
source actually behaves, without the first-20-rows stop or paired batch audits.
Run one independent review of the whole package (contracts, RULEBOOK, inventory,
dependency map) in a separate context, fix its findings, then show ONE report for
00b–02 with links, review points (high-impact inferred contracts, UNKNOWN rows,
open findings) and choices: proceed to migration (recommended), revise, pause.
Only after the user's OK run `phase complete 00b,01,02 --note TEXT`, then `judge`.
See [source-as-spec](../docs/SOURCE-AS-SPEC.md).

## Delegate classification by scope

After the mechanical census (`migration/inventory-sites.tsv`: file, symbol,
source_construct), run `survey run --kind inventory --sites migration/inventory-sites.tsv`
and `survey merge --kind inventory --sites …`. Each scope's surveyor receives the
RULEBOOK, the scope's sources and its census sites; results are per-scope shards
merged by the existing inventory merge, which refuses an incomplete census. The
paired independent audits and the joint audit still follow. See [surveys](../docs/SURVEYS.md).
