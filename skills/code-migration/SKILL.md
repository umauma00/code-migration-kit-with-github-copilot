---
name: code-migration
description: Run a staged, behavior-preserving language migration with GitHub Copilot. Use for whole-codebase language ports, migration feasibility, translation rules, dependency maps, parity verification, or resuming a migration. Not for ordinary refactors or incremental JavaScript-to-TypeScript adoption.
---

# Code migration

Read the [operating manual](../../docs/OPERATING-MANUAL.md) and [usage](../../README.md).
Resolve the plugin root from this SKILL.md location: it is two directories above
this file. Follow the [runner](../../scripts/run_migration.mjs) and
[installer](../../scripts/install.mjs) links to obtain their absolute paths.
Run every command with the migration target repository as cwd. Never assume the
plugin lives in that repository or that `${PLUGIN_ROOT}` expands in Markdown.
In the shared prompts/manual, replace `migration-kit/` in executable paths with
the resolved absolute plugin root; keep all project-relative inputs and outputs.

If migration/config.json is missing, ask for the user's available model ID and
migration languages, then preview:
`node "<absolute-plugin-root>/scripts/install.mjs" --target . --layout plugin --model MODEL_ID`.
Apply with `--apply` once project initialization is authorized, and configure
languages, source/output/test roots and validation commands. Initialization
creates only migration/config.json, RULEBOOK.md and inventory.tsv; it does not
approve or run migration stages. An existing configuration with runtime other
than plugin requires an explicit layout change rather than a silent overwrite.
For initialized projects, require `"runtime": "plugin"` in migration/config.json.
Use the plugin's code-migration-plugin-orchestrator agent for phase planning.
The Node runner selects private plugin worker profiles and explicitly mounts
this plugin for each CLI worker.

Follow [phase reports and user decisions](../../docs/PHASE-HANDOFF.md) at every
phase boundary. Show the actual artifacts, review points and a copyable next
instruction before asking. Use the available question tool for missing decisions;
otherwise present the choices in chat and wait. Reuse answers already given.
After a phase, resolve the next step from the user's instruction and current
evidence, not just a report/template's existence.

- No feasibility report: run [feasibility](../../prompts/00-feasibility.md), report, stop.
- No judge preparation: run [judge setup](../../prompts/00b-judge-setup.md), save
  migration/judge-report.md, report, stop. The formal judge receipt comes after
  the manifest/rulebook/inventory are ready; its absence alone does not repeat 00b.
- No map/rules: run [dependency map](../../prompts/01-dependency-map.md), then
  [gap inventory](../../prompts/02-gap-inventory.md), stopping at each gate.
- Rules and inventory reviewed: run judge validation when its artifacts are ready,
  then [stress test](../../prompts/03-stress-test.md). Respect redesign mode.
- Translation approved: run [translation](../../prompts/04-translation-kickoff.md).
- Translation complete: run [build](../../prompts/05-survey-build.md), then
  [smoke](../../prompts/05b-smoke.md), then [parity](../../prompts/05c-parity.md), one gate at a time.
- Parity approved: run [post-parity](../../prompts/06-post-parity.md).

Use `run_migration.mjs status` for progress. Never silently install policies,
change models, approve a stage, increase limits, weaken tests, or declare partial
outputs complete. The user's explicit instruction can authorize a concrete gate.
