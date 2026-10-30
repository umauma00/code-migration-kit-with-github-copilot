# Phase 03 stress test: one-page checklist

[日本語](STRESS-TEST-CHECKLIST.md) | English

Phase 03 tries the rulebook on a few hard files before it meets every file.
The only output that survives is **rule amendments**; code translated here never
ships. Details are in [prompt 03](../prompts/03-stress-test.md) and the
[pilot](PILOT.md); this table is the order of work. For plugin installations,
replace `migration-kit/` with the plugin's absolute path.

## Steps

| # | Do | Who | Check |
|---|---|---|---|
| 1 | Confirm 00–02 are recorded and judge succeeded | AI | `status --format checklist` shows "Current: 03" |
| 2 | The AI proposes a deny list from `guardrails show` adapted to this target's build/test commands (or a waiver with its reason) in chat, and runs `guardrails install` after agreement | **Human** agrees; the host confirms | doctor `command guardrails` is installed / waived |
| 3 | `phase start 03` | AI | A start record exists |
| 4 | Pick 3 files that exercise the most risky rulebook sections and inventory rows; write the scores and file:line proof to `migration/stress-test/report.md` | AI | The report has a selection table |
| 5 | Bakeoff A: translate by the rulebook to the letter (disposable workspace, never production) | AI (separate context) | Every nontrivial choice cites its rule |
| 6 | Bakeoff B: copy only the source files to an empty directory outside the repo and have them ported natively, without the rules. Run the "B isolation command" below (written by `stress-b command`) in that directory (in VS Code too, from a terminal) | AI (separate context) | B saw no rulebook, inventory, conversation or skill |
| 7 | Diff inspection: format A and B, then judge each difference (rulebook right / native right / both defensible / both wrong) | AI (separate context) | Each verdict has evidence |
| 8 | Pilot: first the read-only `pilot plan --sources …` for the final file count (chosen files plus the files they use), ask once with that count, then with the same `--sources` and `--through` `pilot prepare --target /new/outside/dir --sources … --expect-total COUNT --note …`, then `pilot run --root …` | AI runs it, the **human** approves (the host asks) | Same workers/reviews/fixes as production; were the rules obeyed? |
| 9 | Report: amendment queue (never edit RULEBOOK), adherence findings, timing and usage (`usageEstimate` in the run summary), workspace deletion confirmed, estimated duration for 04 (`status`) | AI | `migration/stress-test/report.md` |
| 10 | Decide which amendments to apply to RULEBOOK | **Human** | If applied, rerun `judge` and repeat 5–9 on fresh files weighted to the changed sections |
| 11 | Review the report; to start translation, `approve translation --complete-phase 03 --note "what you reviewed"` (records phase 03 and the translation approval under one confirmation; `phase complete 03 --note …` records only the phase) | AI records, the **human** confirms (the host asks once) | `status` shows "Current: 04" (only the phase: "04 [awaiting approval]") |

For redesign, replace the bakeoff (5–7) with adversarial review of the design
document plus small disposable trials. If the same section is re-amended twice,
stop and ask the human for a design decision instead of a third wording.

## B isolation command

`--no-custom-instructions` stops AGENTS.md and Copilot instructions, but user and plugin skill descriptions (including this kit's `code-migration` skill) still reach the model. With CLI 1.0.98, leaving `skill` out of `--available-tools` kept them out.

First create the directory and copy only the source files, then have the runner write the exact command. The runner reads which file tools the model has in this CLI (from the CLI, without AI usage) and lists only those; for a model with no writing tool it stops with the reason and choices. Where the CLI cannot be asked, it says `verified: false` and lists the file tools of every known model family. Run the printed `bash` or `powershell` line in a terminal as it is.

```bash
mkdir /tmp/bakeoff-b && cp SOURCE_FILES /tmp/bakeoff-b/   # copies only, not a checkout
node migration-kit/scripts/run_migration.mjs stress-b command --dir /tmp/bakeoff-b
```

Only when the runner cannot be used, use this fixed command.

```bash
cd /tmp/bakeoff-b && copilot -p "Port these files to TARGET_LANGUAGE the way a fluent TARGET_LANGUAGE engineer would write them natively. Write each translation next to its source." \
  --model STRESS_B_MODEL --no-custom-instructions --disable-builtin-mcps -s \
  --available-tools view,create,edit,apply_patch,glob,grep,rg --allow-tool write
```

`STRESS_B_MODEL` is `phaseModels.stressB`. Keep `apply_patch`: some GPT models (checked with gpt-6-luna on CLI 1.0.105) have no `create` / `edit` and write only through `apply_patch`, so without it B gets read-only tools and writes nothing. Do not run B as a subagent of the migration chat: VS Code Local subagents inherit the parent's instructions, including `.github/copilot-instructions.md` with the kit's managed block. Delete `/tmp/bakeoff-b` afterwards and record the deletion in the report.

## Common stops

| Message | Cause | What to do |
|---|---|---|
| `Phase 03 requires human-installed command guardrails` | Step 2 not done | Agree the deny list and allow `guardrails install` when the host asks; the AI cannot write the file directly (the hook denies it) |
| `Phase 02 is not reviewed for current inputs` / `Phase 02's record is out of date` | RULEBOOK or another input changed, invalidating 02 (the second names what changed and the next step) | Follow the named step (check the change and record 02 again, or redo it), then rerun `judge` |
| `Run judge successfully for these inputs` | Inputs changed since judge | Rerun `judge` |
| `Pilot target must be a new directory` | The pilot workspace already exists | Choose a new outside directory |
| `unable to ask user for confirmation` | The session cannot show the approval confirmation (non-interactive run) | The human runs the shown command in their own terminal |
| `repository hooks load in Copilot CLI` fails | Untrusted folder, hooks off | Start `copilot` interactively and trust the folder |
| `commands can write outside the project and use loopback` fails | A local sandbox is on: writes outside the repository (B, pilot) and local network access (hook check) are blocked | The person types `/sandbox off` in that session, or allows the write locations and local network access in the sandbox settings. The AI never changes them (`settings apply` during setup asks too) |

Failed commands print their cause and choices, with a recommendation.
