---
name: migrate-03-stress-test
description: Run only migration phase 03-stress-test
agent: agent
---

Read [the phase instructions](../../prompts/03-stress-test.md) and carry out only that phase.
Stop at its documented gate. Use the installed runner for translation and validation.

The user-facing parent retains phase/TODO/question ownership. Read
[phase handoff](../../docs/PHASE-HANDOFF.md) and reconcile ten phases before
long work. A planning subagent returns advice to this parent.

Before phase work, run `run_migration.mjs phase init` and `phase start 03` from the target repository using the installed runner path. If prerequisites fail, show the first incomplete phase and resolve it; do not bypass the check. Read [ordered workflow](../../docs/ORDERED-WORKFLOW.md).
