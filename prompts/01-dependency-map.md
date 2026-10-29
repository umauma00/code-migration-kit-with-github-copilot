# 01 — Dependency map and translation rulebook

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: feasibility and judge design reviewed. Work one phase and stop.

Follow [preparation audits](../docs/PREPARATION-AUDITS.md): five-file extraction
trial before full generation; then, for a bundled or fixture-tested mapper, the
light audit described below (one auditor over `dependency-targets` files). Only
a hand-written graph or unproven adapter gets two independent disjoint 20-file
random/adversarial audits (record actual coverage for small repos), missed AND
invented edge diffs, a fixed scanner, full regeneration and fresh resampling, at
most three rounds, then a report of what remains. Use the sample/diff CLI for
mechanical evidence, not invented source findings. Review scanner exclusions and unsupported syntax separately.
When target packages are known, declare config.packageMap and generate the
separate target-package cycle report before phase 01 completion.
Run each audit request with `audit_inputs.mjs freeze` then `audit_inputs.mjs run
--directory DIR` (`run-pending` runs every unsubmitted request). Never pass a
request or its path to a task/agent subagent.

For plugin installations, replace `migration-kit/` in script paths with the
absolute plugin root resolved from the loaded skill/agent. Keep the target
repository as cwd and all migration artifact paths relative to it.

Use a deterministic dependency parser for the actual source ecosystem. Preserve
`edges.tsv`, `order.txt`, `cycles.txt` under `migration/depmap/`. Review unresolved
imports and generated/vendor exclusions. Check cycles at file AND target package
level. Bundled mappers cover Python, JS/TS, C/C++, C#, Java, VB.NET, PHP and COBOL
(see [dependency mappers](../docs/DEPENDENCY-MAPPERS.md)); they read source text
only and never build or run the original. Review their `unresolved.tsv`. Another
language or unsupported syntax needs an adapter written under
`migration/tools/depmap-<language>/` by that document's rules, not an agent's
guessed graph. When a bundled mapper fails or falls short, follow that
document's "When a bundled mapper fails" steps: fix a copy there, never
`migration-kit/`, and record it in `depmap/report.md`.

Audit a bundled (or fixture-tested) mapper's graph lightly, as in
[preparation audits](../docs/PREPARATION-AUDITS.md#dependency-map-01): review the
mechanical checks, run `preparation_cli.mjs dependency-targets`, have ONE fresh
auditor list those files' direct edges, and run `dependency-diff` on the same
files. Fix confirmed misses in the mapper or declaration, regenerate, and diff
the same files again. Do not run 2 x 20-file sampling rounds for a bundled
mapper, and do not stop or ask because a dependency stays unresolved: list it
in `depmap/report.md`.

Draft `migration/RULEBOOK.md` with the user. Decide all ambiguous mappings once:
architecture, null/exception/number semantics, library choices, names, imports,
shared types, deferred markers and source-to-target paths. Survey facts with
scripts. Independently review decisions with evidence. Propose amendments; do
not silently decide product or architecture policy.

For redesign, use the [architecture contract](../templates/ARCHITECTURE.md) for
subsystem boundaries, public contracts, state/data ownership, dependency
directions, old-feature mapping, shared types and permitted behavior changes.
Put the reviewed body in RULEBOOK or register its path in config.designInputs;
a link alone is insufficient for tool-free workers. Preserve the external parity
contract. The standard file runner still rejects redesign; module publication,
rollback and exclusive output ownership need the separately scoped adapter.

Generate `migration/manifest.tsv` with `scripts/make_manifest.py` using the map's
order and explicit substitutions. It has exactly `source<TAB>target` as header.
Run the parser from the import base: for Python, the source root itself unless it
is a package (has `__init__.py`), in which case its parent. Parser paths are then
relative to that root: pass `--prefix ROOT/` to make_manifest and `--depmap-root
ROOT` to make_review_dependencies; when the parser walked a wider directory, add
`--include SOURCE_ROOT/`. `source-spec check` prints these commands for the
project. An all-empty dependency map for several files is refused at phase
completion unless the person confirms independence (`--confirm-no-dependencies`).
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

Save the concrete phase report to `migration/depmap/report.md`. After its actual user review, record `phase complete 01 --note TEXT` as described in [ordered workflow](../docs/ORDERED-WORKFLOW.md).

## Source as the only specification

With `preparationProfile: source-as-spec`, generate the map, manifest and review
dependencies mechanically (`source-spec check` prints the commands), record parser
limits in `depmap/report.md`, skip the agent edge-sampling rounds and the light
audit (the package review in 02 replaces both) and do not stop for a 01-only gate: continue to 02. See [source-as-spec](../docs/SOURCE-AS-SPEC.md).
