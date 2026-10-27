# Running the ten phases in order from the orchestrator

[日本語](ORDERED-WORKFLOW.md) | English

The ten phases below are kept, following [the six macro stages and their internal phases](EXECUTION-SCOPES.md). 00b has a lightweight path that reuses an adequate existing judge and records its early validation. See [preparation audits](PREPARATION-AUDITS.md) and [isolated pilots](PILOT.md). A pilot is not completion of production 03; it runs under its own limited grant.

The phases are `00 → 00b → 01 → 02 → 03 → 04 → 05 → 05b → 05c → 06`. New configurations use phasePolicy strict. Existing configurations are kept; at skill start the following enables phase records. For plugin installations, replace migration-kit/ with the actual plugin root.

```sh
node migration-kit/scripts/run_migration.mjs phase init
node migration-kit/scripts/run_migration.mjs phase next
node migration-kit/scripts/run_migration.mjs phase start 00
```

The parent runs only the first incomplete phase. If the user names a later phase, it shows the incomplete prerequisites and returns to that phase. `phase check ID` is a read-only prerequisite check; for 00–03 it also checks what `phase complete` would (artifacts, drafted rulebook, dependency map); `phase start ID` also checks prerequisites. Completion of 00–03 is recorded on the instruction of a user who reviewed the actual artifacts. Work already approved is not asked again, and the concrete reasoning is saved in the note.

```sh
node migration-kit/scripts/run_migration.mjs phase complete 00 --note "Reviewed the scope and the migration decision"
```

| Phase | Required evidence and pass condition |
|---|---|
| 00 | feasibility.md and a concrete review record |
| 00b | judge-report.md. Runtime: comparison inputs and original/mutation/parity settings; source-only: existing judge-plan inputs. The formal judge comes after 02 |
| 01 | depmap/report.md, manifest, audited dependency declaration |
| 02 | gap-report.md, RULEBOOK, inventory, manifest, dependency declaration |
| 03 | Current successful judge, stress-test/report.md and review of the trial results; `phase start 03` also needs human-installed `migration/guardrails.json` |
| 04 | Implementation approval and valid independent double reviews for every unit, judged from runner records; `phase start 04` also needs the guardrails |
| 05 | Current approved successful build |
| 05b | Current approved successful smoke |
| 05c | Runtime: an actual successful parity. Source-only: confirms the current smoke and records not-applicable, equivalence unverified |
| 06 | Runtime: current post-parity approval, handoff.md after cleanup and phase complete 06. Source-only: an actual successful handoff |

Phase records are saved in migration/phases/. A template or the mere existence of an artifact never means complete. When sources, mode, evidence or a previous phase's record change, the affected phases return to incomplete. If the 02 audit changes 01's dependency declaration or manifest, update and re-check the 01 report before continuing. For existing projects, inspect the actual reports and leave completion records in order. Reports need not be rewritten just to re-run earlier work, but unverified phases are never recorded as passed.

The formal judge is refused before 02 passes, and implementation approval and the runner are refused before 03 passes. From build onward, the existing checks of approvals, previous stages and output hashes also apply. In source-only mode, record the following after smoke before moving to 06:

```sh
node migration-kit/scripts/run_migration.mjs phase start 05c
node migration-kit/scripts/run_migration.mjs phase complete 05c --note "Comparison not applicable in source-only mode; behavioral equivalence unverified"
```

This control applies to the kit's entry points and the runner. It does not forbid arbitrary edits in VS Code itself. Keep the phase TODO list in line with the current records, and never check off a phase whose completion cannot be confirmed. For usage records, see [the main-format cost log](COST-LOG.en.md).
