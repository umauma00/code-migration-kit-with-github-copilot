# Phase reports and user decisions

This contract applies to the main interactive migration orchestrator. Automated
implementers, reviewers, arbiters and fixers keep their JSON contracts and never
ask the user questions. Use the user's language for reports and questions.

## Track the ten phases in the host TODO list

At migration start or resumption, the main interactive orchestrator must create
or reconcile an ordered TODO list using the host's available task-list tool.
The orchestrator profiles enable the documented [`todo` alias](https://docs.github.com/en/copilot/reference/custom-agents-configuration#tool-aliases); use the actual tool and schema
exposed by the current host rather than assuming a fixed API name. Only the
parent manages this list; automated workers keep their JSON-only contracts.

Keep these ten phase items, with stable phase identifiers and names in the
user's language, in this order:

`00` feasibility → `00b` comparison-test preparation → `01` dependency map →
`02` gap inventory/rules → `03` stress test → `04` translation/review →
`05` build → `05b` smoke → `05c` parity → `06` post-parity cleanup/handoff.

Initialization is separate preparation and does not count toward the ten phases.
Formal judge validation belongs to the preparation for phase 03 after phase 02;
it is not an eleventh phase. Preserve unrelated user tasks when updating a tool
that replaces the whole list. Reuse existing phase items instead of duplicating
them, and keep future phases visible rather than replacing them with worker jobs.

- Before work starts, mark only the phase actually being executed as in progress.
  A list of future work does not authorize its execution; respect explicit phase
  scope and every existing approval gate.
- Before a phase report or approval question, refresh the list from the actual
  outcome. Mark a phase completed only when its required artifacts and checks
  are satisfied. A completed phase does not approve the next phase.
- Make waiting, revision, failure and pause visible in the relevant phase title,
  for example `04：変換・レビュー【承認待ち】` or `05：全体ビルド【修正中】`.
  Use only statuses supported by the host. For a three-state TODO tool, running
  work is in-progress, completed work is completed, and pending, approval-waiting,
  blocked or paused work is not-started with the reason in its title. Keep at
  most one phase in progress; never mark an unfinished phase completed to clear
  the UI. Update again when an answer authorizes work or changes the plan.
- For phase 04, show current reviewed done/total and blocked units at meaningful
  milestones using `run_migration.mjs status`; keep translation as one phase
  item. Before manifest/dependency preparation, status may be unavailable: report
  that limitation and use the preparation evidence instead of inventing counts.
- On resumption or upstream changes, inspect the reports, current inputs, runner
  receipts and approvals before restoring completed items. Status alone reports
  translation units, not completion of all ten phases. Reset affected items and
  invalidated downstream items to unfinished. TODO checks never replace runner
  evidence or constitute approval; do not edit receipts to match the list.

Include a short progress line in each phase report, such as
`移行フロー：5/10工程完了。次：04 変換・レビュー（承認待ち）。`.
The ten-phase count describes workflow progress, not file progress or elapsed
time. Completing the list requires the phase 06 final report and its required
verification, not just passing parity.

If the TODO tool is unavailable or rejects an update, show the same ten-phase
checklist and current/waiting state in chat. Continue authorized work with this
fallback; do not invent a tool call, install an extension, change host settings
or treat a display failure as a failed migration. Approval questions and artifact
reports still follow the contract below.

## Ask when a decision is missing

Check the user's current request and earlier answers first. Use an available
question tool (`ask_user` in Copilot, or the host's equivalent) when a required
answer or phase authorization is missing. Do not repeat a question whose answer
is already clear. Group closely related setup questions, such as migration
languages and available model IDs; never guess an account's available models.

Finish and show the concrete artifacts before requesting permission for the next
phase. If the user already instructed that phase for the current artifacts,
follow the instruction without asking again. Follow named phase scope: asking
for feasibility authorizes feasibility, not production translation.

If the question tool is unavailable or rejects interactive use, present the same
question and choices in chat, including exact example replies, then wait for the
user. Do not simulate a tool result or treat a default selection, timeout, empty
answer or closed dialog as authorization. A nonblocking question stays pending;
only independent work may continue while waiting for a required answer.

## Finish every phase with a report

Before a question tool call, publish a concise report in chat containing:

1. **Phase and result:** name the phase and say completed, needs a decision, or
   blocked. Include the completed phase count and current or next phase with its
   waiting/running state. Completion refers to this phase, not the entire migration.
2. **Artifacts:** link the actual files in the target repository. Distinguish
   templates, drafts, disposable pilot outputs and production outputs. Cite
   result receipts for commands; report reviewed done/total and blocked units
   for translation. Unknown time, usage or scenario counts remain unknown.
3. **Review points:** two or three specific decisions or checks for the user,
   with relevant risks, unresolved findings or failures.
4. **Next phase:** name one next phase and its prerequisites. Explain what will
   run or change. If prerequisites failed, recommend resolving the blocker.
5. **Next action:** provide a copyable natural-language instruction that names
   the intended phase. This remains useful even when a question UI is available.

At an ordinary successful boundary, ask one question with these choices adapted
to the actual next phase:

- **Proceed:** name the phase, for example "Prepare the comparison tests".
- **Revise:** revise the current phase's artifacts; ask which issue to change if
  the answer did not specify it.
- **Pause:** stop and leave the saved artifacts available for later resumption.

Route translated-code revisions through the runner's repair/review flow. Handle
rulebook or judge amendments at a phase boundary and refresh affected validation;
the revise choice does not permit bypassing those existing controls.

For translation/build/smoke/parity/post-parity, the proceed choice must explicitly
say **approve and run the named stage**, identifying the current artifacts in the
question. Only after a real answer authorizes it, record the appropriate runner
approval and execute that stage. Never issue every future approval in advance.
If artifacts or predecessor results changed, refresh the report and authorization
as required by the runner. A user's change request is not approval to proceed.

For a failed phase or a recommendation against migration, offer relevant choices
such as "Investigate the failure", "Revise the plan" and "Pause". Do not recommend
a blocked next stage. Once the final report is complete, offer follow-up work
appropriate to the result; commit, push, merge and deployment need their own user
instruction. Do not create a question merely to end the conversation.

## Phase routing and durable evidence

Respect an explicit phase request when its prerequisites are met. For resumption,
read the reports, configured inputs and runner receipts. A template's existence
or the absence of a later receipt does not decide the next phase by itself.
Existing projects may already have prepared judge tests and commands without
`judge-report.md`. Inspect that evidence and any current receipt; do not repeat
judge design solely to create the new report format.

| Phase | Evidence to show | Normal next phase |
|---|---|---|
| Initialization | Actual config and rulebook/inventory templates, selected languages/models/paths | Feasibility |
| 00 feasibility | `migration/feasibility.md`, recommendation and unresolved risks | 00b comparison-test preparation |
| 00b judge preparation | `migration/judge-report.md`, test/scenario paths and configured commands | 01 dependency map |
| 01 dependency map | `migration/depmap/`, RULEBOOK, manifest and review-dependency draft | 02 gap inventory |
| 02 gap inventory | Inventory coverage, resolved rules and audited review dependencies | Judge validation, then 03 stress test |
| Judge validation | Current `migration/results/judge.json` and original/mutation command results | 03 stress test |
| 03 stress test | `migration/stress-test/report.md`, pilot results and remaining decisions | Approve and start translation |
| 04 translation | Output paths, reviewed done/total, blocked units and run summary | Approve and run build |
| 05 build | `migration/results/build.json`, success or concrete diagnostics | Approve and run smoke |
| 05b smoke | `migration/results/smoke.json`, asserted public scenario and outcome | Approve and run parity |
| 05c parity | `migration/results/parity.json`, original/parity counts and differences | Approve post-parity cleanup |
| 06 post-parity | Remaining markers, reviewed changes and final verification | User-chosen follow-up |

The formal judge command needs the rulebook, inventory, manifest and dependency
map. Phase 00b prepares the judge and saves its design/results report; it may
defer the formal receipt until those artifacts exist. Do not loop back to 00b
solely because `results/judge.json` is absent before phase 01. Judge validation
does not require an `approve judge` command. Post-parity has an approval gate but
no executable `run_migration.mjs post-parity` command; follow prompt 06 after
approval instead.

## Example: feasibility finished

> **事前調査：完了**
>
> 成果物：[移行可能性のレポート](migration/feasibility.md)。構造を保つ移植を提案します。
>
> 確認点：対象範囲が合っているか、互換性を保つ方針でよいか。
>
> 次の工程：新旧比較テストの準備。変換前に動作を比較する方法を整えます。
>
> 次の指示例：「調査結果を確認しました。この方針で比較テストの準備へ進めてください。」

Then use the question tool, if available: "この調査結果を踏まえ、どう進めますか？"
with choices "比較テストの準備へ進む", "調査内容を修正する", "ここで中断する".

## Example: translation finished

Show the actual reviewed done/total, output directory and run-summary link first.
Then ask "この変換結果のビルドを承認して実行しますか？" with choices
"ビルドを承認して実行", "変換結果の修正を相談", "ここで中断する".
Include the chat reply example: "この変換結果のビルドを承認します。実行してください。"
