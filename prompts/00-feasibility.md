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
   Workers always run on the Copilot CLI, also from VS Code: check it with
   `doctor --check-cli` (install it or start `copilot login` only after the
   person agrees). This check does not authenticate or make a model call.
7. Choose explicit model IDs per worker role in config. Estimate work as a visible
   multiplication — units × per-unit calls × referee price — in bands only (see
   the report contract below), or the word unknown. Keep unknowns explicit.
   Also plan explicit phaseModels for rulebook, judge/dependency/inventory/design
   audits and stress A/B/inspector as applicable. The parent selects these via
   real host APIs; requested values are not observed execution models. Missing
   availability/metadata remains unknown, without implicit fallback. See
   [preparation audits](../docs/PREPARATION-AUDITS.md).
8. Identify unsupported parser features or languages; JS/TS aliases and C macro
   dependencies require more than the bundled starter scanners.

Report verdict, risks, verification cost, model plan, and proposed phase gates.
Do not install policies, start translation, or approve the next phase yourself.

## Report contract (restored from upstream)

- Open the report by restating the six steps, one line each. Beyond that index the
  README is your rubric, not your evidence: cite it only to name the step you are
  applying, and its case-study numbers are not estimates for this repository.
- Every claim gets a file path or a count you actually gathered; everything else is
  labeled an assumption. Too big to read fully? Sample, and say what you skipped.
  Read-only commands only, no test runs, and at most one build (plus the typecheck
  if it is a separate command) to time the baseline.
- Start with the case for leaving: pain instances in this code, not the language's
  reputation.
- Make three calls, each ending in one committed line naming the files that forced
  it — a call without file paths is no call:
  1. **Structure-preserving or redesign?**
  2. **What does verification cost?** Time the current build and typecheck as the
     baseline and state the scaling assumption behind the target estimate.
  3. **Do the tests survive?** Count the tests that hit the public surface versus
     those that import internals, with three examples of each. If too little
     survives to judge parity, the verdict names "build the judge first"
     (00b, before Step 1) and sketches the parity scenarios to check.
- Instantiate the six steps for this repository: paths, units of work and which
  prompt runs each step. Where a step needs analysis you cannot do read-only, the
  filled-in prompt is the answer, not a guess.
- **Cost & duration:** a banded, order-of-magnitude token estimate — bands only; a
  precise number is forbidden. Show the drivers: file count × review topology
  (implementer, two reviewers, arbiter when disputed, fixer per unit) × referee
  price. Then per step, estimated wall-clock and active-attention minutes.
- **Model plan:** a recommended tier per phase with one line of reasoning each;
  the human decides it at this gate.
- End with a verdict — migrate now, later, or don't — plus the single fact that
  would change it, one this repository cannot tell you, and how you would check it
  in under a day. Close with what you read and what you ran. Record measured usage
  only, as described in [cost logs](../docs/COST-LOG.md).

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

## Reading the source

As upstream: read the source yourself with read-only commands (counts, grep, git
log) and sample what is too big to read fully. Name what you sampled and what you
skipped; a verdict does not need every file. `survey run --kind facts` is optional
here: use it only when the person asks for it or sampling cannot support a
committed call (see [surveys](../docs/SURVEYS.md)). It starts one Copilot CLI
process per scope, so a failure to start it never blocks this report.

## Credentials in the source

The kit runs no secret scan, and neither 00 nor the survey adds one as a gate:
do not invent a check that stops this phase. A command switch alone is not a
credential: `set /P`, `xcopy /P`, `del /P`, `-p` with nothing after it are
options. Only a value written right after a password switch (for example
`schtasks /U user /P value` or `sqlcmd -P value`) or a key/token assigned in
code is a candidate.

Once a line looks like a real candidate, stop reading it: anything you read is
in your context, so skipping the survey alone protects nothing. Keep only its
file and line number; do not print, quote or survey the line, and record that
part as unverified in the report — never the value. Finish the report; the
person checks the line and moves a real value out of the source, not you. If a
tool you ran flagged one, describe the finding without its text, for example
`run_migration.mjs guidance --message "credential candidate at src/run.bat line 5"`;
never paste the tool's raw output into a command line. Guidance withholds a
candidate message and masks an assigned value, but it cannot unread what
reached your context.
