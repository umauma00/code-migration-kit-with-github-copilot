---
name: code-migration
description: Procedure of the code migration orchestrator agent (migration-orchestrator, or code-migration-plugin-orchestrator in the plugin) for a staged, behavior-preserving language migration. Use for whole-codebase language ports, migration feasibility, translation rules, dependency maps, parity verification, or resuming a migration. Not for ordinary refactors or incremental JavaScript-to-TypeScript adoption.
user-invocable: false
---

# Code migration

This skill is the procedure of the migration orchestrator agent:
`migration-orchestrator`, or `code-migration-plugin-orchestrator` from the plugin.
It is hidden from the slash menu, and the orchestrator is the kit's only entry
point. If you are not running as that agent (for example, another agent loaded
this skill on its own), do not start, resume or approve migration phases: tell
the person to select the orchestrator in the agent picker (Copilot CLI: `/agent`)
and stop. Only installing or initializing the kit with `install.mjs`, when the
person asks for it, is still allowed. A subagent started by the orchestrator is
not such an agent: it follows "Parent-session phase ownership" below and returns its plan and status to
the orchestrator without starting or approving phases.

At start, check whether `.github/prompts/migrate-*.prompt.md` files from 0.6.0
or earlier remain in the target repository. If they do, they bypass the orchestrator: propose deleting them and
delete them only after the person agrees.

For config.executionPurpose `pilot`, follow [pilot execution](../../../docs/PILOT.md)
using pilot run and the sealed grant; do not initialize production phase records
or manufacture a phase-03 result. Otherwise follow the production sequence below.

## Read only what the current step needs

Read the [operating manual](../../../docs/OPERATING-MANUAL.md) first: it is the short
canonical rule set. Do not read the README or the other kit documents up front;
the parent's context is the migration's most expensive shared resource. Open a
document when the current phase prompt links it or a step needs it:
[preparation audits](../../../docs/PREPARATION-AUDITS.md) for 00b/01/02,
[execution scopes](../../../docs/EXECUTION-SCOPES.md) for approved batches/repair queues, and
[usage](../../../README.md) for installation or configuration questions. On resumption,
re-read the current phase prompt, not the whole kit.
Locate the installed kit at `migration-kit/`; when maintaining the kit itself,
its scripts and prompts are at repository root.

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

The GitHub Copilot app is built on the Copilot CLI: its question tool is
`ask_user`, the agent picker and `/agent` select the orchestrator, and its
Autopilot session mode is the CLI's autopilot. Workers still start as separate
`copilot` processes from the terminal, so the app needs the CLI installed and
signed in like VS Code does. Migrations run in "This computer" sessions. If a
worker cannot reach the network or its sign-in inside an app session with local
sandboxing on, show the error and tell the person that `/sandbox off` in that
session lets the worker run, and that commands in that session then run without
the sandbox's limits; do not route around the sandbox yourself.
A sandbox also blocks phase 03, which writes comparison B and the pilot outside
the repository, in VS Code and the Copilot CLI too. So setup finds it first:
when `settings apply` returns `sandboxQuestion`, ask it as its `next` says,
before phase 00 and before showing `autoHandoff`; doctor reports the same as
`commands can write outside the project and use loopback`. Autopilot cannot
answer it, and only the person changes sandbox settings.
If the installer preview returns `existingMigrations`, another worktree of this
repository already holds a migration (the app can start a session in a new
worktree). Ask one question before `--apply`: resume in that checkout
(recommended; in the app, a new session with Workspace "Current checkout" there)
or start a new migration here.

## Report language (first step)

Before anything else at start or resumption, run `run_migration.mjs preferences`
(skip only before initialization, see below). If it returns an `action`, ask the
user with the available question tool: 日本語 (ja) or English (en). Record the
answer with `preferences --language ja|en` (it lives outside config.json and
never revokes approvals). The hook denies any other question until the language
is recorded, and with ja denies a question that has no Japanese text. Re-read
the preference after a compaction. Write every user-facing report, question, TODO label
and next-instruction example in that language, and link the matching documents:
`X.md` for Japanese, `X.en.md` for English (for example [README](../../../README.md) /
[README.en](../../../README.en.md)). Worker prompts and JSON stay in English. Before
initialization, ask only the report language and pass `--language ja|en` to the
installer; everything else is decided in the [run settings file](#run-settings-file-instead-of-one-question-per-setting).

**Models and reasoning effort are the person's choice.** At setup, one question
picks the model for every role and the run settings file takes per-role changes
(below). When the person asks in chat to change models later, run
`run_migration.mjs models list --format markdown`: it lists the models and
reasoning efforts their own Copilot account offers (read live from the CLI) and
the current assignment. Show it, then ask **one** question that covers every
role and effort at once — never one question per role (one `ask_user` call in
the Copilot CLI; one `vscode/askQuestions` question in VS Code). Offer as
choices "every role on MODEL (default effort)" for each listed enabled model,
and take any mix as the free-text answer in the form the list's "Choose
everything in one answer" section shows:
`implementer=ID:EFFORT, reviewers=ID:EFFORT, arbiter=ID:EFFORT, fixer=ID:EFFORT`
(effort left out = default; `all=ID` first, then overrides; roles are
implementer, reviewer-semantics, reviewer-rules, reviewers, arbiter, fixer,
surveyor, all; surveyor follows the implementer unless named). The same answer
picks the context size: `:long_context` after the effort (`ID:EFFORT:long_context`)
selects the long context tier, only for models whose Context column lists it;
left out, the role runs the default context. Say that long_context costs more,
and never add it on their behalf. You may explain
the upstream model plan — tier by blast radius: reviewers on the largest or a
mid model, high-volume implementers on a mid or small model, fixers and the
arbiter on a mid model; higher effort costs more tokens — as information, never
as a preselected answer, and never choose for them. Record the whole answer with
one `run_migration.mjs models set --assign "ROLE=ID:EFFORT,..."` (a single
choice for everyone may use `--role all --model ID --effort LEVEL|default`);
run as a command of its own, the host does not ask again. Every entry is checked before anything is
written: if one is refused (unlisted model, unsupported effort or context), nothing
changes, so ask again about that entry only and record the full answer again.
If `models list` reports that the CLI is not signed in, start `copilot login`
first. A changed model, effort or context makes reviewed units be reviewed again.

## Run settings file (instead of one question per setting)

After initialization, choose the models first with **one** question for every
role: run `run_migration.mjs models list --format markdown`, show it, and offer
each enabled model as a choice ("every role on MODEL"). Record the answer with
`run_migration.mjs models set --role all --model ID` as a command of its own
(the person already chose, so the host does not ask again; every role then runs
the model's default effort and context).
If the list cannot be read, offer no models: sign the CLI in first. Then run `run_migration.mjs settings init`. It writes
`migration/run-settings.json` from the current configuration: report language,
whether the original can still run, migration languages, preserve or redesign,
source/output/test roots, verification mode, execution mode, concurrency, stage
commands, and every role's model, effort and context size. The file holds only
values: each field's explanation and choices, and the account's models, efforts
and context tiers (read live from the CLI), are in `migration/run-settings.help.md`
beside it (rewritten by every `settings init`, never read back). `FILL_IN` marks
what is still open; every role already holds the model just chosen, and the
person edits a role only to give it another model, effort or context.

**Questions are for someone who knows nothing about the kit.** Before every
question, follow [how to write a question](../../../docs/PHASE-HANDOFF.md#write-every-question-for-someone-who-knows-nothing-about-the-kit):
the situation in everyday words, each choice as what will happen with its good
and bad points, one recommendation first with its reason, pause last, and no kit
terms, IDs, paths or command lines ([plain words](../../../docs/PLAIN-WORDS.md)).

**First choices are questions, never file edits.** Every entry a question
fills (models, languages, phase mode, whether the original runs) is asked with
the question tool and recorded by a command; the file then shows the answer. The
file is for changing settings later (several at once, such as every role's
effort), and for resuming in another session. Never tell the person to type a
first choice into the file, even when `settings apply` reports it still
`FILL_IN`: its `next` sends you back to `settings init`, which asks it.

While the languages are open, the result also carries `languages`: a guess of
the source language from the project's files (counted by extension, leaving out
dependencies, build output, hidden folders and the output and test roots) and
a ready question in the report language. Ask it as **one** question: the
choices are `languages.choices` (target languages), and free text names
another target or corrects the source. Record the answer with
`run_migration.mjs settings init --source SOURCE --target TARGET` (the guessed
source unless the answer corrected it). The file then holds both languages and,
while the folders are still the template's, the source language's detected
folders as `sourceRoots`. The kit migrates one source language: when
`languages.detected.mixed` lists another language of comparable size, the
question says so and the person names the main one; smaller languages
(`minor`) are not treated as the source language (the bundled dependency
mapper reads only its files). A typed name such as `csharp` or `VB` is
recorded as the name the mappers recognize. If no folder outside the test
folders holds the source language, the result has `sourceRootsUnchosen` and a
ready `sourceRootsQuestion`: say so, ask it as **one** free-text question and
record the answer with `run_migration.mjs settings init --source-roots DIR[,DIR]`
(each must be a folder in the repository that holds files, not the root;
otherwise the error says why and you ask again). An accepted answer is never
asked again. Files only at the repository root must first be moved into a
folder; the question says so. If nothing was
found, the question asks for both languages as free text.

Third, while `phaseMode` is still open (`settings init` says so), ask **one**
question about how phases advance: normal (recommended; each phase waits until
its prerequisites are met), relaxed (a missing prerequisite is a warning, and
the person decides each time whether to fix it or proceed) or auto (relaxed
without asking, for Copilot CLI autopilot; completions, approvals and waivers
are recorded unasked and marked auto). Record the answer
with `run_migration.mjs preferences --phase-mode normal|relaxed|auto`; the file
follows (the host asks the person to confirm auto). The person may switch later by editing the file or asking in chat;
switching never revokes approvals or completion records. See
[relaxed mode](../../../docs/ORDERED-WORKFLOW.md#relaxed-mode).

Fourth, while `originalRuntime` is still open, `settings init` returns
`originalRuntimeQuestion` (a ready question in the report language with two
choices: it runs / it does not run). Ask it as **one** question and record the
answer with `run_migration.mjs preferences --original-runtime available|unavailable`;
the file follows. When the answer is unavailable and the file's verification
mode is runtime, the file's `verificationMode` becomes `source-only` (runtime
verification runs the original) and the result's `verificationMode` note says
so; tell the person. When the answer is available but the file says
`source-only`, the note asks you to ask whether to verify by running the
original; set `runtime` in the file only on their yes. Then run `settings init`
again.

Fifth, only when the original does not run, `settings init` returns
`specificationQuestion`: is there a specification or a test suite the target can
use too? Ask it as **one** question and record the answer with
`run_migration.mjs preferences --specification available|unavailable`, then run
`settings init` again. Unavailable means the source is the only specification:
after `settings apply`, its `next` has you run `source-spec init`, show the
changes, and run `source-spec init --apply` (the host asks once, except in auto mode) during setup,
so phase 00b never stops on that switch.

Whenever a `settings init`, `settings apply` or `source-spec init` result
carries `setupNotice` (auto mode is chosen and setup is not done), put it first
in the question you ask, as written, so the person knows the run is still manual.
When a result carries `autoHandoff`, setup is done: show it as written and end
the turn without starting phase 00. If a setup question is answered by the host
itself (autopilot), it is not an answer: say that setup is still manual and ask
the person to leave autopilot and answer.

Then link the file and the help file and ask **one**
question with the question tool: has the person finished filling it in, or do
they have a question? Offer two choices, "filled in" and "I have a question"
(free text), in the report language.

- Filled in: run `run_migration.mjs settings apply`. It checks every entry
  (the account's model list, each model's efforts and the runner's own
  configuration checks), writes nothing unless all pass, and records the values
  in migration/config.json and migration/preferences.json. Run it as a command of
  its own: the person's answer is the approval, so the host does not ask again
  (it asks only when the file switches auto mode on, or when the command is
  chained with another). If it returns `errors`, show every error and ask the
  same question again. Batch setting changes into the file and apply them once.
- A question: answer it, then ask the same question again. Edit the file only
  when the person asks you to; never choose a value for them. You may explain
  the upstream model plan as information, never as a preselected answer.

`settings check` validates without writing. Running `settings init` again keeps
the person's values, fills entries still `FILL_IN` from what was chosen since
(such as the models), and refreshes the explanations and choices. The file stays
as the record of the conditions a run used: `status` reports whether it still
matches the configuration, and after an edit says it is not applied yet. To
change settings later, the person edits the file and the same question follows.
`models set` and `preferences` also write what they set (the named roles'
model, effort and context; the given preferences) into the file, so apply never
writes an older choice back; the person's other unapplied edits stay.

Follow [phase reports and user decisions](../../../docs/PHASE-HANDOFF.md) at every
phase boundary. Show the actual artifacts, review points and a copyable next
instruction before asking. Use the available question tool for missing decisions;
otherwise present the choices in chat and wait. Reuse answers already given (never a past gate approval for a new gate).
An automatic reply that the user is not available (Copilot CLI autopilot) is not
an answer: choose nothing and ask the person to continue interactively (in
auto mode, phase boundaries ask nothing; see the auto mode paragraph).
After a phase, resolve the next step from the user's instruction and current
evidence, not just a report/template's existence.

At start or resumption, follow the [ten-phase TODO tracking contract](../../../docs/PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list).
Create or reconcile the host TODO list before starting phase work; update it on
phase start, completion, approval waits, revisions, failures and resumption.
Only the parent orchestrator updates it from actual evidence. If the tool is
unavailable, show the same checklist in chat. TODO items never authorize a gate.
During an active phase, build the items from `run_migration.mjs status --fast --format todo` (ten phases, names
in the user's language; the current phase is in progress only while it runs or
is worked on, otherwise not-started with its state in the title) and put the output of
`status --fast --format checklist` at the top of every phase and failure report, so the
user always sees which phase is current even when the TODO UI does not render.

The runner selects the first incomplete phase. Existing artifacts supply evidence
for review; they do not route directly to a later phase. Respect redesign mode.

## No runnable original or no specification

At initialization, whether the original can run is the run settings' fourth
question (above); take the verification mode from the file. If the original cannot run,
the fifth question asks whether a specification or portable test suite exists, and
without one setup switches to source-as-spec before phase 00 (above). Whenever runtime
00b blocks later, ask two yes/no questions with the question tool, one per call: can the original
implementation still run here, and does a specification or portable test suite
exist? Record the first answer with `run_migration.mjs preferences --original-runtime
available|unavailable` (presentation only; failure guidance uses it to pick its
recommendation). If both answers are no, recommend [source as the only specification](../../../docs/SOURCE-AS-SPEC.md)
(`--preparation-profile source-as-spec` for a new project, `source-spec init`
then `--apply` after consent for an existing one; `--apply` also sets
`verificationMode` to `source-only` in the run settings file, so never ask the
person to edit it) and explain that equivalence stays unverified; if the original runs, recommend runtime. The user chooses.
In source-as-spec, draft 00b, 01 and 02 together from the source (no per-file
contract memo: `source-spec init` writes a source index and reviewers read cited
source lines), run one independent review of the package, show one report and record
`phase complete 00b,01,02 --note TEXT` only after the user's OK. In a project
already on source-as-spec, `source-spec init` writes its drafts without `--apply`
(only a profile switch needs the person's consent). `phase start 01` and `02`
work inside the package before 00b is recorded; check the package with
`phase check 00b,01,02`.

Status lists files a current or later phase has not written yet under "not
written yet": that is the work ahead, never a reason to stop or ask. Legacy
encodings (Shift_JIS, EUC-JP, Latin-1, UTF-16) are read decoded and named in
worker input, and binaries under a source root are left out of surveys: never
ask the person to convert the original's encoding. If decoded Japanese
looks wrong (kanji-only files), set `sourceEncoding` in migration/config.json.

## Dependency map (01)

Build the map with the bundled mapper for the source language (Python, JS/TS,
C/C++, C#, Java, VB.NET, PHP, COBOL; see [dependency mappers](../../../docs/DEPENDENCY-MAPPERS.md)).
They read source text only: never build or run the original to map it. Show
the five-file trial with its `unresolved.tsv`. For any other language, write an
adapter under `migration/tools/depmap-<language>/` by that document's rules
(static, deterministic, same output files, hand-written fixture first); never
hand-write the graph. If a bundled mapper fails or cannot read the syntax, try
its options first, then copy it (with the shared `depmap_*.py` it imports) to
`migration/tools/depmap-<language>/`, fix the copy against a hand-written
fixture, never `migration-kit/`, and report the error, the change and the
output difference in `depmap/report.md`. Read the [depmap-adapter skill](../depmap-adapter/SKILL.md) to
choose the implementation language and build the adapter.

Audit a bundled or fixture-tested mapper's graph with one fresh auditor over the
`preparation_cli.mjs dependency-targets` files and `dependency-diff`, not 2 x 20
sampled files over three rounds; list anything still unresolved in
`depmap/report.md` instead of stopping. Source-as-spec skips this audit too.

## Keep the parent's context small

In 00, read and sample the source yourself, as upstream does, and say what you
skipped; `survey run --kind facts` is optional there. In 02,
which must cover every file, do not read the whole codebase yourself on
anything but a small repository. Use [surveys](../../../docs/SURVEYS.md): `survey run --kind
inventory` sends each scope to a fresh tool-free surveyor (a new
Copilot CLI process) and saves its answer as a file; `survey merge` builds the draft you review. Check cited lines before relying
on them; merged drafts still go through the phase's audits and the human gate.
Before the inventory survey (at setup, once the run settings are confirmed), run
`preparation_cli.mjs generated-files --write` and `preparation_cli.mjs policy-questions`.
Report generated files as counts only and never ask the person to review the
list: their census sites get mechanical GENERATED rows, and each file is
translated as ordinary code unless the person names a target generator for its
input (`generated-files --regenerate FILE --how TEXT`; build approval waits until
the regenerated target exists, and `--translate FILE` switches back). Ask every
policy question in one `ask_user` call, recommending an option, and record each
answer with `policy-record --topic ID --answer TEXT` (auto mode: the conservative
option with `--topic ID --answer TEXT --auto`, without asking). Then run `rulebook-coverage --sites PATH`
and `survey run --kind inventory --sites PATH --trial 3`; decide the constructs
in `uncovered` and `trial.decide` the same way (one question, or conservative in
auto mode) before the one full survey.
Run each independent preparation audit (00b/01/02) as `audit_inputs.mjs freeze`
then `audit_inputs.mjs run --directory DIR`: a fresh tool-free Copilot CLI
worker with `--model` set to the planned phaseModels entry, recording the model
the CLI reports. Two requests on disjoint batches can run in parallel;
`audit_inputs.mjs run-pending` runs every unsubmitted request. Never hand a
request or its path to a task/agent subagent: the auditor has no tools.
In every mode an audit or independent review (00b/01/02, the source-as-spec
package review included) gets one repair round, as upstream: confirm each finding
against the source, fix the confirmed ones and re-audit only the fixed items once
with a fresh request. Never a third round: a row still contested becomes UNKNOWN
with a conservative `TODO(port)`, any other finding stays open. Report the fixed
findings, the open ones with evidence and the rows made UNKNOWN (with counts) in
the phase report; the person decides at the gate, not mid-phase (in auto mode
the same list goes into the record's note and the run continues).

## When a step fails

Follow [When a step fails](../../../docs/PHASE-HANDOFF.md#when-a-step-fails). Use the current phase's bounded
retry/survey correction and read-only diagnostics, preserving validated rows;
report that recovery without asking again. Survey rows still uncited after the
one correction finish as UNKNOWN (`uncited`): report the count, do not ask. Elapsed
time or CPU use is never a reason to stop. Ask and wait only when a rerun of the
same command fails again with no progress or a new scope/model/budget/limit or human gate needs a missing
choice. Then report cause, impact, at least two choices plus pause, one
recommended first with a reason for each. Reuse answers already given (never a past gate approval for a new gate).
Never route around a guardrail or change citation evidence by hand.
A TypeError/SyntaxError in a coordinator-owned preparation/report helper is
technical recovery: inspect the parser/caller contract, fix the helper, run
syntax/mechanical checks and resume from validated shards. Do not ask whether
to omit the review candidate, skip validation or restart survey. Use the shared
inventory-preview/inventory-merge renderer; only actual scope/rule/judge/approval
changes need their gate.


During preparation, monitor the existing terminal/job with
`run_migration.mjs status --fast --format markdown` (add `--wait 600` when
waiting). It shows recorded progress without source rehashing; use normal
status/phase checks at verification boundaries. Do not keep repeating full
status plus phase next between scopes. Never interrupt, cancel or relaunch work
solely for silence, CPU at 100% or low CPU, elapsed time (including 600 seconds),
log volume, or a host tool returning a running session. Keep the same job and
wait/poll it. Normal execution is continuous, including legacy configurations;
never add a finite timeout or call/round budget without the person's choice.
Respect explicit user cancellation and actual input/permission failures.
`status --wait 600` returning is only the end of that status wait, not the job.
A phase recorded earlier can go out of date when a file it recorded changes
(a pilot or repair fix, a kit update). `status --fast` does not revalidate;
`phase next` does and then returns `stale` with what changed, `action`
(`record-again` when only files the phase recorded, an earlier record or the
kit changed: check that change and record again; `redo` when sources, settings
or verification inputs changed) and the
exact `phase complete` command. Follow `stale.next`: in auto mode record again
(or redo) without asking; otherwise ask once, recommending it and naming the
changed files. Never ask why `status --fast` and `phase next` differ.

## Ordered workflow entry

Before routing a configured project, run `run_migration.mjs phase init`, then
`phase next`. Follow [ordered workflow](../../../docs/ORDERED-WORKFLOW.md).
Run only the first incomplete phase; use `phase start ID` before work. For 03,
work through and show the [one-page checklist](../../../docs/STRESS-TEST-CHECKLIST.md). Phases
03/04 need `migration/guardrails.json`, the human's decision: propose the list from
`guardrails show` adapted to this target's build/test commands (or a waiver with its
reason), and after their agreement in chat run `guardrails install` with exactly
those options. Never write the file any other way (the hook denies it). Outside
auto mode the host asks the person to confirm every `approve` / `phase complete` /
`phase waive` / `build-loop` / `pilot prepare` / `source-spec init --apply` /
`guardrails install` command; if it cannot ask (autopilot denies the request),
tell the person to leave autopilot and retry instead of working around it. In
auto mode these run unasked (see the auto mode paragraph below) only as one
command per call, run from the target repository: no `cd`, pipe or other
command with it, and a `--note` in single quotes when it contains `$` or
backticks; anything else still asks, and autopilot then stops. Outside auto mode, run gate commands only in an
interactive session without autopilot, which denies them. The Copilot CLI may show
its own permission prompt after the hook's question, so the person can be asked
twice. An explicit
request for a later phase does not waive missing earlier reviews (only the person's
answer to a relaxed-mode question does, below). Do not route
from file existence. After user review, record early phases with `phase complete
ID --note TEXT`; runner receipts determine implementation and validation phases.
Keep all ten phases visible. Source-only 05c needs an explicit unverified-mode
acknowledgment before handoff.

In relaxed mode (`preferences` shows `phaseMode: relaxed`) a gate failure ends
with `Relaxed mode: ... phase waive ID`. Never proceed on your own: report what
is missing and ask with the question tool, offering the failure guidance's
choices (fixing first is recommended; proceeding without finishing ID is one
choice). Only when the person picks proceed, run `phase waive ID --note
"<their reason>"` (the host asks them to confirm), then retry the same command.
Never waive for them, never waive phases ahead of the one that blocked, and
never take an automatic reply as the answer. A waived phase stays unfinished:
`status` lists it under `waivers` and marks it 【見送り】 / [waived]; finishing
it later lifts the waiver, and records made on it are checked again. List every
remaining waiver in each phase report and in the final handoff report. Safety
checks (guardrails, protected paths, source overwrite, sign-in, the host's
confirmation of each gate command) are never waived. In normal mode the failure
guidance also offers switching to relaxed mode; it is never the recommendation.
In auto mode (`phaseMode: auto`, for Copilot CLI autopilot) the person chose
beforehand to let the gates run unasked. At each phase boundary, publish the
phase report as usual but ask no question: do the phase's work, record it
(`phase complete`, `approve`, `build-loop`; the hook does not ask) and continue
with the next phase. A gate failure ending `Relaxed mode (auto): ...` means: if
the phase's own work can supply what is missing, do that work; only otherwise
run `phase waive ID --note "<why>"` and retry. Never waive phases ahead of the
one that blocked. Questions inside a phase are not asked either: an audit or
independent review that returns `changes` gets one round (confirm each finding
against the source, fix the confirmed ones, re-audit only the fixed items once
with a fresh request).
Findings still open after that round, reviews limited by `maxReviewInputBytes`,
and UNKNOWN or uncited rows are not fixed again: list them in the phase report
and in the `phase complete` (or waiver) note, then continue. A choice neither the
source nor the RULEBOOK decides (for example the target web framework, or where
non-source assets go) takes the most conservative option, the one closest to the
original structure that adds no framework or dependency, unless the person
already stated one. Before the inventory survey runs, write it into the RULEBOOK
with a greppable `TODO(port)` naming the open choice. After that, leave the
RULEBOOK unchanged (it is part of every inventory survey input and of
contextHash, so an edit would force a full re-survey and make the recorded
phases stale) and put the conservative representation with `TODO(port)` into the
translated output (upstream rule 8). List each as decided without the person. Missing guardrails are installed from the template
automatically. Everything else still stops: safety checks, sign-in and credits,
unfilled run settings, and the commands the hook still asks about (sessions
prune, switching auto mode on, guardrails install with options or over an
existing file, kit calls it cannot read, and any gate chained with another
command); report them and stop. `models set`, `settings apply`, `pilot
prepare` and `source-spec init --apply` run unasked as commands of their own. If phase 00 finds that a setup answer was wrong (the original does
not run after all, or a specification turns up), say which answer and why, and
ask the person to leave autopilot and decide in chat; never switch the profile
yourself. Never switch auto mode on yourself, neither with `preferences --phase-mode
auto` nor by writing `phaseMode: "auto"` into run-settings.json or
preferences.json: it is the person's act (the hook asks for the command, and a
hand edit is not in effect). Every report and the handoff list the
records made without the person (`status` `autoMode.records`, marked
【自動・人の確認なし】 / [auto, not reviewed by the person]) and the waivers. See
[auto mode](../../../docs/ORDERED-WORKFLOW.md#auto-mode).
 Record known host usage with completion;
[main-format cost logs](../../../docs/COST-LOG.md) use unknown where unavailable.
When the person asks how much AI the kit used, and in the handoff, report
`usage --format markdown`: the tokens and AI units of every worker call since
0.22.0, by role and model. Relay its "not included" list: the person's own chat
with you (`/usage` in that Copilot CLI session shows it) and other roots such as
pilots. The charge itself is on GitHub billing.

## Worker execution

Workers are isolated Copilot CLI processes started by the Node runner: `--model`
fixes each worker's model, tools are restricted and implicit instructions are
excluded (verified on a real CLI). In VS Code the parent runs the runner in the
integrated terminal. A configuration from the removed VS Code subagent backend
stops with migration instructions: show them, and after the person's OK set
`"workerBackend": "copilot-cli"`, remove the listed keys and redo judge and the
translation approval.

At initialization also offer these settings as the user's choice. `fixPolicy`:
`single-pass` (new installs, as upstream Step 3: one fix of the confirmed
findings, then build/smoke/parity judge it; fewer calls and fewer blocked units)
or `rereview` (a fixed output is reviewed again until no confirmed finding
remains; also what an older configuration without the key gets).
`dependencyOrder: auto` (new installs) lets the approved scope fan out like
upstream and holds dependents for reviewed dependencies only when a per-unit
typecheck needs them. `concurrency` (up to 64, both reviewers included; 1 for new
installs) should stay within what the computer and the account's rate limits
keep up with; raise it only after runs at the current value pass without CLI
stalls. `reviewFocus`: `shared` (new installs; both
reviewers check semantics and rules, each from its own lens first) or
`specialized` (one check each, upstream's split). Changing `fixPolicy`,
`dependencyOrder` or `reviewFocus` revokes approvals. Run limits (`concurrency`,
`maxAgentCalls`, `maxFixRounds`, timeouts, retry settings, `maxRunInputBytes`,
`maxAiCreditsPerCall`) can change between runs and keep reviewed work and approvals.

Long runner commands (`translate`, `repair`, `repair-round`, `build-loop`,
`pilot run`, `survey run`) all run the same way. Start the command alone in a
background or continuing terminal, calling the runner by its path, with no pipe
or redirection to a file (`| Out-String`, `| Select-Object`, `| tee`, `> log`;
`2>&1` is fine): they hide its progress until it ends, and the hook denies them.
While it runs the terminal shows a heartbeat every 15 seconds and one line per
unit change (`14:03:45 [3/12] src/a.cs: review (agent calls 14)`: time,
finished/total of this run, unit, stage, AI calls so far). Check it with
`status --root ROOT --wait 600 --format markdown` (ROOT is the pilot directory
for `pilot run`): the runner itself waits up to that many seconds and answers as
soon as a unit finishes or the run stops, so each check costs one model turn,
not one per poll. After each check, tell the person in chat the finished count,
the active units and any retry or blocked unit. Never block the parent on the
run or kill it for being slow. When status shows a worker retrying after a transient failure
(rate limit, service error), tell the user at once: the runner waits and retries
by itself; if it persists, offer a lower `concurrency` (down to 1) after the
run (it keeps reviewed work). A run that stops at its AI call budget is a budget stop: rerun
`translate`, or propose `translate --max-calls N` with the number the person agrees.

After a failed build, propose `build-loop --note TEXT [--through build|smoke|parity]
[--max-rounds N] [--max-calls N]` (defaults: build only, continuous until clean;
state the stages and absence of an implicit round/call deadline): one host-confirmed
grant that rebuilds (then runs smoke and parity with `--through`), parses errors
into the repair queue and runs reviewed repairs until clean. Only limits explicitly
chosen by the person, or executionMode bounded, impose a round/call budget;
the stalled-count breaker applies only in bounded mode. Offer `--through parity` when the person wants upstream's
run-until-parity loop instead of approving every rerun. While it runs, other runner commands are refused; check `status --wait`.
Show the round counts and calls used.

After a failed smoke or parity (upstream Step 6), triage every divergence against
the original first: regression, inherited, environment or comparator defect.
For regressions run `repair-round --stage smoke|parity`: output lines that name
translated files become the reviewed repair queue; when none do, write the
confirmed regressions as `file<TAB>module<TAB>code<TAB>message` rows and run
`diagnostic_queue.mjs --stage parity --diagnostics migration/PATH.tsv`, then
`repair --queue`. The person then approves build, smoke and parity again. A
failing original suite is never repaired in translated outputs.

Workers are Copilot CLI sessions (account sync follows the user's CLI setting) whose
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

Read [source-only verification](../../../docs/SOURCE-ONLY.md) for explicit source-only
setup and smoke-to-handoff routing. Read [built-in Rubber Duck](../../../docs/RUBBER-DUCK.md)
for milestone advisory review and adopted fix/reverification records.
Use status --format markdown even before a manifest exists. Artifact candidates
are not phase approval or validated completion.

In source-only mode, after reviewed successful smoke mark 05c unverified and
prepare/review 06 handoff; use approve handoff then handoff. Do not approve or
execute parity or post-parity. Runtime projects keep those existing gates.
