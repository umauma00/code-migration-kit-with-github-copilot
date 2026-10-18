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
| 2 | Copy `templates/guardrails.json` to `migration/guardrails.json` and adapt it to this target's build/test commands (or record a waiver with its reason) | **Human** | doctor `command guardrails` is installed / waived |
| 3 | `phase start 03` | AI | A start record exists |
| 4 | Pick 3 files that exercise the most risky rulebook sections and inventory rows; write the scores and file:line proof to `migration/stress-test/report.md` | AI | The report has a selection table |
| 5 | Bakeoff A: translate by the rulebook to the letter (disposable workspace, never production) | AI (separate context) | Every nontrivial choice cites its rule |
| 6 | Bakeoff B: copy only the source files to an empty directory outside the repo and have them ported natively, without the rules. CLI: `copilot -p … --no-custom-instructions`; VS Code: a tool-free subagent | AI (separate context) | B saw no rulebook, inventory or conversation |
| 7 | Diff inspection: format A and B, then judge each difference (rulebook right / native right / both defensible / both wrong) | AI (separate context) | Each verdict has evidence |
| 8 | Pilot: `pilot prepare --target /new/outside/dir --sources … --note …`, then `pilot run --root …` | AI runs it, the **human** approves (the host asks) | Same workers/reviews/fixes as production; were the rules obeyed? |
| 9 | Report: amendment queue (never edit RULEBOOK), adherence findings, timing and usage (`usageEstimate` in the run summary), workspace deletion confirmed, estimated duration for 04 (`status`) | AI | `migration/stress-test/report.md` |
| 10 | Decide which amendments to apply to RULEBOOK | **Human** | If applied, rerun `judge` and repeat 5–9 on fresh files weighted to the changed sections |
| 11 | Review the report, then `phase complete 03 --note "what you reviewed"` | AI records, the **human** confirms (the host asks) | `status` shows "Current: 04 [awaiting approval]" |

For redesign, replace the bakeoff (5–7) with adversarial review of the design
document plus small disposable trials. If the same section is re-amended twice,
stop and ask the human for a design decision instead of a third wording.

## Common stops

| Message | Cause | What to do |
|---|---|---|
| `Phase 03 requires human-installed command guardrails` | Step 2 not done | The human installs `migration/guardrails.json`; the AI cannot (the hook denies it) |
| `Phase 02 is not reviewed for current inputs` | RULEBOOK or another input changed, invalidating 02 | Review the change, record 02 again, rerun `judge` |
| `Run judge successfully for these inputs` | Inputs changed since judge | Rerun `judge` |
| `Pilot target must be a new directory` | The pilot workspace already exists | Choose a new outside directory |
| `unable to ask user for confirmation` | The session cannot show the approval confirmation (non-interactive run) | The human runs the shown command in their own terminal |
| `repository hooks load in Copilot CLI` fails | Untrusted folder, hooks off | Start `copilot` interactively and trust the folder |

Failed commands print their cause and choices, with a recommendation.
