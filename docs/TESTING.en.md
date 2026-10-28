# Verification records (2026-10-08 JST)

[日本語](TESTING.md) | English

## 2026-10-27 Fixes from the 0.6.0 review (0.6.1)

- `npm test`: 452 tests, 450 passed, 0 failed, 2 skipped (Windows only). `npm run demo` passed: 12 comparisons, 0 differences, 0 skipped. `git diff --check` passed.
- `tests/review-2026-10-27.test.mjs` (12 tests) checks that continuous mode names configured limits it does not enforce (doctor and run summaries; no stop), that a build-loop whose error count stops falling records `stalled` and keeps going, that an explicit `--max-rounds` still applies, that spilled logs (including failed and cancelled workers' records) are recorded relative to the root and read after the checkout moves (0.6.0 absolute records still read, also through a symlinked root), that evidence with host:port or numbers is accepted while a foreign source citation (also with another extension) is rejected, that a file with no census sites is split, that `#error don't` cannot expose a commented-out C include, and that a regex literal after `}` keeps later imports.
- No stop based on time, CPU, silence or output volume was added. The stop-candidate index was regenerated: 70 files, 801 lines, matching the code.
- The 0.6.0 records (continuous execution, large surveys, legacy C# corpus) are in the [Japanese record](TESTING.md).

## 2026-10-25 Benchmark for folding workers

- `tests/review-benchmark.test.mjs`: with canned workers, checks the miss-rate, false-finding and fix pass-rate totals, the list of changed cases, refusal below the call bound, the stop when three calls fail before any works, refusal of output inside the root (also through a symlink), and that setup leaves no correct fixture code in the root, and that seeded cases fail their checks while controls pass.
- Also checks the one-run default and repeated-run plans; main's quote styles, syntax and actual input/output; generated-code timeouts versus call failures; invalid arbitration references; failed-call token usage and unknown totals; and the model-call concurrency cap including both reviewers.
- All three checks require a final PORT STATUS comment, reject headers and strings (including multiline strings), allow trailing blank lines and CRLF, and reflect that rule in fix pass rates.
- No comparison with real models has run yet. See [REVIEW-BENCHMARK.en.md](REVIEW-BENCHMARK.en.md).

## 2026-10-17 CLI version tracking, guardrails, tool-assisted review, diagnostics, language

- macOS (Darwin arm64) / Node v26.11.1, `npm test`: 188 of 189 passed, 0 failed, 1 skipped (case-sensitive filesystem only).
- `verify_cli_transport.mjs` on the real CLI (1.0.95 and 1.0.98) with a loopback test provider: 3 units, 9 calls, instruction isolation OK. The plugin layout also translated and reviewed successfully.
- Reproduced that with `--no-auto-update`, a native-installer CLI starts its bundled 1.0.40, which cannot load the plugin's workers. Removing the flag fixed it, and the new `doctor` reports the missing worker IDs on 1.0.40.
- On real CLI 1.0.98, the guardrail hook denied `git reset --hard` in a trusted repository-copy folder and with the plugin layout. In an untrusted folder repository hooks are not loaded, and `doctor` reports it.
- On real CLI 1.0.98, in both layouts, only the oversized unit's reviews ran on the `-read` profiles with read tools and the file-list input.
- Diagnostic parsers: Python, Node, bash and clang samples captured from the real tools; javac, Maven, ShellCheck, tsc, ESLint, pyright, mypy and rustc samples follow their documented formats.
- An authenticated real model, the VS Code UI and large migrations are not verified.

## 2026-10-15 reviews 1 and 2

- `npm test` on Linux with Node v24.19.0 / Python 3.12.14: 170/170 passed; 0 failed, skipped or cancelled.
- `npm run demo`: translated 3 units with fixed worker responses; real Node/Python build, smoke and 12-case parity passed.
- The first 19 added tests cover plugin/copy links, the strict pre-03 pilot, limited grants, revocation, interruption and resumption, source-only, early judge reuse, batch boundaries, measured TODO counts, independent/dependent repair under one lock, inventory merge, dependency diff/package cycles, separation of audit tasks/inputs/models, frozen design bodies and the strict live setup path.
- 7 tests added for the Astra findings cover Stop while waiting on dependencies, partly complete, before a worker and during the final check; saving every repair intent and rejecting old done; journal tampering; collisions and aliases between fixed receipts and protected inputs; and the actual arguments of the published CLI. Diagnostics of every job reach the independent double review after resumption, and build approval cannot proceed with any left unprocessed.
- Authenticated Copilot AI, the real VS Code UI, model metadata, completion-order dispatch, child cancel, large migrations and running a redesign module runner were not done. Fixture reviews and approval records are not counted as real AI quality or human approvals.

See [the change table and remaining implementation](plans/2026-10-15-review-implementation.md). The records below are older.

The VS Code native backend was removed in 0.3.0; the native records below are history.

In the 2026-10-12 pre-commit re-verification, a race where a native client read an empty run lock during startup was found. A deterministic reproduction test was added and the lock is now published atomically; afterwards 112 of 113 passed, 0 failed, 1 skipped.

After the 2026-10-12 review triage and fixes: 111 of 112 passed, 0 failed, 1 skipped. Of the 3 added tests, the 2 for corrupted past tasks and native plugin name collisions failed before the fix and passed after it; the control that still rejects corruption of a current task also passed. See [triage of the four native review findings](reviews/2026-10-12-native-worker-review-fixes.md) for the reasoning and fixes.

At the initial native implementation the same day: 108 of 109 passed, 0 failed, 1 skipped (a case for case-sensitive filesystems only). After final adjustments to the native prompts, the 12 added tests were re-run and all passed. The existing offline demo completed 3 files, build/smoke passed, and original/parity had 12 cases each with 0 differences. Worker responses are prepared data; no real model was used.

For 0.1.5's 2026-10-10 verification see [fixes for the three re-review findings](reviews/2026-10-10-copilot-rereview-fixes.md), and for 0.1.4 [Copilot compatibility fixes](reviews/2026-10-10-copilot-fixes.md). The rest is the historical record up to 0.1.3.

This record verifies this Copilot adaptation. The original `RUN-NOTES.md` covers Anthropic's earlier experiments and is not evidence for this version.

## Environment and results

| Item | Result |
|---|---|
| OS / Node / Python | Linux x86_64 / Node 24.19.0 / Python 3.12.14 |
| Automated tests | **57 passed, 0 failed, 0 skipped** |
| Original Python / JS-TS / C dependency-mapper fixtures | edges, order and cycles all match the original expectations |
| Offline translation fixture | 3 Python files → 3 JavaScript files, 9 prepared worker responses |
| original | 12 cases passed |
| Comparator mutation check | Detected the deliberate defect in 6 of 12 cases |
| build / smoke | Syntax check of 3 modules passed / 1 real operation passed |
| parity | **12 cases, 0 differences, 0 skipped** |
| Real CLI diagnosis (earlier) | Copilot CLI 1.0.93 startup, version, help and required options checked |

Raw results: [automated test TAP](validation/automated-tests.tap), [offline run results](validation/offline-demo.json).

## Regression checks added in 0.1.3

Astra's findings A1 and A2 were also reproduced independently by the parent agent with a real compiler and judged valid. 8 tests were added to `tests/astra-regressions.test.mjs`. Applied to the old 0.1.2, 6 of them failed; after the fix all 8 passed.

- Direct inputs of `cc -c FILE` are tracked, and a change through `node -c FILE` invalidates old completion records and downstream approvals.
- Inline code is skipped only before a recognized Node/Python/POSIX shell entry point; files passed to unknown tools or scripts are never skipped. Long inline code is handled.
- Artifacts declared in `buildArtifactRoots` are not added to inputs, and the input hash does not change on a first or clean build.
- Even with artifacts excluded, a build that changes a real input during execution fails.
- Sources, translated sources, tests, explicit inputs, managed areas and the like cannot be declared as artifacts.
- New settings may be omitted, and the meaning of an unknown tool's `-o` is not guessed. doctor shows inputs and artifact declarations separately.

The before/after checks with a real C compiler were done on Linux with GCC 13.3.0; the normal automated tests do not require a C compiler. See [command verification results](validation/astra-command-checks.json).

## Regression checks added in 0.1.2

7 tests for re-review findings RR1–RR3, in `tests/rereview-regressions.test.mjs`:

- Changes to commands and explicit settings inside migration revoke completion and approvals.
- Using state/results/gates/runs/run.lock as direct verification inputs is rejected before the stage runs.
- If explicit targets under node_modules, __pycache__ or .git change during verification, the stage fails even when the command exits 0.
- A Latin-1 Python source reaches review decoded and named with its `encoding`, never garbled; the original bytes are untouched.
- A Shift_JIS repair diagnostic (a Japanese Windows compiler log) is decoded too; binary input still stops.
- Valid UTF-8 Japanese, emoji, a BOM and a real U+FFFD are preserved.

## Regression checks added in 0.1.1

15 tests for review findings R1–R7 and hook contract C1. See [the fix table](REVIEW-FIXES.md).

- Detection of changes to sources inside explicitly excluded directories, build scripts and dependency settings.
- Rejection of stale downstream results and approvals after an upstream re-run, whether it fails or succeeds.
- A descendant that ignores SIGTERM does not keep emitting heartbeats after timeout handling completes.
- The same frozen input for both reviewers, exclusion of other workers' records, checks of tool-free CLI/SDK profiles, and stopping on oversized input.
- Collisions of non-adjacent parent/child outputs, saving diagnostics on failure, post-install checks and rejecting a run with 0 tests.
- A top-level deny is emitted even for snake_case CLI hook input; both Local output formats.

## Scope covered by automated tests

- Non-empty unreviewed output is treated as incomplete.
- After one review fails, the run resumes without re-running the other, already complete one.
- Deleting or corrupting review/arbitration records, or changing the output, invalidates completion.
- Changing the comparator, sources or settings invalidates old approvals.
- Only confirmed findings are fixed, and the changed output is re-reviewed by both reviewers.
- Missing arbitration, invalid JSON, forged target paths and contradictory reviews fail.
- Limits on fix rounds and AI calls, and the shared concurrency cap across all workers.
- Saving the build failure's exit code and refusing approval of the next stage.
- Concurrency lock, resumption after interruption, input changes during processing and refusing to overwrite on output conflicts.
- A syntax error can be reviewed and fixed through a repair with diagnostics.
- Rejection of path traversal, duplicate outputs, parent/child output collisions, overlap with protected paths and symlinks.
- Install dry run, re-run, keeping existing instructions and detecting conflicts with existing files in advance.
- Argument passing without shell expansion, timeouts, interruption and output size limits.
- Input/output conversion of the CLI/Local hooks. Hook execution by real tool calls needs separate checking.
- Structured results, model selection, the shared engine and rejection of null responses in a simulated SDK context.
- Non-zero exit-code propagation of the old Bash build path.

## Not verified

**No Copilot model was called with a real account.** Workers and the SDK in automated tests are test responses. Comparison and builds run with real Python/Node processes, but they do not evaluate a model's translation ability.

Account-specific model availability, the VS Code UI, registration and execution of Dynamic Workflows, actual usage, large real projects and Windows are not verified. (Tool restrictions and hook execution on the real CLI, and macOS, were later checked; see the 2026-10-17 record.) [LIVE-SMOKE.en.md](LIVE-SMOKE.en.md) describes the next checks.

## Reproducing

Run `npm test` and `npm run demo` in the unpacked distribution. The installed `migration-kit/` exposes only `npm run check`. No external npm packages or Copilot authentication are needed; Node 22 or later and Python 3 are.

Primary sources consulted: [Copilot CLI v1.0.93](https://github.com/github/copilot-cli/releases/tag/v1.0.93), [tool control](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools), [custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration), [VS Code 1.141](https://code.visualstudio.com/updates/v1_141), [pinned SDK workflows reference](https://github.com/github/copilot-sdk/blob/cf245cdf76ced14d2f61dc3d908dd37cf12e0978/nodejs/docs/workflows.md).

## VS Code orchestration and verification modes

See the canonical section in the [operating manual](OPERATING-MANUAL.md#vs-code-orchestration-and-verification-modes).
