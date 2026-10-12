---
name: code-migration
description: Run a staged, behavior-preserving language migration with GitHub Copilot. Use for whole-codebase language ports, migration feasibility, translation rules, dependency maps, parity verification, or resuming a migration. Not for ordinary refactors or incremental JavaScript-to-TypeScript adoption.
---

# Code migration

Read the [operating manual](../docs/OPERATING-MANUAL.md) and [usage](../README.md).
Locate the installed kit at `migration-kit/`; when maintaining the kit itself,
its scripts and prompts are at repository root.

- No feasibility report: run [feasibility](../prompts/00-feasibility.md), report, stop.
- No validated judge: run [judge setup](../prompts/00b-judge-setup.md), report, stop.
- No map/rules: run [dependency map](../prompts/01-dependency-map.md), then
  [gap inventory](../prompts/02-gap-inventory.md), stopping at each gate.
- Rules drafted: run [stress test](../prompts/03-stress-test.md). Respect redesign mode.
- Translation approved: run [translation](../prompts/04-translation-kickoff.md).
- Translation complete: run [build](../prompts/05-survey-build.md), then
  [smoke](../prompts/05b-smoke.md), then [parity](../prompts/05c-parity.md), one gate at a time.
- Parity approved: run [post-parity](../prompts/06-post-parity.md).

## Worker execution backend

For a new VS Code migration, initialize with `--worker-backend native` and
`--native-harness copilot` for Copilot sessions, or `--harness vscode-local`
for Local (repository-copy installation). For Copilot CLI, keep the default
`copilot-cli` backend. Reuse the user's specified execution preference.
Preserve existing config; changing backend requires fresh judge validation and
translation approval, not a silent switch during a run.

When config.workerBackend is native, follow [native workers](../docs/NATIVE-WORKERS.md).
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

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
