# 01 — Dependency map and translation rulebook

Prerequisite: feasibility and judge design reviewed. Work one phase and stop.

Use a deterministic dependency parser for the actual source ecosystem. Preserve
`edges.tsv`, `order.txt`, `cycles.txt` under `migration/depmap/`. Review unresolved
imports and generated/vendor exclusions. Check cycles at file AND target package
level. The Python, JS/TS and C/C++ scripts are starter implementations; unsupported
syntax needs an adapter, not an agent's guessed graph.

Draft `migration/RULEBOOK.md` with the user. Decide all ambiguous mappings once:
architecture, null/exception/number semantics, library choices, names, imports,
shared types, deferred markers and source-to-target paths. Survey facts with
scripts. Independently review decisions with evidence. Propose amendments; do
not silently decide product or architecture policy.

Generate `migration/manifest.tsv` with `scripts/make_manifest.py` using the map's
order and explicit substitutions. It has exactly `source<TAB>target` as header.
Reject duplicate targets, source overlap and unsafe paths. The current runner
supports one file per unit and must not be used for many writers to one output.
Cycles/shared helpers may need manual preparation or an atomic module adapter.

Report graph counts, cycles, unresolved imports, rule decisions and the manifest.
Do not begin production translation. Stop for review.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
