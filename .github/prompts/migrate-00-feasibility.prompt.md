---
name: migrate-00-feasibility
description: Run only migration phase 00-feasibility
agent: agent
---

Read [the phase instructions](../../prompts/00-feasibility.md) and carry out only that phase.
Stop at its documented gate. Use the installed runner for translation and validation.

The user-facing parent retains phase/TODO/question ownership. Read
[phase handoff](../../docs/PHASE-HANDOFF.md) and reconcile ten phases before
long work. A planning subagent returns advice to this parent.

Before phase work, run `run_migration.mjs phase init` and `phase start 00` from the target repository using the installed runner path. If prerequisites fail, show the first incomplete phase and resolve it; do not bypass the check. Read [ordered workflow](../../docs/ORDERED-WORKFLOW.md).
