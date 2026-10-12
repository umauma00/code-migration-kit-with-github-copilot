# 00 — Migration feasibility

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Work read-only on the source. Produce `migration/feasibility.md`, then stop.
Read the operating manual before proposing a migration.

1. Identify the product reason to leave, alternatives, and the cost of doing
   nothing. “Do not migrate” is a valid recommendation.
2. Commit to structure-preserving translation or redesign; list the architectural
   assumptions. The automated runner currently handles one source file to one
   target file in preserve mode. A redesign needs an explicit module adapter.
3. Inventory public entry points, data formats, dependencies, generated code and
   platform-specific behavior. Count units with scripts rather than guesses.
4. Assess the judge: do existing tests survive the source language's removal?
   Tests that import private source internals need a portable parity harness.
5. Measure build/test prices and decide whether a cheap typecheck belongs inside
   each unit loop. Keep expensive builds owned by the coordinator.
6. Check Copilot CLI 1.0.93-compatible flags, Node >=22, source/target toolchains,
   account model availability and organization policy. Use `doctor --check-cli`.
   This check does not authenticate or make a model call.
7. Choose explicit model IDs per worker role in config. Estimate work as units ×
   measured per-unit calls, tokens/credits and time. Keep unknowns explicit.
8. Identify unsupported parser features or languages; JS/TS aliases and C macro
   dependencies require more than the bundled starter scanners.

Report verdict, risks, verification cost, model plan, and proposed phase gates.
Do not install policies, start translation, or approve the next phase yourself.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
