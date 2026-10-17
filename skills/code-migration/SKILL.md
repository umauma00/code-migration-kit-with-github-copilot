---
name: code-migration
description: Run a staged, behavior-preserving language migration with GitHub Copilot. Use for whole-codebase language ports, migration feasibility, translation rules, dependency maps, parity verification, or resuming a migration. Not for ordinary refactors or incremental JavaScript-to-TypeScript adoption.
---

# Code migration

For config.executionPurpose `pilot`, follow [pilot execution](../../docs/PILOT.md)
using pilot run and the sealed grant; do not initialize production phase records
or manufacture a phase-03 result. Otherwise follow the production sequence below.
Read [preparation audits](../../docs/PREPARATION-AUDITS.md) for 00b/01/02 and
[execution scopes](../../docs/EXECUTION-SCOPES.md) for approved batches/repair queues.

Read the [operating manual](../../docs/OPERATING-MANUAL.md) and [usage](../../README.md).
Resolve the plugin root from this SKILL.md location: it is two directories above
this file. Follow the [runner](../../scripts/run_migration.mjs) and
[installer](../../scripts/install.mjs) links to obtain their absolute paths.
Run every command with the migration target repository as cwd. Never assume the
plugin lives in that repository or that `${PLUGIN_ROOT}` expands in Markdown.
In the shared prompts/manual, replace `migration-kit/` in executable paths with
the resolved absolute plugin root; keep all project-relative inputs and outputs.

If migration/config.json is missing, ask for the user's available model ID and
migration languages, then choose the initialization command for the current host
(reuse any explicit execution preference):

- VS Code Copilot: `node "<absolute-plugin-root>/scripts/install.mjs" --target . --layout plugin --worker-backend native --native-harness copilot --model MODEL_ID`.
- Copilot CLI: `node "<absolute-plugin-root>/scripts/install.mjs" --target . --layout plugin --worker-backend copilot-cli --model MODEL_ID`.

VS Code Local requires the repository-copy layout described in
[native workers](../../docs/NATIVE-WORKERS.md), not this plugin initialization.
Apply with `--apply` once project initialization is authorized, and configure
languages, source/output/test roots and validation commands. Initialization
creates only migration/config.json, RULEBOOK.md and inventory.tsv; it does not
approve or run migration stages. An existing configuration with runtime other
than plugin requires an explicit layout change rather than a silent overwrite.
For initialized projects, require `"runtime": "plugin"` in migration/config.json.
Use the plugin's code-migration-plugin-orchestrator agent for phase planning.
For the CLI backend, the Node runner selects private plugin worker profiles and
explicitly mounts this plugin. For native, use the dedicated native profiles
already loaded in the host session, following the backend instructions below.

Follow [phase reports and user decisions](../../docs/PHASE-HANDOFF.md) at every
phase boundary. Show the actual artifacts, review points and a copyable next
instruction before asking. Use the available question tool for missing decisions;
otherwise present the choices in chat and wait. Reuse answers already given.
After a phase, resolve the next step from the user's instruction and current
evidence, not just a report/template's existence.

At start or resumption, follow the [ten-phase TODO tracking contract](../../docs/PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list).
Create or reconcile the host TODO list before starting phase work; update it on
phase start, completion, approval waits, revisions, failures and resumption.
Only the parent orchestrator updates it from actual evidence. If the tool is
unavailable, show the same checklist in chat. TODO items never authorize a gate.

The runner selects the first incomplete phase. Existing artifacts supply evidence
for review; they do not route directly to a later phase. Respect redesign mode.

## Ordered workflow entry

Before routing a configured project, run `run_migration.mjs phase init`, then
`phase next`. Follow [ordered workflow](../../docs/ORDERED-WORKFLOW.md).
Run only the first incomplete phase; use `phase start ID` before work. Phases
03/04 need human-installed `migration/guardrails.json`; ask the human, never create it. An explicit
request for a later phase does not waive missing earlier reviews. Do not route
from file existence. After user review, record early phases with `phase complete
ID --note TEXT`; runner receipts determine implementation and validation phases.
Keep all ten phases visible. Source-only 05c needs an explicit unverified-mode
acknowledgment before handoff. Record known host usage with completion;
[main-format cost logs](../../docs/COST-LOG.md) use unknown where unavailable.

## Worker execution backend

For a new VS Code migration, initialize with `--worker-backend native` and
`--native-harness copilot` for Copilot sessions, or `--harness vscode-local`
for Local (repository-copy installation). For Copilot CLI, keep the default
`copilot-cli` backend. Reuse the user's specified execution preference.
Preserve existing config; changing backend requires fresh judge validation and
translation approval, not a silent switch during a run.

When config.workerBackend is native, follow [native workers](../../docs/NATIVE-WORKERS.md).
Keep the runner active in a continuing terminal, claim pending jobs, delegate
the exact prompt to the named tool-free host subagent with the requested model,
and submit unchanged results. Dispatch independent jobs in parallel within the
configured and host limits. The parent must service jobs while the runner waits.
Do not inherit the parent conversation or add other reviewers' results.
If the required model/profile/tools cannot be selected, report a failed job;
never substitute the parent agent, edit the target, or fall back to CLI.
Select the model through the host's actual per-call model parameter, not prompt
text. Before submitting, check host execution metadata for the model used;
if absent, different, or ambiguous, fail the job. Do not echo the requested
model or ask the worker to identify itself as proof of execution.
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

Read [source-only verification](../../docs/SOURCE-ONLY.md) for explicit source-only
setup and smoke-to-handoff routing. Read [built-in Rubber Duck](../../docs/RUBBER-DUCK.md)
for milestone advisory review and adopted fix/reverification records.
Use status --format markdown even before a manifest exists. Artifact candidates
are not phase approval or validated completion.

In source-only mode, after reviewed successful smoke mark 05c unverified and
prepare/review 06 handoff; use approve handoff then handoff. Do not approve or
execute parity or post-parity. Runtime projects keep those existing gates.
