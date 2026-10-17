---
name: code-migration
description: Run a staged, behavior-preserving language migration with GitHub Copilot. Use for whole-codebase language ports, migration feasibility, translation rules, dependency maps, parity verification, or resuming a migration. Not for ordinary refactors or incremental JavaScript-to-TypeScript adoption.
---

# Code migration

For config.executionPurpose `pilot`, follow [pilot execution](../../../docs/PILOT.md)
using pilot run and the sealed grant; do not initialize production phase records
or manufacture a phase-03 result. Otherwise follow the production sequence below.
Read [preparation audits](../../../docs/PREPARATION-AUDITS.md) for 00b/01/02 and
[execution scopes](../../../docs/EXECUTION-SCOPES.md) for approved batches/repair queues.

Read the [operating manual](../../../docs/OPERATING-MANUAL.md) and [usage](../../../README.md).
Locate the installed kit at `migration-kit/`; when maintaining the kit itself,
its scripts and prompts are at repository root.

## Report language (first step)

Before anything else at start or resumption, run `run_migration.mjs preferences`
(skip only before initialization, see below). If it returns an `action`, ask the
user with the available question tool: 日本語 (ja) or English (en). Record the
answer with `preferences --language ja|en` (it lives outside config.json and
never revokes approvals). Write every user-facing report, question, TODO label
and next-instruction example in that language, and link the matching documents:
`X.md` for Japanese, `X.en.md` for English (for example [README](../../../README.md) /
[README.en](../../../README.en.md)). Worker prompts and JSON stay in English. Before
initialization, ask the language together with the model and migration
languages and pass `--language ja|en` to the installer.

Follow [phase reports and user decisions](../../../docs/PHASE-HANDOFF.md) at every
phase boundary. Show the actual artifacts, review points and a copyable next
instruction before asking. Use the available question tool for missing decisions;
otherwise present the choices in chat and wait. Reuse answers already given.
After a phase, resolve the next step from the user's instruction and current
evidence, not just a report/template's existence.

At start or resumption, follow the [ten-phase TODO tracking contract](../../../docs/PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list).
Create or reconcile the host TODO list before starting phase work; update it on
phase start, completion, approval waits, revisions, failures and resumption.
Only the parent orchestrator updates it from actual evidence. If the tool is
unavailable, show the same checklist in chat. TODO items never authorize a gate.
Build the items from `run_migration.mjs status --format todo` (ten phases, one
in progress, names in the user's language) and put the output of
`status --format checklist` at the top of every phase and failure report, so the
user always sees which phase is current even when the TODO UI does not render.

The runner selects the first incomplete phase. Existing artifacts supply evidence
for review; they do not route directly to a later phase. Respect redesign mode.

## No runnable original or no specification

Before choosing a verification mode (at initialization, and whenever runtime 00b
blocks), ask two questions with the question tool: can the original
implementation still run here, and does a specification or portable test suite
exist? Record the first answer with `run_migration.mjs preferences --original-runtime
available|unavailable` (presentation only; failure guidance uses it to pick its
recommendation). If both answers are no, recommend [source as the only specification](../../../docs/SOURCE-AS-SPEC.md)
(`--preparation-profile source-as-spec` for a new project, `source-spec init`
then `--apply` after consent for an existing one) and explain that equivalence
stays unverified; if the original runs, recommend runtime. The user chooses.
In source-as-spec, draft 00b, 01 and 02 together from the source, run one
independent review of the package, show one report and record
`phase complete 00b,01,02 --note TEXT` only after the user's OK.

## When a step fails

Follow [When a step fails](../../../docs/PHASE-HANDOFF.md#when-a-step-fails) for every
failed command, refused gate or blocked unit: cause, impact, at least two
choices plus pause, exactly one recommended option first, a reason for each,
then ask with the question tool and wait. Runner errors already print this
guidance; for other failures run `run_migration.mjs guidance --message TEXT`.
Never choose on the user's behalf or offer routing around a guardrail.

## Ordered workflow entry

Before routing a configured project, run `run_migration.mjs phase init`, then
`phase next`. Follow [ordered workflow](../../../docs/ORDERED-WORKFLOW.md).
Run only the first incomplete phase; use `phase start ID` before work. For 03,
work through and show the [one-page checklist](../../../docs/STRESS-TEST-CHECKLIST.md). Phases
03/04 need human-installed `migration/guardrails.json`; ask the human, never create it
(the hook denies agent edits of it). The host asks the person to confirm every
`approve` / `phase complete` command; if it cannot ask, hand them the command to run. An explicit
request for a later phase does not waive missing earlier reviews. Do not route
from file existence. After user review, record early phases with `phase complete
ID --note TEXT`; runner receipts determine implementation and validation phases.
Keep all ten phases visible. Source-only 05c needs an explicit unverified-mode
acknowledgment before handoff. Record known host usage with completion;
[main-format cost logs](../../../docs/COST-LOG.md) use unknown where unavailable.

## Worker execution backend

Choose the worker backend with the user at initialization. The default
`copilot-cli` backend applies in VS Code as well: the parent runs the Node
runner in a terminal and the runner starts isolated Copilot CLI workers
(signed-in Copilot CLI required; each worker's model is fixed by `--model` and
instruction isolation is verified). When the Copilot CLI is not
available or the user wants to run inside VS Code only, offer `native` with
`nativeModelVerification: requested-unverified` (the installer default for
native): host subagents do the work and every record states that the executed
model is unverified. State that trade-off before the user chooses; never switch
on your own. `host-metadata` stays EXPERIMENTAL and cannot complete on VS Code
today. Preserve existing config; changing backend requires fresh judge
validation and translation approval, not a silent switch during a run.

When config.workerBackend is native, follow [native workers](../../../docs/NATIVE-WORKERS.md).
First confirm doctor's `native host requirements` with the user (VS Code 1.117+,
`chat.customAgentInSubagent.enabled`, models allowed for subagents).
Keep the runner active in a continuing terminal, claim pending jobs, delegate
the exact prompt to the named tool-free host subagent with the requested model,
and submit unchanged results. Dispatch independent jobs in parallel within the
configured and host limits. The parent must service jobs while the runner waits.
Do not inherit the parent conversation or add other reviewers' results.
If the required model/profile/tools cannot be selected, report a failed job;
never substitute the parent agent, edit the target, or fall back to CLI.
Select the model through the host's actual per-call model parameter, not prompt
text. With `host-metadata`, check host execution metadata before submitting and
fail the job if it is absent, different or ambiguous. With
`requested-unverified`, submit with `--model` equal to the model you passed to
the host's per-call model parameter; if the host offers no per-call model
selection or rejects that model, fail the job instead. Never echo a model you
did not request, ask the worker to identify itself, or describe the result as a
verified model; reports say 「実行モデル未検証」/ "executed model unverified".
On cancellation stop host workers too; only the runner's receipts establish done.

Use `run_migration.mjs status` for progress. Never silently install policies,
change models, approve a stage, increase limits, weaken tests, or declare partial
outputs complete. The user's explicit instruction can authorize a concrete gate.

## Parent-session phase ownership

The top-level user-facing session retains phase planning, TODO display, questions
and native dispatch. Using an orchestrator agent for planning never transfers
the whole migration to a child. If invoked as a subagent, it returns the plan,
status and decisions to the parent; it does not update TODO or ask questions.
Local subagents cannot use TODO/question tools. Before long work, show all ten
phases and the current phase. Use the actual exposed TODO schema, check its
response, preserve unrelated tasks and avoid duplicates. Success of a tool call
does not prove the UI is visible; if unavailable, failed or reported invisible,
show the same checklist in chat. Actual VS Code rendering needs live verification.

Read [source-only verification](../../../docs/SOURCE-ONLY.md) for explicit source-only
setup and smoke-to-handoff routing. Read [built-in Rubber Duck](../../../docs/RUBBER-DUCK.md)
for milestone advisory review and adopted fix/reverification records.
Use status --format markdown even before a manifest exists. Artifact candidates
are not phase approval or validated completion.

In source-only mode, after reviewed successful smoke mark 05c unverified and
prepare/review 06 handoff; use approve handoff then handoff. Do not approve or
execute parity or post-parity. Runtime projects keep those existing gates.
