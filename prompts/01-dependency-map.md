# 01 — Dependency map and translation rulebook

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: feasibility and judge design reviewed. Work one phase and stop.

For plugin installations, replace `migration-kit/` in script paths with the
absolute plugin root resolved from the loaded skill/agent. Keep the target
repository as cwd and all migration artifact paths relative to it.

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

Generate the review evidence dependency declaration. Starter edges.tsv paths are
relative to the parser's --root. --source-root selects files to enumerate;
--depmap-root selects the parser base. If both are src, the latter may be omitted:

```bash
node migration-kit/scripts/make_review_dependencies.mjs --source-root src --edges migration/depmap/edges.tsv
# For repository-root parsing (e.g. Python absolute package imports):
node migration-kit/scripts/make_review_dependencies.mjs --source-root pkg --depmap-root . --edges migration/depmap/edges.tsv
# For cross-package source dependencies; align config.sourceRoots too:
node migration-kit/scripts/make_review_dependencies.mjs --source-roots pkg,shared --depmap-root . --edges migration/depmap/edges.tsv
```

The default artifact is migration/review-dependencies.json, selected by
config.reviewDependencyMap. Schema: {"schemaVersion":1,"dependencies":{"src/a.py":["src/b.py"],"src/b.py":[]}}.
The generator enumerates only selected source roots, including isolated files.
It reports edges originating outside them in ignoredEdges (e.g. tests -> pkg).
Dependencies from selected sources to an unselected directory fail; add the
required source root rather than dropping that evidence. Only depmap-root may be
"."; source roots cannot include kit or migration metadata. This is a draft,
not proof of completeness: audit parser coverage, exclusions, ignored edges and unresolved imports. Add
semantic evidence references needed by the rulebook/inventory, not just imports.
For multiple parser roots, generate separate --out migration/PATH.json drafts
and merge their project-relative dependencies. Every reachable file must have a
declaration; [] explicitly means audited independent. Missing declarations fail.
Both reviewers receive the current source and this transitive closure, full
rulebook, matching inventory rows/global notes and one candidate. They cannot
fetch missing evidence. Include the map in the phase review; after gap inventory
is written, revisit semantic dependencies before translation approval.

Report graph counts, cycles, unresolved imports, rule decisions, manifest and the
audited review dependency map.
Do not begin production translation. Stop for review.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
