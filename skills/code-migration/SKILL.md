---
name: code-migration
description: Run a staged, behavior-preserving language migration with GitHub Copilot. Use for whole-codebase language ports, migration feasibility, translation rules, dependency maps, parity verification, or resuming a migration. Not for ordinary refactors or incremental JavaScript-to-TypeScript adoption.
---

# Code migration

For config.executionPurpose `pilot`, follow [pilot execution](../../docs/PILOT.md)
using pilot run and the sealed grant; do not initialize production phase records
or manufacture a phase-03 result. Otherwise follow the production sequence below.

## Read only what the current step needs

Read the [operating manual](../../docs/OPERATING-MANUAL.md) first: it is the short
canonical rule set. Do not read the README or the other kit documents up front;
the parent's context is the migration's most expensive shared resource. Open a
document when the current phase prompt links it or a step needs it:
[preparation audits](../../docs/PREPARATION-AUDITS.md) for 00b/01/02,
[execution scopes](../../docs/EXECUTION-SCOPES.md) for approved batches/repair queues, and
[usage](../../README.md) for installation or configuration questions. On resumption,
re-read the current phase prompt, not the whole kit.
Resolve the plugin root from this SKILL.md location: it is two directories above
this file. Follow the [runner](../../scripts/run_migration.mjs) and
[installer](../../scripts/install.mjs) links to obtain their absolute paths.
Run every command with the migration target repository as cwd. Never assume the
plugin lives in that repository or that `${PLUGIN_ROOT}` expands in Markdown.
In the shared prompts/manual, replace `migration-kit/` in executable paths with
the resolved absolute plugin root; keep all project-relative inputs and outputs.

## Chat only: the person never types commands

The person drives the whole migration from this chat. Run every command yourself
in the terminal (a background or continuing terminal for long runs) and report the
results in chat. The person's own acts are chat answers, the host's confirmation of
human-gate commands (`approve`, `phase complete`, `pilot prepare`,
`source-spec init --apply`, `guardrails install`) and, once, approving the Copilot
CLI sign-in in the browser. Do not hand them commands to type.

Workers always run as Copilot CLI processes, also from VS Code. Before
initialization check `copilot --version`; afterwards `run_migration.mjs doctor
--check-cli`. If the CLI is missing, explain why it is required, ask with the
question tool and, after a yes, run `npm install -g @github/copilot` (Node 22+; on a
permission error, show the cause and choices from `run_migration.mjs guidance`).
If it is not signed in (doctor or a worker reports "To authenticate" or
`session.error authentication`), ask, then run `copilot login` in a background
terminal, show the URL and any one-time code it prints in chat, wait for it to
finish and run doctor again. Signing in to VS Code does not sign in the CLI.

## Report language (first step)

Before anything else at start or resumption, run `run_migration.mjs preferences`
(skip only before initialization, see below). If it returns an `action`, ask the
user with the available question tool: 日本語 (ja) or English (en). Record the
answer with `preferences --language ja|en` (it lives outside config.json and
never revokes approvals). The hook denies any other question until the language
is recorded, and with ja denies a question that has no Japanese text. Re-read
the preference after a compaction. Write every user-facing report, question, TODO label
and next-instruction example in that language, and link the matching documents:
`X.md` for Japanese, `X.en.md` for English (for example [README](../../README.md) /
[README.en](../../README.en.md)). Worker prompts and JSON stay in English. Before
initialization, ask the language and the migration languages
(one question per call with Copilot CLI `ask_user`; VS Code `vscode/askQuestions`
takes them together) and pass `--language ja|en` to the installer.

If migration/config.json is missing, ask for the migration languages, then
choose the initialization command for the current host (reuse any explicit
execution preference) and run it without model flags, in VS Code or the Copilot
CLI alike: `node "<absolute-plugin-root>/scripts/install.mjs" --target . --layout plugin`.
Apply with `--apply` once project initialization is authorized, and configure
languages, source/output/test roots and validation commands. Initialization
creates only migration/config.json, RULEBOOK.md and inventory.tsv; it does not
approve or run migration stages. An existing configuration with runtime other
than plugin requires an explicit layout change rather than a silent overwrite.
For initialized projects, require `"runtime": "plugin"` in migration/config.json.
Use the plugin's code-migration-plugin-orchestrator agent for phase planning.
The Node runner selects private plugin worker profiles and explicitly mounts this
plugin.

**Models and reasoning effort are the person's choice.** After initialization,
and whenever they ask to change models, run
`run_migration.mjs models list --format markdown`: it lists the models and
reasoning efforts their own Copilot account offers (read live from the CLI) and
the current assignment. Show it, then ask one question per worker role
(implementer, reviewer-semantics, reviewer-rules, arbiter, fixer; surveyor
follows the implementer unless they pick one), offering the listed model IDs as
choices, then that model's listed efforts plus `default`. The person may answer
"same for all" or "same for both reviewers". You may explain the upstream model
plan — tier by blast radius: reviewers on the largest or a mid model,
high-volume implementers on a mid or small model, fixers and the arbiter on a
mid model; higher effort costs more tokens — as information, never as a
preselected answer, and never choose for them. Record each answer with
`run_migration.mjs models set --role ROLE --model ID --effort LEVEL|default`
(`--role reviewers` or `all` for shared answers); the host asks them to confirm.
If `models list` reports that the CLI is not signed in, start `copilot login`
first. A changed model or effort makes reviewed units be reviewed again.

Follow [phase reports and user decisions](../../docs/PHASE-HANDOFF.md) at every
phase boundary. Show the actual artifacts, review points and a copyable next
instruction before asking. Use the available question tool for missing decisions;
otherwise present the choices in chat and wait. Reuse answers already given.
An automatic reply that the user is not available (Copilot CLI autopilot) is not
an answer: choose nothing and ask the person to continue interactively.
After a phase, resolve the next step from the user's instruction and current
evidence, not just a report/template's existence.

At start or resumption, follow the [ten-phase TODO tracking contract](../../docs/PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list).
Create or reconcile the host TODO list before starting phase work; update it on
phase start, completion, approval waits, revisions, failures and resumption.
Only the parent orchestrator updates it from actual evidence. If the tool is
unavailable, show the same checklist in chat. TODO items never authorize a gate.
Build the items from `run_migration.mjs status --format todo` (ten phases, names
in the user's language; the current phase is in progress only while it runs or
is worked on, otherwise not-started with its state in the title) and put the output of
`status --format checklist` at the top of every phase and failure report, so the
user always sees which phase is current even when the TODO UI does not render.

The runner selects the first incomplete phase. Existing artifacts supply evidence
for review; they do not route directly to a later phase. Respect redesign mode.

## No runnable original or no specification

Before choosing a verification mode (at initialization, and whenever runtime 00b
blocks), ask two yes/no questions with the question tool, one per call: can the original
implementation still run here, and does a specification or portable test suite
exist? Record the first answer with `run_migration.mjs preferences --original-runtime
available|unavailable` (presentation only; failure guidance uses it to pick its
recommendation). If both answers are no, recommend [source as the only specification](../../docs/SOURCE-AS-SPEC.md)
(`--preparation-profile source-as-spec` for a new project, `source-spec init`
then `--apply` after consent for an existing one) and explain that equivalence
stays unverified; if the original runs, recommend runtime. The user chooses.
In source-as-spec, draft 00b, 01 and 02 together from the source, run one
independent review of the package, show one report and record
`phase complete 00b,01,02 --note TEXT` only after the user's OK.

## Keep the parent's context small

In 00, 00b (source-as-spec) and 02, do not read the whole codebase yourself on
anything but a small repository. Use [surveys](../../docs/SURVEYS.md): `survey run --kind
facts|contracts|inventory` sends each scope to a fresh tool-free surveyor (a new
Copilot CLI process) and saves its answer as a file; `survey merge` builds the draft you review. Check cited lines before relying
on them; merged drafts still go through the phase's audits and the human gate.
Run each independent preparation audit (00b/01/02) as `audit_inputs.mjs freeze`
then `audit_inputs.mjs run --directory DIR`: a fresh tool-free Copilot CLI
worker with `--model` set to the planned phaseModels entry, recording the model
the CLI reports. Two requests on disjoint batches can run in parallel;
`audit_inputs.mjs run-pending` runs every unsubmitted request. Never hand a
request or its path to a task/agent subagent: the auditor has no tools.

## When a step fails

Follow [When a step fails](../../docs/PHASE-HANDOFF.md#when-a-step-fails) for every
failed command, refused gate or blocked unit: cause, impact, at least two
choices plus pause, exactly one recommended option first, a reason for each,
then ask with the question tool and wait. Runner errors already print this
guidance; for other failures run `run_migration.mjs guidance --message TEXT`.
Never choose on the user's behalf or offer routing around a guardrail.

## Ordered workflow entry

Before routing a configured project, run `run_migration.mjs phase init`, then
`phase next`. Follow [ordered workflow](../../docs/ORDERED-WORKFLOW.md).
Run only the first incomplete phase; use `phase start ID` before work. For 03,
work through and show the [one-page checklist](../../docs/STRESS-TEST-CHECKLIST.md). Phases
03/04 need `migration/guardrails.json`, the human's decision: propose the list from
`guardrails show` adapted to this target's build/test commands (or a waiver with its
reason), and after their agreement in chat run `guardrails install` with exactly
those options. Never write the file any other way (the hook denies it). The host
asks the person to confirm every `approve` / `phase complete` / `guardrails install`
command; if it cannot ask (autopilot denies the request), tell the person to leave
autopilot and retry instead of working around it. Run gate commands only in an
interactive session without autopilot, which denies them. The Copilot CLI may show
its own permission prompt after the hook's question, so the person can be asked
twice. An explicit
request for a later phase does not waive missing earlier reviews. Do not route
from file existence. After user review, record early phases with `phase complete
ID --note TEXT`; runner receipts determine implementation and validation phases.
Keep all ten phases visible. Source-only 05c needs an explicit unverified-mode
acknowledgment before handoff. Record known host usage with completion;
[main-format cost logs](../../docs/COST-LOG.md) use unknown where unavailable.

## Worker execution

Workers are isolated Copilot CLI processes started by the Node runner: `--model`
fixes each worker's model, tools are restricted and implicit instructions are
excluded (verified on a real CLI). In VS Code the parent runs the runner in the
integrated terminal. A configuration from the removed VS Code subagent backend
stops with migration instructions: show them, and after the person's OK set
`"workerBackend": "copilot-cli"`, remove the listed keys and redo judge and the
translation approval.

At initialization also offer these settings as the user's choice. `fixPolicy`:
`rereview` (default; a fixed output is reviewed again until no confirmed finding
remains) or `single-pass` (upstream Step 3: one fix of the confirmed findings,
then build/smoke/parity judge it; fewer calls and fewer blocked units).
`dependencyOrder: auto` (new installs) lets the approved scope fan out like
upstream and holds dependents for reviewed dependencies only when a per-unit
typecheck needs them. `concurrency` (up to 64, both reviewers included) should
stay within the account's rate limits. `reviewFocus`: `shared` (new installs; both
reviewers check semantics and rules, each from its own lens first) or
`specialized` (one check each, upstream's split). Changing `fixPolicy`,
`dependencyOrder` or `reviewFocus` revokes approvals. Run limits (`concurrency`,
`maxAgentCalls`, `maxFixRounds`, timeouts, retry settings, `maxRunInputBytes`,
`maxAiCreditsPerCall`) can change between runs and keep reviewed work and approvals.

Run a long `translate` or `build-loop` in a background or continuing
terminal and check it with `status --wait 600 --format markdown`: the runner
itself waits up to that many seconds and answers as soon as a unit finishes or
the run stops, so each check costs one model turn, not one per poll. Never
block the parent on the run or kill it for being slow. When status shows a worker retrying after a transient failure
(rate limit, service error), tell the user at once: the runner waits and retries
by itself; if it persists, offer a lower `concurrency` after the run (it keeps
reviewed work). A run that stops at its AI call budget is a budget stop: rerun
`translate`, or propose `translate --max-calls N` with the number the person agrees.

After a failed build, propose `build-loop --note TEXT [--max-rounds N]
[--max-calls N]` (defaults 5 rounds and `maxAgentCalls` AI calls for the whole
loop; say both numbers): one host-confirmed grant that rebuilds, parses errors
into the repair queue, runs reviewed repairs and stops when clean, at the round
or call limit, or when the error count stops falling (then propose a rule
amendment). While it runs, other runner commands are refused; check `status --wait`.
Show the round counts and calls used.

After a failed smoke or parity (upstream Step 6), triage every divergence against
the original first: regression, inherited, environment or comparator defect.
For regressions run `repair-round --stage smoke|parity`: output lines that name
translated files become the reviewed repair queue; when none do, write the
confirmed regressions as `file<TAB>module<TAB>code<TAB>message` rows and run
`diagnostic_queue.mjs --stage parity --diagnostics migration/PATH.tsv`, then
`repair --queue`. The person then approves build, smoke and parity again. A
failing original suite is never repaired in translated outputs.

Workers are local-only (`--no-remote-export`), named Copilot CLI sessions whose
IDs the runner journals before each call (retries and interrupted calls included); their transcripts contain source code. After the
migration, report `sessions status` and, only if the user agrees, run
`sessions prune` (it deletes only the kit's own worker sessions).

Use `run_migration.mjs status` for progress. Never silently install policies,
change models, approve a stage, increase limits, weaken tests, or declare partial
outputs complete. The user's explicit instruction can authorize a concrete gate.

## Parent-session phase ownership

The top-level user-facing session retains phase planning, TODO display and
questions. Using an orchestrator agent for planning never transfers
the whole migration to a child. If invoked as a subagent, it returns the plan,
status and decisions to the parent; it does not update TODO or ask questions.
Local subagents cannot use TODO/question tools. Before long work, show all ten
phases and the current phase. Use the actual exposed TODO schema, check its
response, preserve unrelated tasks and avoid duplicates. Success of a tool call
does not prove the UI is visible; if unavailable, failed or reported invisible,
show the same checklist in chat. Actual VS Code rendering needs live verification.

Read [source-only verification](../../docs/SOURCE-ONLY.md) for explicit source-only
setup and smoke-to-handoff routing. Read [built-in Rubber Duck](../../docs/RUBBER-DUCK.md)
for milestone advisory review and adopted fix/reverification records.
Use status --format markdown even before a manifest exists. Artifact candidates
are not phase approval or validated completion.

In source-only mode, after reviewed successful smoke mark 05c unverified and
prepare/review 06 handoff; use approve handoff then handoff. Do not approve or
execute parity or post-parity. Runtime projects keep those existing gates.
