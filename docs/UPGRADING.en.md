# Upgrading (0.5.0 and earlier releases)

[日本語](UPGRADING.md) | English

## 0.5.0 (benchmark for folding workers)

Existing approvals and completion records are revoked once because the kit's files (lib, scripts) change. Re-validate from judge. Completed outputs are kept.

1. New `scripts/review_benchmark.mjs` compares two reviewers with one, and the fixer with the implementer, on seeded cases. See [REVIEW-BENCHMARK.en.md](REVIEW-BENCHMARK.en.md). Run it from the kit checkout, not in a migration target.
2. The translation loop is unchanged.
3. This release also includes the dependency mappers added in 0.4.0. When upgrading from 0.3.2 or earlier, also follow the 0.4.0 instructions below.

## 0.4.0 (dependency mappers for C#, Java, VB.NET, PHP and COBOL)

Existing approvals and completion records are revoked once because the kit's files (lib, scripts) change. Re-validate from judge. Completed outputs are kept; the re-run only reviews them again.

1. Phase 01 can use bundled mappers for C#, Java, VB.NET, PHP and COBOL ([dependency mappers](DEPENDENCY-MAPPERS.en.md)). A project that uses its own tool for these languages (under `migration/tools/` or elsewhere) should compare it with the bundled mapper before switching. Switching changes the map and the dependency declaration, so phase 01's checks and approvals are redone.
2. The new mappers also write `unresolved.tsv`. Review every row in phase 01's report.

## 0.3.2 (phase 00 no longer stops on a credential suspicion or misread guidance)

Existing approvals and completion records are revoked once because the kit's files (lib) change. Re-validate from judge. Completed outputs are kept; the re-run only reviews them again. A project still in phase 00 is not affected.

1. `guidance --message` output starts with "What to do about this message" and says guidance itself succeeded; JSON carries `explained: true`.
2. A message about a suspected credential gets its own guidance: the kit runs no secret scan and no phase stops on one, and a switch alone such as `set /P` is not a credential. Guidance does not repeat that message, Markdown or JSON, since it may hold the value. A clean result ("No credentials detected") gets guidance with no question.
3. Prompt 00: stop reading a line that looks real, and report only its file and line number as unverified. Pass guidance a description without the value, never the tool's raw output.
4. The guardrails.json write check treats PowerShell and cmd.exe readers (`Test-Path`, `Get-ChildItem`, `Select-String`, `findstr`...) as reads. A refusal names the word that matched.

## 0.3.1 (command lines checked; models chosen in one question)

Existing approvals and completion records are revoked once because the kit's files (lib, scripts) change. Re-validate from judge. Completed outputs are kept; the re-run only reviews them again.

1. The runner and the other scripts refuse an unknown option, a missing value, an extra word and a value outside its set (phase IDs, approval stages, `--format`...). If your own scripts relied on forms that used to be ignored silently, fix them to the accepted options the error lists. `--opt=value` is not accepted; write `--opt value`. `--help`/`-h` prints the usage on any command.
2. Models and efforts are chosen in one question and recorded with `models set --assign "implementer=ID:EFFORT,reviewers=ID:EFFORT,arbiter=ID,fixer=ID"`; `--role/--model/--effort` still works.

## 2026-10-19 update (resumption scope, usage, audits, parity repairs)

Existing approvals and completion records are revoked once because the kit's files change. Re-validate from judge. Completed outputs are kept; the re-run only reviews them again (2 calls per unit). From this update on, changing run limits (`concurrency`, `maxAgentCalls` and the like), documents, phase prompts, skills or `.github/copilot-instructions.md` no longer revokes anything.

1. `doctor --check-cli` gains a live check that the tool-assisted reviewer hook loads in the real CLI (loopback, no AI usage).
2. Preparation audits can run as CLI workers with `audit_inputs.mjs run --directory migration/audits/ID`. Pending requests that were not submitted must be frozen again because the configuration hash changed.
3. `maxAiCreditsPerCall` is optional and is not added to existing configurations.
4. The same-day follow-up (failure choices, phase-order guidance, questions and TODO display) also changes the kit's files, so a project re-validated before it is revoked once more (completed outputs are kept). `doctor` no longer fails on a missing dependency declaration before phase 01 is recorded. Findings both reviewers raise at the same line are now arbitrated too, so such a unit makes one more arbiter call. In the TODO list, a phase that waits for approval or review or is blocked is `not-started` (its state is in the title) rather than `in-progress`.

## 0.3.0 (native backend removed; chat-only operation)

0.3.0 removes the VS Code subagent (native) backend; workers always run on the Copilot CLI. The AI proposes each step below in chat and runs it after you agree.

1. A configuration with `workerBackend: "native"`, `nativeHarness`, `nativeModelVerification` or `nativeInput` stops with migration instructions. Set `"workerBackend": "copilot-cli"`, remove those keys, then redo judge and the translation approval.
2. A repository copy's leftover `.github/agents/migration-native-*.agent.md` files are no longer used. The installer does not delete them, so the AI removes them after you agree.
3. If the Copilot CLI is missing or not signed in, the AI runs `npm install -g @github/copilot` and `copilot login`; you only approve the sign-in in the browser.
4. The AI proposes `migration/guardrails.json` from `guardrails show` and installs the agreed list with `guardrails install`. The host asks you to confirm, and that confirmation is your act.
5. Existing configurations do not get `fixPolicy`, `dependencyOrder` or `reviewFocus` added automatically; adopting them restarts approvals.
6. The managed block in `.github/copilot-instructions.md` is much shorter (the skill holds the detail). Reinstalling a repository copy stops with "Existing managed instructions differ"; the AI replaces the text between `<!-- code-migration-kit:start -->` and `end` after you agree, leaving your own text outside the block unchanged.
7. Workers run as sessions (GitHub account sync follows the person's CLI setting) whose IDs the run records keep. Worker sessions from before 0.3.0 have no recorded ID, so `sessions prune` does not touch them; tidy any that were synced to your GitHub account from the Copilot CLI's `/session` commands.
8. Repeated build repairs can be one agreed `build-loop` grant.

## 2026-10-17 update (CLI version tracking, guardrails, tool-assisted review, diagnostics, language)

Existing approvals and completion records are revoked because the kit's files change. Re-validate from judge.

1. Workers start without `--no-auto-update` and run the CLI version you normally use. A version change during a run produces a warning and is kept in the run's `cliVersions` and `warnings`. Confirm with `doctor --check-cli` that every worker ID resolves.
2. For a repository copy, take the new profiles `.github/agents/migration-reviewer-semantics-read.agent.md` and `migration-reviewer-rules-read.agent.md` from a temporary install (used by tool-assisted review). Plugins get them by updating.
3. Starting 03 and 04 requires `migration/guardrails.json`. Copy `templates/guardrails.json` and edit it for the target's build and test commands (agents never create it). From 0.3.0 the AI proposes it with `guardrails show` and, after you agree, installs it with `guardrails install` (the host asks you to confirm). For a repository copy, trust the folder in the Copilot CLI.
4. When a build fails, `repair-round` runs diagnosis, the repair queue and the repairs in one step.
5. Set the report language with `run_migration.mjs preferences --language ja|en`. It is stored in `migration/preferences.json` and does not affect approvals.
6. In VS Code too, use the default CLI worker backend instead of native. The native backend is experimental.

## 2026-10-15 review changes

Existing config is kept. markerPolicy, phaseModels, designInputs and packageMap are never added to existing projects automatically; the new template selects todo-lines-v1. To adopt it in an existing project, check the RULEBOOK's count rule, then redo judge and approvals after changing the setting. An existing translation gate without a batch is treated as the whole manifest, and an old receipt without purpose is production. New 00b records are also bound to the judge inputs. Updating the runtime revokes existing approvals and completion, so re-validate. Native doctor now treats real host capabilities as unknown and exits non-zero. inventory-merge.json is reserved as a generated receipt and cannot be registered as a protected input; move a conflicting existing input to another path and update the settings (nothing is overwritten automatically). The repair queue keeps a journal and review bindings for every job; after an interruption, resume with translate, and build approval stays blocked until every diagnostic, including unstarted jobs, has been reviewed. See [this change table](plans/2026-10-15-review-implementation.md).

Use the README procedure for new installations. Running the 0.1.5 installer over an existing installation stops instead of overwriting files with different content; this is intended.

If the kit is already installed in a project, commit or back up your work, then review and take in the differences below. Patches from older distributions do not include the 0.1.5 changes; update by comparing with a temporary install.

1. Unpack 0.1.5 elsewhere and install it into an empty temporary project with the README installer, using the same `--harness` as the original install and `--with-workflow` if needed. Use your own `MODEL_ID`.
2. Compare the temporary project's `migration-kit/` with the existing one, review your own changes and update. Include lib/core.mjs, review.mjs, text.mjs, pipeline.mjs, workflow.mjs, scripts/copilot_adapter.mjs, run_migration.mjs and make_review_dependencies.mjs.
3. Update `.github/agents/migration-reviewer-*.agent.md` to `tools: []` and implementer/fixer/arbiter to `tools: ["view", "grep", "glob"]`. The old read/search notation is rejected because the search alias drops search tools in the CLI. The orchestrator keeps its existing aliases. Compare the other managed files with the temporary install too, and keep your team's Copilot instructions.
4. Keep the existing `migration/config.json`, RULEBOOK, inventory, manifest, migrated sources and records. Set `verificationInputs` and adjust `maxReviewInputBytes` if needed; the defaults are an empty array and 65536 bytes.
   - 0.1.2 can also track scripts and extra settings inside migration. If commands named state/results/gates/runs/run.lock directly, or they were registered in verificationInputs, move those scripts and settings outside the generated areas.
   - 0.1.3 also tracks direct inputs such as `cc -c FILE` and `node -c FILE`. When a command names an output file directly, add its directory to `buildArtifactRoots`, for example `["artifacts"]` for `cc -c native/shim.c -o artifacts/shim.o`. The default is `[]`. Entries overlapping sources, tests, translated sources, explicit inputs or managed areas are rejected. Do not mix real inputs into artifacts, and validate their contents with each command.
   - The frozen review input is limited to UTF-8. If original sources or other inputs are not UTF-8, check the encoding and meaning and decide how to handle them; a garbled review cannot proceed.
   - From 0.1.4 an audited dependency declaration is required. Create `migration/review-dependencies.json` with the README/phase 01 generator and audit the mapper's coverage, unresolved imports and semantic inventory references. Name a different path in `reviewDependencyMap`. Give isolated files an explicit `[]`. An omitted setting selects the default path, but a missing artifact is an error. Keep the inventory's leading column `file` as in the template and use repository-relative paths. Comments, blank lines and a header preceded by a BOM are accepted.
   - 0.1.5 lets you pass the mapper's `--root` as the generator's `--depmap-root`. For `pkg/...` edges mapped at the repository root, use `--source-root pkg --depmap-root .`. For several source roots, use `--source-roots pkg,shared --depmap-root .` and match config.sourceRoots. Edges starting outside the scope are reported as `ignoredEdges`. A dependency leaving the scope stops the run, so add the needed source root.
   - Every CLI worker requires `--no-custom-instructions`. Move porting policy you applied through AGENTS or personal instructions into RULEBOOK/inventory, then review and re-approve. Confirm with doctor that the CLI supports the required flags. The specified role profile is still loaded.
   - If the workflow is installed, update lib/workflow.mjs too. Stages are registered with the SDK and workers use the same adapter as the normal CLI. The old ctx.agent durable result/schema retry is not used; resumption uses the runner's records. Any CLI executable can be given as `copilot` in the workflow args.
   - CLI communication changes to JSONL with `--output-format json`. Check the CLI with doctor, and never reuse results saved from the old text stdout as new completion responses.
5. Run `node migration-kit/scripts/run_migration.mjs doctor --check-cli` at the project root. Check the tracked files, models and review profiles. `npm run check` is also available from `migration-kit/`.
6. Because hashes of inputs and runtime code and the review contract change, do not reuse old approvals or completion records. Run judge, review the artifacts, and re-approve and run translation. Existing candidate files start from re-review. Then review, approve and run build, smoke and parity in order.

Never continue by editing hashes in records or approval JSON by hand. Existing records can be kept for investigation.
