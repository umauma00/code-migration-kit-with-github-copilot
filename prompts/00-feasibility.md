# 00 — Migration feasibility

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Work read-only on the source. Produce `migration/feasibility.md`, then stop.
Read the operating manual before proposing a migration. Resolve verificationMode
first: runtime (default) requires the original executable environment; explicitly
chosen source-only prepares source-derived contracts and unknowns without it,
then reviews implementation and target build/smoke before an unverified-parity
handoff. See [source-only requirements](../docs/SOURCE-ONLY.md).

1. Identify the product reason to leave, alternatives, and the cost of doing
   nothing. “Do not migrate” is a valid recommendation.
2. Commit to structure-preserving translation or redesign; list the architectural
   assumptions. The automated runner currently handles one source file to one
   target file in preserve mode. A redesign needs an explicit module adapter.
3. Inventory public entry points, data formats, dependencies, generated code and
   platform-specific behavior. Count units with scripts rather than guesses.
4. Assess the judge: do existing tests survive the source language's removal?
   In runtime mode, tests that import private source internals need a portable
   parity harness. Source-only records inferred scenarios and unverified behavior.
5. Measure available build/test costs and decide whether a cheap typecheck belongs inside
   each unit loop. Keep expensive builds owned by the coordinator.
6. Check Node >=22, required target toolchain, account model availability and
   organization policy. Runtime also requires the source toolchain; source-only
   records its absence as an equivalence limitation, not an implementation blocker.
   CLI backends check compatible flags with `doctor --check-cli`; native backends
   use `doctor` and verify host capability/model isolation in the disposable pilot.
   This check does not authenticate or make a model call.
7. Choose explicit model IDs per worker role in config. Estimate work as units ×
   measured per-unit calls, tokens/credits and time. Keep unknowns explicit.
   Also plan explicit phaseModels for rulebook, judge/dependency/inventory/design
   audits and stress A/B/inspector as applicable. The parent selects these via
   real host APIs; requested values are not observed execution models. Missing
   availability/metadata remains unknown, without implicit fallback. See
   [preparation audits](../docs/PREPARATION-AUDITS.md).
8. Identify unsupported parser features or languages; JS/TS aliases and C macro
   dependencies require more than the bundled starter scanners.

Report verdict, risks, verification cost, model plan, and proposed phase gates.
Do not install policies, start translation, or approve the next phase yourself.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

Report every issue with ID, severity, source/target evidence, impact, proposed
fix, owner (AI/user/environment), completion criterion, and whether it blocks
implementation. Identify checks that can be deferred. Perform authorized AI fixes
and group only necessary user decisions. 00 assesses suitability/scope; 00b
prepares comparison evidence; 03 prototypes; 04 begins production implementation.

## Delegate the reading

Do not read the whole codebase into this conversation. Run
`run_migration.mjs survey run --kind facts` (fresh tool-free surveyors per scope,
results as files), then `survey merge --kind facts`, and build the report from
`migration/surveys/facts.md`, checking the cited lines you rely on. Small
repositories may be read directly. See [surveys](../docs/SURVEYS.md).
