---
name: code-migration
description: Run a staged, behavior-preserving language migration with GitHub Copilot. Use for whole-codebase language ports, migration feasibility, translation rules, dependency maps, parity verification, or resuming a migration. Not for ordinary refactors or incremental JavaScript-to-TypeScript adoption.
---

# Code migration

Read the [operating manual](../../../docs/OPERATING-MANUAL.md) and [usage](../../../README.md).
Locate the installed kit at `migration-kit/`; when maintaining the kit itself,
its scripts and prompts are at repository root.

- No feasibility report: run [feasibility](../../../prompts/00-feasibility.md), report, stop.
- No validated judge: run [judge setup](../../../prompts/00b-judge-setup.md), report, stop.
- No map/rules: run [dependency map](../../../prompts/01-dependency-map.md), then
  [gap inventory](../../../prompts/02-gap-inventory.md), stopping at each gate.
- Rules drafted: run [stress test](../../../prompts/03-stress-test.md). Respect redesign mode.
- Translation approved: run [translation](../../../prompts/04-translation-kickoff.md).
- Translation complete: run [build](../../../prompts/05-survey-build.md), then
  [smoke](../../../prompts/05b-smoke.md), then [parity](../../../prompts/05c-parity.md), one gate at a time.
- Parity approved: run [post-parity](../../../prompts/06-post-parity.md).

Use `run_migration.mjs status` for progress. Never silently install policies,
change models, approve a stage, increase limits, weaken tests, or declare partial
outputs complete. The user's explicit instruction can authorize a concrete gate.
