# Migrating with the source as the only specification (source-as-spec)

[日本語](SOURCE-AS-SPEC.md) | English

A preparation profile for projects whose original runtime is gone and that have
no specification or design documents. **The source code is the only
specification.** The AI drafts judge preparation (00b), dependencies (01) and
gap inventory/rules (02) together, and **after one user review and OK** the
migration continues from 03. It builds on [source-only verification](SOURCE-ONLY.md),
so behavioral equivalence is handed off as unverified.

## When to choose it

| Situation | Recommendation |
|---|---|
| The original cannot run and there is no spec | **source-as-spec** (this page) |
| The original can run | Default runtime mode; parity verifies equivalence for real |
| The original cannot run, but a spec or portable tests exist | source-only, with spec-derived scenarios in `judge-plan.json` |

At initialization the skill asks whether the original can run and whether a
spec exists; if both answers are no, it offers this profile as the recommended
choice. The user decides.

## Getting started

New project:

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --model MODEL_ID --preparation-profile source-as-spec --apply
```

Existing project (for example, runtime 00b got stuck):

```bash
node migration-kit/scripts/run_migration.mjs source-spec init          # preview only
node migration-kit/scripts/run_migration.mjs source-spec init --apply  # after the user agrees
```

`init --apply` switches `migration/config.json` to `verificationMode: "source-only"`
and `preparationProfile: "source-as-spec"`, and creates only missing files:

- `migration/judge-plan.json`: every file under sourceRoots
- `migration/source-spec/sources.md`: the list of source files that form the specification (mechanical; nothing to fill)

Since 0.10.0 no per-file contract memo (`contracts.md`) is drafted. The source is
the specification, so surveying a memo and then checking the memo only added
time; reviewers read the cited source lines directly.

Switching the profile changes config, so earlier approvals and receipts are
invalidated (review again from 00b).

## What the AI drafts (00b–02 together)

`source-spec check` lists the remaining artifacts and the suggested commands
(dependency parser, manifest, review dependencies).

| Phase | Artifact | How |
|---|---|---|
| 00b | `judge-report.md` | Scope, method and unverified limits (no per-file contract memo) |
| 01 | `depmap/`, `manifest.tsv`, `review-dependencies.json`, `depmap/report.md` | Generated mechanically by the bundled parsers, never guessed. They read source only and never run the original. For a language without one, [write an adapter](DEPENDENCY-MAPPERS.en.md) |
| 02 | `RULEBOOK.md`, `inventory.tsv`, `gap-report.md` | Decide policy from how the source actually behaves; undecidable sites stay UNKNOWN in the inventory with the most conservative translation and a TODO(port) |

A judge plan drafted before 0.10.0 that names `contracts.md` keeps its rule:
00b cannot be recorded while that memo still contains `TODO(spec)`. To move to
the source index, delete `migration/judge-plan.json` and rerun `source-spec init
--apply`; config does not change, so 00 stays recorded and 00b–02 are reviewed
again together.

### Lighter preparation audits

The standard [preparation audits](PREPARATION-AUDITS.md) (two auditors × 20
files, up to three rounds, stopping after the first 20 inventory rows) are
replaced by **one independent review of the whole specification package**:

- One reviewer in a separate context reads the source, RULEBOOK, inventory and
  the dependency map together and lists statements that contradict the source,
  statements without cited lines, and rule/inventory contradictions.
- Fix the findings, then report **both the fixed findings and the open points**
  to the user.
- The dependency map is mechanical, so agent edge-sampling audits are skipped;
  record unsupported syntax and exclusions in `depmap/report.md`.

## One user review

When the package is complete, the AI shows one report:

1. Links to every artifact above
2. Review points: high-impact inferences, the UNKNOWN list (including how many
   rows became UNKNOWN because their citations could not be verified), open review points
3. Choices with a recommendation and reasons: "Proceed to migration with this
   package (recommended)", "Revise the flagged items", "Pause"

Only after the user says OK does the AI record the three phases:

```bash
node migration-kit/scripts/run_migration.mjs phase complete 00b,01,02 --note "User reviewed the specification package: (what was reviewed)"
node migration-kit/scripts/run_migration.mjs judge
```

All three phases are checked before anything is written; if anything is
missing, **no phase is recorded**, and the cause and choices are printed. Phase 00 (feasibility) is reviewed separately.

## Afterwards

From 03 onward nothing changes. Phase 03 runs about three files through the
same production translation/two-review/fix pipeline to check that the generated
rules are obeyed, so a rule mistake does not replicate into every file. 05c
shows "unverified in this mode", and after a successful 05b smoke the flow goes
to the [06 handoff](SOURCE-ONLY.md). The outcome is **source-based migration
complete; behavioral equivalence unverified**.
