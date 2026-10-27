# Delegating preparation reading by scope (survey)

[日本語](SURVEYS.md) | English

In phases 00, 00b and 02, a parent agent that reads the whole codebase into its
own conversation runs out of context on large repositories. `survey` splits the
source into **scopes**, hands each scope to a fresh surveyor worker and **gets
the results back as files**. The parent reads only the merged draft.
Phase 00 only decides whether to migrate, so by default the parent samples the source itself and reports what it skipped (as upstream). Surveys are for 00b and 02, which must cover every file; in 00 they are optional.

- One new `copilot` process per scope (`--agent migration-surveyor`, no tools, `--no-custom-instructions`), also when driven from VS Code.
- The scope's source text is the frozen input; a surveyor never reads other files or other scopes' results.
- Results go to `migration/surveys/<kind>/<scope-id>.json` with the scope's input hash. A current file means done; rerunning after an interruption runs only the remaining scopes.
- One scope's failure does not stop the others; transient failures retry and systemic ones (sign-in, credits) stop the run, as in translation.
- The model is `phaseModels.survey`, else the implementer model. `concurrency` limits active calls. Normal execution is continuous, including legacy configurations; only explicitly selected bounded mode enforces saved time/call budgets.

## Kinds and phases

Frozen sources include original line numbers and final-line bounds. Validation
checks every cited start/end line against the actual supplied excerpt. Each part
gets at most one focused correction of an invalid response: preserve validated rows and send only unfinished
files/sites to the fresh worker. Rejected answers remain in run records; the
coordinator never rewrites citations to make them pass. Rows still uncited
after that correction do not stop the survey: they finish as UNKNOWN/TODO(port)
marked `uncited` (facts drop only the invalid items), with evidence naming the
original file range and the rejected-answer record, never the worker's citation.
Scope records and the `survey merge` result count them under `uncited`
(dropped facts under `droppedFacts`, facts answers lost to a wrong envelope
under `droppedAnswers`; a run record counts only the scopes that run finished);
report those counts in the review
package. Resume reuses valid
partial rows and legacy results when current source/citations still validate,
and retains the saved max-files setting if it is omitted.

All three survey kinds split oversized file sets and site lists into fitting
requests without renaming scopes. Facts and contracts also split individual
source bodies. An inventory file that does not fit in one input together
with the RULEBOOK and one census site is recorded as UNKNOWN/TODO(port) for every site without model calls (its fragment
answers were always merged as UNKNOWN, after hours of calls), and the scope
record lists it under `unsurveyedOversizedFiles`. Even a minified
single line is split by character position without breaking Unicode pairs or
losing source characters. Original line/column ranges and validated part results
are saved under `<scope-id>.parts/`; unchanged completed parts are reused on
resume. Serialized JSON bytes are checked before dispatch, and no scope is done
until every part/file/site is covered. Contracts concatenate source-anchored
observations and retain cross-fragment unknowns. The inventory review traces
the sites of oversized files.
Required metadata that cannot fit with even one source character gets a precise
capacity error; source text is never silently removed.

For large files with many census sites, capacity is shared between the source
and site batches to reduce duplicate requests while retaining every site's full
fragment coverage. Unreadable sources, missing or out-of-root census files,
empty source roots and empty censuses are reported as incomplete and cannot be
merged. Readable scopes are preserved, and repaired inputs resume without
re-running completed scopes. Confirm source encoding before preparing UTF-8
input; the runner does not silently guess or convert it.

Monitor the existing terminal with `status --fast --format markdown` (optionally
`--wait 600`), which reads recorded progress without walking the source tree.
This view is explicitly not revalidated and cannot authorize a gate. Quiet
output, CPU at 100% or low CPU, elapsed time (including 600 seconds), and log
volume are never reasons to interrupt or relaunch work. A status wait returning
never terminates the worker. The runner emits liveness messages on stderr.
See [all interruption conditions and source index](INTERRUPTION-POLICY.en.md).

| Kind | Phase | What a surveyor returns | Merged into |
|---|---|---|---|
| `facts` | 00 feasibility (optional; by default the parent samples the source itself) | Entry points, data formats, external dependencies, platform code, generated code, pain points, risky constructs and tests, each with PATH:LINE | `migration/surveys/facts.md` (material for feasibility.md) |
| `contracts` | Not used (kept for source-as-spec plans drafted before 0.10.0) | Per file: public interface, inputs/outputs/errors, edge cases, evidence, unknowns | Only an untouched legacy `migration/source-spec/contracts.md`; otherwise `migration/surveys/contracts.draft.md` |
| `inventory` | 02 gap inventory | For each site of a mechanical census: classification, target translation, evidence, confirmed/unknown | Per-scope shards, then the existing inventory merge into `migration/inventory.tsv` |

## Commands

```bash
R="node migration-kit/scripts/run_migration.mjs"   # plugin: the plugin's absolute path
$R survey plan   --kind facts [--max-files 20]     # inspect the scopes (no AI calls)
$R survey run    --kind facts                      # run unfinished scopes (resume with the same command)
$R survey status --kind facts                      # done / pending per scope
$R survey merge  --kind facts                      # merge once every scope is done

# inventory needs a mechanical site census first (grep or a script, not judgment)
$R survey run   --kind inventory --sites migration/inventory-sites.tsv
$R survey merge --kind inventory --sites migration/inventory-sites.tsv
```

Scopes are mechanical: files of one directory together, at most `--max-files`
each, with fitting work requests under `maxReviewInputBytes`. A single file
over the limit is processed in source fragments (inventory: UNKNOWN, as above).

## Quality

- Answers are checked before they are saved: files outside the scope, missing PATH:LINE citations and omissions (every file for contracts, every census site for inventory) are rejected; after the one correction they become UNKNOWN as above.
- Merged results are **drafts**. The phase's independent audits ([preparation audits](PREPARATION-AUDITS.md), or the single package review in source-as-spec) and the human review still apply; `survey merge` never records a phase.
- The parent checks the merged draft and the cited lines before reporting. Surveyor answers are candidate facts, not decisions.
