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
- The model is `phaseModels.survey`, else the implementer model; `concurrency` and `maxAgentCalls` apply.

## Kinds and phases

| Kind | Phase | What a surveyor returns | Merged into |
|---|---|---|---|
| `facts` | 00 feasibility (optional; by default the parent samples the source itself) | Entry points, data formats, external dependencies, platform code, generated code, pain points, risky constructs and tests, each with PATH:LINE | `migration/surveys/facts.md` (material for feasibility.md) |
| `contracts` | 00b (source-as-spec) | Per file: public interface, inputs/outputs/errors, edge cases, evidence, unknowns | `migration/source-spec/contracts.md` (only while it is the untouched skeleton; otherwise `migration/surveys/contracts.draft.md`) |
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
each and within the frozen-input limit (`maxReviewInputBytes`). A single file
over the limit is reported instead of run.

## Quality

- Answers are checked before they are saved: files outside the scope, missing PATH:LINE citations and omissions (every file for contracts, every census site for inventory) are rejected.
- Merged results are **drafts**. The phase's independent audits ([preparation audits](PREPARATION-AUDITS.md), or the single package review in source-as-spec) and the human review still apply; `survey merge` never records a phase.
- The parent checks the merged draft and the cited lines before reporting. Surveyor answers are candidate facts, not decisions.
