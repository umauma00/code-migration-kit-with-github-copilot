# Phase reports and user decisions

For intermediate translation batches, show the exact approved targets and
reviewed scope completion, then await the next batch instruction. maxAgentCalls
is a budget, not batch size. See [execution scopes](EXECUTION-SCOPES.md).
Pilot reports explicitly identify disposable purpose and grant; they cannot
authorize production. Map the ten internal IDs to the six macro stages without
removing preparation or cleanup evidence.

This contract applies to the main interactive migration orchestrator. Automated
implementers, reviewers, arbiters and fixers keep their JSON contracts and never
ask the user questions. Use the language recorded in `migration/preferences.json`
(`run_migration.mjs preferences`) for reports, questions, TODO labels and next
instructions; if it is unset, ask 日本語 / English first and record the answer.
Link `.en.md` documents for English and `.md` documents for Japanese.

## Track the ten phases in the host TODO list

At migration start or resumption, the main interactive orchestrator must create
or reconcile an ordered TODO list using the host's available task-list tool.
The orchestrator profiles enable the documented [`todo` alias](https://docs.github.com/en/copilot/reference/custom-agents-configuration#tool-aliases); use the actual tool and schema
exposed by the current host rather than assuming a fixed API name. Only the
parent manages this list; automated workers keep their JSON-only contracts.

During an active phase, build the items from `run_migration.mjs status --fast --format todo`: it returns the
ten phases as `{ "todoList": [{ id, title, status, description }], "current": {…} }`
in the user's language, with statuses computed from receipts. `current` names
the first incomplete phase in every state. Its item is `in-progress` only while
it runs or is worked on; waiting, blocked or not yet started it stays
`not-started` with its state in the title (the three-state rule below), so at
most one item is in progress. Pass only `todoList` to the host tool. Map it onto the host tool's actual
schema; Copilot CLI's `update_todo` takes one markdown checklist string, so pass
it the item lines of `status --format checklist`. That command prints the same list for chat; include that
checklist in **every** phase report and failure report, whether or not the TODO
tool rendered, so the user always sees the current phase.

Fast status marks completion as recorded, not revalidated. At resumption,
upstream changes and actual phase/gate boundaries, use normal status or the
phase checks to verify current evidence once. Progress updates within that
same work do not need another whole-tree verification.

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
  item. Status is available after initialization even before manifest/dependency
  preparation. Use status --format markdown for candidates, missing inputs,
  current receipts, active calls and blockers; candidates do not prove completion.
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
question tool (`ask_user` in the Copilot CLI, `vscode/askQuestions` in VS Code)
when a required answer or phase authorization is missing. Do not repeat a
question whose answer is already clear. Give choices for every finite set of
answers (language, proceed/revise/pause, failure options). Model IDs are free
text: never guess an account's available models or offer invented ones as
choices. Setup settings are not asked one by one. After initialization, one question
picks the model for every role (`models set --role all --model ID`); then
one question asks the target language with the source language the kit
guessed from the files shown (`settings init` returns it; the answer is
recorded with `settings init --source SOURCE --target TARGET`), one question
asks how phases advance (normal, recommended; relaxed; or auto, for autopilot;
recorded with `preferences --phase-mode`, see [relaxed mode](ORDERED-WORKFLOW.en.md#relaxed-mode)
and [auto mode](ORDERED-WORKFLOW.en.md#auto-mode)); whether the original runs and,
only when it does not, whether a specification exists are asked next (without one,
setup switches to source-as-spec before phase 00). In auto mode every setup question
starts with `setupNotice` (setup is still manual), and `autoHandoff` ends setup:
show it and stop before phase 00 so the person can switch to autopilot. Then
`settings init` writes the rest (migration languages, roots, verification mode,
commands, and per-role model, effort and context changes) to
`migration/run-settings.json`, and one question asks whether the person has
filled it in or has a question; "filled in" runs `settings apply` (see the
skill's run settings section). Only the report language is asked before
initialization. A later change of models alone, asked for in chat, is one
question for every role, answered in the `role=ID:EFFORT[:long_context], ...` form that
`models list` shows and recorded with one `models set --assign`. A
free-text reply that does not clearly pick a choice is a new instruction, not
consent: clarify it before acting on a gate.

Finish and show the concrete artifacts before requesting permission for the next
phase. If the user already instructed that phase for the current artifacts,
follow the instruction without asking again. Follow named phase scope: asking
for feasibility authorizes feasibility, not production translation.

If the question tool is unavailable or rejects interactive use, present the same
question and choices in chat, including exact example replies, then wait for the
user. Do not simulate a tool result or treat a default selection, timeout, empty
answer or closed dialog as authorization. An automatic reply is not an answer
either: in Copilot CLI autopilot the host answers `ask_user` itself (for example,
that the user is not available and you should work autonomously). Choose
nothing, report the pending question, and ask the person to continue in an
interactive session or to answer in chat. A nonblocking question stays pending;
only independent work may continue while waiting for a required answer.

## Finish every phase with a report

Before a question tool call, publish a concise report in chat containing:

1. **Phase and result:** name the phase and say completed, needs a decision, or
   blocked. Include the completed phase count and current or next phase with its
   waiting/running state. Completion refers to this phase, not the entire migration.
2. **Artifacts:** link the actual files in the target repository. Distinguish
   templates, drafts, disposable pilot outputs and production outputs. In
   relaxed mode, list every phase still waived (`status` `waivers`) with its
   reason; the final handoff report lists them too. Cite
   result receipts for commands; report reviewed done/total and blocked units
   for translation. Unknown time, usage or scenario counts remain unknown.
3. **Review points:** two or three specific decisions or checks for the user,
   with relevant risks, unresolved findings or failures.
4. **Next phase:** name one next phase and its prerequisites. Explain what will
   run or change. If prerequisites failed, recommend resolving the blocker.
5. **Next action:** provide a copyable natural-language instruction that names
   the intended phase. This remains useful even when a question UI is available.

In auto mode (`phaseMode: auto`) the person chose beforehand not to be asked at
phase boundaries: publish the report, then record the phase and continue with
the next one without a question. The report lists the records made without the
person (`status` `autoMode.records`) as well as the waivers. Questions that are
not phase gates (unfilled settings, sign-in, a command the hook still asks
about) still stop the run. Questions inside a phase are not asked either: an
audit or review that returns `changes` gets one fix and one fresh re-audit, and
whatever remains is listed in the report and the record's note; a choice the
source and RULEBOOK leave open takes the most conservative option with a
`TODO(port)` in the RULEBOOK and is listed as decided without the person.

At an ordinary successful boundary, ask one question with these choices adapted
to the actual next phase:

- **Proceed:** name the phase, for example "Prepare the comparison tests".
- **Revise:** revise the current phase's artifacts; ask which issue to change if
  the answer did not specify it.
- **Pause:** stop and leave the saved artifacts available for later resumption.

Route translated-code revisions through the runner's repair/review flow. Handle
rulebook or judge amendments at a phase boundary and refresh affected validation;
the revise choice does not permit bypassing those existing controls.

For translation/build/smoke and runtime parity/post-parity or source-only handoff, the proceed choice must explicitly
say **approve and run the named stage**, identifying the current artifacts in the
question. Only after a real answer authorizes it, record the appropriate runner
approval and execute that stage. Never issue every future approval in advance.

The kit's hook makes the host ask the person to confirm every `approve`,
`phase complete`, `pilot prepare`, `source-spec init --apply`,
`guardrails install`, `build-loop` and `sessions prune` command, and it refuses any other agent write of
`migration/guardrails.json`. That host confirmation is the person's act; never ask
them to switch it off. The person works from chat only: run every command
yourself. When the session cannot ask (autopilot or a non-interactive run reports
"unable to ask user for confirmation"), stop and ask them to continue in an
interactive chat session instead of working around it. These hooks
work only where the host loads them (see `doctor`).
If artifacts or predecessor results changed, refresh the report and authorization
as required by the runner. A user's change request is not approval to proceed.

For a failed phase, follow [When a step fails](#when-a-step-fails). For a
recommendation against migration, offer relevant choices such as "Revise the
plan" and "Pause" with a recommended option and reasons. Do not recommend a
blocked next stage. Once the final report is complete, offer follow-up work
appropriate to the result; commit, push, merge and deployment need their own user
instruction. Do not create a question merely to end the conversation.

## When a step fails

First apply bounded recovery already authorized by the current phase: the
runner's transient retry and single survey correction, preserving validated
rows, read-only diagnostics and resuming the same authorized process. Report
what is happening; these operations do not need a new decision after each
attempt. Never kill, cancel or relaunch work solely for CPU at 100%, low CPU,
silence, elapsed time (including 600 seconds), output volume, or a host wait
returning a running session. Normal execution is continuous, including legacy
configurations. Do not add finite time/call/round limits unless the person chose
them. Wait on the same terminal/job and use `status --fast --format markdown`
for progress (add `--wait 600` when waiting). That wait returning never stops
the worker. Respect explicit cancellation and actual invalid inputs/permissions.
See [interruption policy and complete source index](INTERRUPTION-POLICY.md).

A deterministic TypeError/SyntaxError in a coordinator-owned preparation/report
helper is technical recovery inside the same authorized phase. Inspect the
implementation and call sites (especially array vs object return contracts),
fix that helper, run syntax and mechanical regression checks, and resume from
validated shards. Do not ask the person to choose fixing this bug versus omitting
the candidate, dropping validation or restarting survey. Prefer the standard
`preparation_cli.mjs inventory-preview` / hash-bound `inventory-merge` path.
This does not authorize changes to source, judge, RULEBOOK, inventory decisions
or protected evidence. If one of those must change, follow its actual gate.
For a new/changed helper, exercise the writer with a small representative input
(including comments and normal rows); syntax or shard validation alone does
not execute that path. This mechanical check needs no new model call.

The fast view labels recorded completion as not revalidated; it never grants
approval. Use normal status/phase checks when verifying a boundary. Do not
run full status and phase next repeatedly during the same preparation work:
they revalidate source evidence and are not required between survey scopes.

Ask only when recovery is exhausted or the next action requires a missing
decision, a new budget/model/limit, a changed scope or a human gate. Reuse an
answer already given for that same in-phase recovery action; a gate approval or
phase sign-off is never reused for another gate. In that case follow the report below.

Every failed command, failed phase check, blocked unit or refused gate ends with
a **failure report**, never with a bare error or a silent retry. Runner commands
print it after the `ERROR:` line (one section per distinct cause when several
units failed), `doctor` prints it for every failed check, and
`status --format markdown` appends it for blocked units; for failures from any other tool (a
script, a worker, a hook denial), run
`run_migration.mjs guidance --message "<the error text>"` to get the same
structure. Its output starts with "What to do about this message"
(「渡されたメッセージへの対処」) and exits 0:
that is the explanation you asked for, not guidance failing, even when the
message is not in the kit's catalog. When it says no decision is needed
(`actionRequired: false` in JSON, for example a credential check that found
nothing), continue without asking. A TODO or question tool that is unavailable or rejects a call is not
a failed step: use the chat fallbacks above. Adapt the guidance with what you
actually observed, then report:

1. **What failed:** the phase and command, and the progress checklist
   (`status --format checklist`; `status --format markdown` starts with it).
2. **Cause:** the concrete reason in plain words, with the file or receipt that
   shows it. Separate what you verified from what you suspect.
3. **Impact:** what is blocked and what is still valid (completed units and
   receipts stay on disk).
4. **Choices:** at least two options plus pausing. Mark exactly one
   **recommended**, put it first, and give the reason for every option: why it
   fixes the cause, what it costs or changes (for example "changes config, so
   approvals restart"), and when another option is better. Include the
   command each option runs, if any.
5. **Question:** ask with the question tool, recommended option first and
   labelled `（推奨）` / `(recommended)`; `guidance --format json` returns these
   labels as `choices`. Without a question tool, show the same
   numbered choices in chat with a reply example such as 「1で進めて」.

When a new decision is required, wait for the answer. Never pick an option on the user's behalf, never treat the
recommendation as consent, and never route around a guardrail or weaken a test
as an option. Options that are the human's own act (installing guardrails,
approving a gate, changing models or limits) say so explicitly; the agent runs
the command and the person's act is the agreement plus the host confirmation. After the chosen
option runs, report its result in the same format if it fails again; a third
failure of the same kind is a rule problem and the recommendation becomes a
rulebook amendment (upstream rule 6).

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
| Judge validation | Current `migration/results/judge.json`: runtime original/mutation results; source-only validated source preparation and equivalence unverified | 03 stress test |
| 03 stress test | `migration/stress-test/report.md`, pilot results and remaining decisions | Approve and start translation |
| 04 translation | Output paths, reviewed done/total, blocked units and run summary | Approve and run build |
| 05 build | `migration/results/build.json`, success or concrete diagnostics | Approve and run smoke |
| 05b smoke | `migration/results/smoke.json`, asserted target public scenario and outcome | Runtime: approve/run parity; source-only: prepare and review 06 handoff |
| 05c parity | Runtime: current parity receipt and comparison results; source-only: unverified / not run, no passed parity receipt | Runtime: approve post-parity; source-only: 06 handoff |
| 06 handoff | Runtime: approved post-parity changes and final verification; source-only: reviewed handoff.md, current smoke and separate approve handoff + handoff receipt, equivalence unverified | User-chosen follow-up |

The formal judge command needs the rulebook, inventory, manifest and dependency
map. Phase 00b prepares the judge and saves its design/results report; it may
defer the formal receipt until those artifacts exist. Do not loop back to 00b
solely because `results/judge.json` is absent before phase 01. Judge validation
does not require an `approve judge` command. Post-parity has an approval gate but
no executable `run_migration.mjs post-parity` command; follow prompt 06 after
approval instead. Status labels a current runtime approval as approved with
cleanup completion unconfirmed, and asks for the cleanup and a results report.
Approval alone does not establish that prompt 06 work is complete.

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

## Parent session and evidence display

The top-level user-facing parent retains this contract even when a skill uses an
orchestrator agent. A child orchestrator returns plan/status/decisions; it never
updates the user-facing TODO or asks questions. Local subagents have no TODO or
question tools ([host contract](https://code.visualstudio.com/docs/agents/run/subagents)).
At start/resumption and before long investigations, show all ten phases and the
current phase. Confirm actual exposed TODO tool responses. Tool success and
verified UI rendering are different: if the tool fails, is unavailable or the user
reports no display, show the identical checklist in chat without changing settings.
Live UI verification remains pending until performed on the user's host.

00 is suitability/scope, 00b comparison preparation, 03 a disposable prototype,
and 04 production implementation. In 00/00b reports use actionable findings:
ID, severity, evidence/target, impact, proposed fix, owner (AI/user/environment),
completion criterion and whether it blocks implementation. Mark deferrable checks.
The parent performs authorized AI-owned fixes and groups only necessary decisions
for the user. Missing judge receipt before 01 never alone repeats 00b.

[Source-only](SOURCE-ONLY.md) keeps 05c unverified and routes current smoke to
reviewed 06 handoff via approve handoff and handoff; runtime keeps parity and
post-parity. [Rubber Duck](RUBBER-DUCK.md) is host-provided advisory only.

## Ordered workflow and usage records

The skill first initializes the [ordered workflow](ORDERED-WORKFLOW.md) and asks the runner for the first incomplete phase. Before work use phase start; review and record phases 00 through 03 explicitly. Existing files alone never select a later phase. Runtime phase 06 needs an actual final report and completion record; source-only 05c records its unverified applicability before handoff. [Cost logs](COST-LOG.md) preserve the main branch TSV format and unknown usage.
