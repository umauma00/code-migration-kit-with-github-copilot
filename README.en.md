# Code Migration Kit with GitHub Copilot

[日本語](README.md) | English

An unofficial adaptation of Anthropic's [Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code) for GitHub Copilot, centered on the Copilot CLI. It covers cross-language ports end to end: feasibility → fixed rules → translation → independent review → build → old-versus-new comparison.

**0.2.0** supports the Agent Plugins format for VS Code and the Copilot CLI. Install the kit itself as a plugin and keep only configuration and artifacts in the project. See [plugin installation](docs/PLUGIN.en.md), [fixes and re-review of the previous version](docs/reviews/2026-10-10-copilot-rereview-fixes.md) and [upgrading an existing install](docs/UPGRADING.en.md).

Reference versions: Copilot CLI **1.0.93** (provider transport also checked on 1.0.95 and 1.0.98) and VS Code **1.141.0**. The pinned upstream commit and SDK reference are recorded in [UPSTREAM.json](UPSTREAM.json). This is not an official Anthropic or GitHub distribution.

**Verification status: automated tests, the offline fixture and real-CLI transport against a loopback test provider on macOS are verified. Real Copilot authentication, AI translation quality, interactive use in VS Code and live Dynamic Workflows sessions are not.** Run the small check in [LIVE-SMOKE.en.md](docs/LIVE-SMOKE.en.md) before a real project.

## Main changes

Following reviews 1 and 2, this version adds [isolated pilots](docs/PILOT.md) before phase 03, early comparator validation and [preparation audit contracts](docs/PREPARATION-AUDITS.md), and [translation batches, parallel repair and TODO count checks](docs/EXECUTION-SCOPES.md). See also [scope of the changes and remaining live checks](docs/plans/2026-10-15-review-implementation.md).

| Area | Behavior in this version |
|---|---|
| Instructions and skill | The plugin's `skills/code-migration/SKILL.md`, or `.github/skills/code-migration/SKILL.md` for a repository copy. CLI workers disable implicit instruction loading; native workers are host-managed |
| Roles | Orchestrator / implementer / two independent reviewers / arbiter / fixer, plus a tool-free profile for preparation audits |
| Models | Set explicitly for each of the five worker roles, using model IDs available to your account |
| Translation | CLI workers get only `view,grep,glob`; native workers get a frozen input and no tools. JSON responses are validated and the Node coordinator writes only the target file |
| Independent review | Both reviewers receive the same frozen input and have no tools. A unit whose evidence exceeds the limit is reviewed automatically from a hash-bound file list with read-only tools. CLI uses `--no-custom-instructions`; native relies on the host's instruction environment |
| Completion | Hashes of output, inputs, both reviews and any arbitration are recorded. A file merely existing is never "done" |
| Resumption | Resumes from the interrupted stage. Missing reviews or changed outputs are reviewed again |
| Approvals | Bound to inputs, outputs and the previous stage's run ID. Re-running an upstream stage revokes downstream results and approvals |
| VS Code | Copilot uses the shared skill; Local uses the ten phase prompt files and Local hooks |
| Dynamic Workflows | Optional experimental adapter on the same execution engine |

## Running inside VS Code only (native backend, executed model unverified)

To work in VS Code without installing the Copilot CLI, choose the native backend. New native installations get `nativeModelVerification: "requested-unverified"`: the parent passes the requested model to the subagent call's model parameter and submits the result. VS Code does not return the model a subagent **actually ran**, so every attempt record, run summary, status and doctor report says the executed model is unverified.

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --worker-backend native --native-harness copilot --model MODEL_ID --apply
```

When the Copilot CLI is available, the default CLI worker backend (`copilot-cli`) is still recommended: each worker is a process fixed by `--model`, and implicit-instruction isolation is verified on a real CLI. The previous contract that requires host execution metadata is available as `--native-model-verification host-metadata`; it is experimental and cannot complete on VS Code.

With `workerBackend: "native"`, the parent agent of the current VS Code session delegates implementation, review, arbitration and fixing to subagents, and the Copilot CLI is not started. The Node runner issues jobs and the parent submits results; validation, writes, approvals and resumption are shared with the CLI backend. Initialize with `--worker-backend native`. Local supports the repository copy; Copilot (Agent Host) supports the plugin or the copy. See [VS Code native workers](docs/NATIVE-WORKERS.en.md).

Existing configurations keep `copilot-cli` when `workerBackend` is omitted. The native connection is verified by automated tests and the offline fixture only; real AI delegation in a VS Code session is not. CLI and native treat implicit instructions differently and do not offer the same isolation guarantee.

## Requirements

- Node.js 22 or later. The runner has no external npm dependencies.
- For the CLI backend, a signed-in Copilot CLI; for native, a VS Code session that can delegate. Either way, a plan or organization setting that allows the configured models.
- The runtime and build tools of the languages involved. The bundled demo and the Python/C dependency mappers need Python 3.
- Previously verified on Linux; automated tests and CLI transport verified on macOS. Windows is untested; on Windows use a Copilot executable that Node can start directly.

## Installing as a plugin

Clone the plugin branch somewhere other than the project being migrated.

```bash
git clone --branch feat/github-copilot-migration-kit https://github.com/umauma00/code-migration-kit-with-github-copilot.git /path/to/code-migration-kit
copilot plugin marketplace add /path/to/code-migration-kit
copilot plugin install code-migration-kit@code-migration-kit-marketplace
```

This needs a checkout that includes the 0.2.0 changes. VS Code detects plugins installed by the CLI. For registering a local checkout directly, project initialization and updates, see [PLUGIN.en.md](docs/PLUGIN.en.md). Open the target repository in VS Code and ask Copilot Chat to start the migration with the `code-migration` skill.

## Copying the kit into the target repository

Run from the kit root. Replace `MODEL_ID` with an actual ID that `/model` shows for your Copilot account; no model names or prices are hard-coded.

```bash
# Preview the changes first
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --language en

# Apply what you reviewed
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --language en --apply
```

`--language ja|en` sets the language of phase reports, questions and `status --format markdown`. It is stored in `migration/preferences.json` and never affects approvals or completion. If omitted, the skill asks Japanese or English at the start. Change it later with `run_migration.mjs preferences --language ja`.

Scripts and documents go to `migration-kit/` in the target, and the Copilot entry points to `.github/`. A managed block is appended to existing Copilot instructions. Existing files with different content are never overwritten (the installer stops), and an existing `migration/config.json` is kept. Re-running with the same content changes nothing.

To use VS Code **Local** hooks, add `--harness vscode-local` to both commands; its event format differs from the standard `copilot` one. The option only selects which hook format is installed and does not switch the VS Code session: pick **Local** in the chat's session type. CLI workers also restrict tools on their command line.

Run everything below from the target repository root.

```bash
node migration-kit/scripts/run_migration.mjs doctor --check-cli
```

`doctor` checks the configuration, profiles, CLI version and required options. It also starts the CLI with the same arguments and environment as the workers and proves that every worker agent resolves (no AI calls). Right after installation it reports the dependency declaration created in phase 01 as missing; re-run it after that file is created and audited. It does not guarantee model availability or that hooks actually run.

## Configuration

In the chat, every phase ends with its artifacts, review points, the next phase and a sample reply. When a decision is needed the agent asks with the available question tool, or waits for a chat reply where none exists. See [phase reports and user decisions](docs/PHASE-HANDOFF.md) for examples after initialization.

The minimum settings in `migration/config.json`:

| Setting | Meaning |
|---|---|
| `sourceRoots` | Protected original sources, e.g. `["src"]` |
| `outputRoots` | Translated **sources**, e.g. `["ported"]`. Put build products elsewhere |
| `verificationRoots` | Comparators, tests and test data, e.g. `["tests"]` |
| `verificationInputs` | Extra build/dependency settings whose changes are tracked, e.g. `["build/config.json", "packages/api/tsconfig.json"]` |
| `buildArtifactRoots` | Directories where commands write binaries, objects and reports, e.g. `["artifacts", "dist"]`. Defaults to an empty array |
| `maxReviewInputBytes` | JSON size limit of the frozen review input; default 65536 bytes. On the CLI backend an oversized unit switches automatically to tool-assisted review (below); native stops |
| `reviewDependencyMap` | Audited dependency declaration JSON; default `migration/review-dependencies.json`. A required phase 01 artifact |
| `sourceLanguage`, `targetLanguage` | The languages; the template's Python/JavaScript can be changed |
| `verificationMode` | `runtime` (default): runs the original environment and old-versus-new comparison. `source-only`: validates source-derived preparation and the translated build/smoke, and hands off with behavioral equivalence unverified. Existing settings are never changed automatically |
| `mode` | `preserve` for automatic file translation. `redesign` is supported up to the design and trial prompts |
| `phasePolicy` | `strict` for new installs. Unset in existing ones keeps legacy behavior; `phase init` from the skill enables ordered phases without changing the config |
| `models` | IDs for implementer, reviewer-semantics, reviewer-rules, arbiter and fixer |
| `phaseModels` | Explicit host models for rulebook, judgeAudit, dependencyAudit, inventoryAudit, stressA/B, stressInspector and designAudit. Preparation audits run in the parent and are never inherited by the automatic runner |
| `designInputs` | Design documents included in full in the frozen input and protected. A link alone does not count as the body. This does not enable a redesign module runner |
| `packageMap` | Optional source→target package declaration JSON. When set, phase 01 records a separate package-cycle audit |
| `markerPolicy` | `todo-lines-v1` for new installs: the number of lines with TODO(port) must match the trailer's todos. Existing projects without it keep the old contract |
| `workerBackend` | `copilot-cli` (default) or `native`. Changing it revokes approvals |
| `nativeHarness` | Required for native: `vscode-local` or `copilot`, matching the current session |
| `concurrency` | Concurrent AI calls, default 2, reviews included |
| `maxFixRounds`, `maxAgentCalls` | Fix rounds per unit and AI calls per run |
| `maxRunInputBytes` | Optional cap on the prompt bytes a run sends to workers. AI Credits are metered on tokens and usage stops when they run out, so this budgets runs between usage checks. The run summary's `usageEstimate` records measured bytes and estimated tokens (bytes ÷ 4, not billing data). The check uses completed calls, so calls already in flight (up to `concurrency`) can overshoot it |
| `timeoutSeconds` | Time limit for one CLI worker call |
| `commandTimeoutSeconds` | Time limit for build and comparison commands |

`commands` are argument arrays, not shell strings. Put pipes or several commands in a separate script, and configure only commands you trust.

Sources and targets listed in the manifest are always tracked, even inside excluded directories. Main dependency/build files at the root and repository files named directly in command arguments are also tracked automatically, including files such as `migration/build.mjs`. Add indirectly loaded scripts and nested settings to `verificationInputs` and check the list in `doctor`; files like `migration/build-settings.json` can be listed explicitly. The generated `migration/state`, `results`, `gates`, `runs` and `run.lock` cannot be used as command files or `verificationInputs`. Changes to external tools or environment variables are not detected; after an environment change, re-validate from judge.

When a command argument also names an output, declare the output directory in `buildArtifactRoots`. For `cc -c native/shim.c -o artifacts/shim.o`, set `"buildArtifactRoots": ["artifacts"]`: the input `native/shim.c` stays tracked, and creating, deleting or regenerating outputs is not an input change. Output options like `-o` mean different things per tool, so they are never inferred. An undeclared output file may be treated as an input once created and stop validation.

Artifact directories cannot overlap original sources, translated sources, verification roots, explicit inputs or the kit's managed areas. Keep the settings and scripts that are actually loaded outside them and register them in `verificationInputs` as needed. `doctor` lists inputs and artifact directories separately. Artifact contents are not part of approval hashes, so validate them with the build, smoke and parity commands. Recognized inline Node/Python/POSIX shell code is not treated as a file, but FILE in `cc -c FILE` and `node -c FILE` is tracked.

The review input contains the unit's original file and the transitive closure of its declared dependencies, the candidate file, the whole RULEBOOK, the matching inventory rows plus global notes, and any diagnostic. Both reviewers get the same content and no tools. Inventory rows are selected by an exact repository-relative match on the leading `file` column. A UTF-8 BOM at the start of the file is removed once before comments, blank lines and the header are detected. Malformed rows or unknown leading columns stop the run. Input files must be UTF-8 text; files with invalid UTF-8 or NUL bytes stop the run by name. Static sources are also checked before implementer and fixer calls. Integration with other translated files is checked by build/smoke/parity. On the CLI backend, a unit over the limit does not stop: it switches automatically to **tool-assisted review**. Both reviewers receive the same "file list with SHA-256" instead of contents, and read-only `reviewer-*-read` profiles read the files. A hook keeps other workers' records (`migration/runs` and so on) out of reach. Because this guarantees less independence than a frozen input, it is recorded in `reviewInputMode`, the run's `toolAssistedReviews` and `warnings`, and shown in phase reports. Native stops, as it has no tools. The full source scan for change tracking is kept.

All five CLI workers start a new process with `--no-custom-instructions`. This stops automatic injection of `AGENTS.md` and repository or personal Copilot instructions, so workers use only their role profile and the runner's contract. Put project-specific porting policy into the approved `migration/RULEBOOK.md` and inventory; changing implicit instruction files does not change worker behavior. Normal interactive sessions still use Copilot instructions.

If an existing `edges.tsv` is relative to the mapper's `--root src`, draft the dependency declaration with:

```bash
node migration-kit/scripts/make_review_dependencies.mjs \
  --source-root src --edges migration/depmap/edges.tsv
```

When the mapper's `--root` differs from the source directory to enumerate, pass `--depmap-root`. For a TSV mapped at the repository root (for example to resolve Python's `from pkg import b`), use the example below. `.` is allowed only as the mapping root.

```bash
python3 migration-kit/scripts/depmap_python.py --root . --out migration/depmap
node migration-kit/scripts/make_review_dependencies.mjs \
  --source-root pkg --depmap-root . --edges migration/depmap/edges.tsv
# With dependencies across several source roots (set config.sourceRoots to the same range)
node migration-kit/scripts/make_review_dependencies.mjs \
  --source-roots pkg,shared --depmap-root . --edges migration/depmap/edges.tsv
```

The JSON format is `{"schemaVersion":1,"dependencies":{"src/a.py":["src/b.py"],"src/b.py":[]}}`. Without `--depmap-root`, the single `--source-root` is the mapping root, so older commands still work. Enumeration is limited to the given source roots, and isolated files get `[]`. Edges that start outside the scope (for example tests → pkg) are dropped and listed under `ignoredEdges` on stdout. A dependency from a source in scope to one outside (for example pkg → shared) stops the command and asks for the missing root. Audit the mapper's supported syntax, exclusions, unresolved imports and dropped edges, and add semantic references needed for inventory evidence. With several mapping roots, generate separate `--out migration/PATH.json` files and merge them into one map. Missing keys or files in a required closure stop the run. Changing the map or explicit dependencies revokes approvals and completion records.

The commands below are for the default **runtime mode**. Projects without a usable original environment use the explicit [source-only mode](docs/SOURCE-ONLY.md) preparation record and its build/smoke → handoff path.

```json
{
  "original": ["python3", "-B", "tests/judge.py", "original"],
  "mutation": ["python3", "-B", "tests/judge.py", "mutation"],
  "build": ["python3", "-B", "tests/judge.py", "build"],
  "smoke": ["python3", "-B", "tests/judge.py", "smoke"],
  "parity": ["python3", "-B", "tests/judge.py", "parity"],
  "typecheck": ["node", "--check", "{target}"]
}
```

This is the bundled fixture's example; replace it with your project's commands. `mutation` exits 0 when the comparator detects a deliberately broken implementation. Keep `typecheck` to a cheap check that is valid before the whole tree is translated, or set it to `null`.

## No runnable original or no specification

When the original cannot run and no specification exists, choose [source as the only specification](docs/SOURCE-AS-SPEC.en.md). The AI drafts the 00b, 01 and 02 artifacts (source-derived contracts, dependency map, RULEBOOK, inventory) together; after one user review and OK the migration continues from 03. Behavioral equivalence is handed off as unverified.

```bash
# New project
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --preparation-profile source-as-spec --apply
# Existing project (for example, runtime 00b got stuck): preview, then --apply after consent
node migration-kit/scripts/run_migration.mjs source-spec init
node migration-kit/scripts/run_migration.mjs source-spec check
```

## Progress display and failure guidance

`status --format checklist` shows the ten phases and "you are here"; `status --format todo` returns the items for the host TODO tool. Every phase report starts with this checklist.

When a runner command fails it prints, after the `ERROR:` line, **the cause, the impact and the choices (one recommended, each with its reason and command)**. Copilot shows this, asks with the question tool and waits for the answer. For failures outside the runner, `run_migration.mjs guidance --message "error text"` produces the same guidance.

## Working through the phases

Before phase 03, copy `templates/guardrails.json` (`migration-kit/templates/guardrails.json` for a repository copy) to `migration/guardrails.json` and edit it for your target's build and test commands. It replaces the upstream `.claude/settings.json` deny rules: a hook denies matching shell commands in every agent session. Builds run by the runner are not affected. `phase start 03` / `04` stops without this file (or a recorded waiver); agents never create it. With a repository copy, the Copilot CLI loads the hook only in a trusted folder; check with `doctor`.

Have Copilot read the matching prompt and review each phase's artifacts. In VS Code **Local**, the matching `/migrate-…` prompt files are available.

VS Code **Copilot (Agent Host)** does not load prompt files. Invoke the shared `/code-migration` skill and name the phase from the table below, for example "continue with the comparator design". The skill links every phase prompt, so no per-phase skills are needed, and the ten Local `/migrate-…` commands are not registered in this session type.

At start or resumption, the parent orchestrator registers the ten phases below in Copilot's TODO list and shows running, awaiting approval, revising and stopped states; initial setup is listed separately. Each phase ends with progress such as "5/10 phases complete, next: awaiting approval for 04", and on resumption the list is reconciled with the actual artifacts and validation records. Where no TODO tool exists, the same list is shown in chat. See [phase TODO tracking](docs/PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list).

The table and the CLI examples that follow are for **runtime mode**. In [source-only mode](docs/SOURCE-ONLY.md), 00b prepares a source-derived judge plan, 05c is shown as unverified and not run, and after a successful 05b the 06 handoff is approved and recorded.

| Phase | Prompt | Main artifacts |
|---|---|---|
| Feasibility and scope | [00-feasibility](prompts/00-feasibility.md) | `migration/feasibility.md` |
| Comparator design | [00b-judge-setup](prompts/00b-judge-setup.md) | Original tests, comparator, mutation self-check |
| Dependencies | [01-dependency-map](prompts/01-dependency-map.md) | depmap, `migration/manifest.tsv`, `review-dependencies.json` |
| Semantic gaps and policy | [02-gap-inventory](prompts/02-gap-inventory.md) | `migration/RULEBOOK.md`, `inventory.tsv` |
| Stress test | [03-stress-test](prompts/03-stress-test.md) | `migration/stress-test/report.md` |
| Translation and review | [04-translation-kickoff](prompts/04-translation-kickoff.md) | Translated sources, review records |
| Whole build | [05-survey-build](prompts/05-survey-build.md) | Diagnostics, repair records |
| Basic operation | [05b-smoke](prompts/05b-smoke.md) | Smoke results from real operations |
| Old versus new | [05c-parity](prompts/05c-parity.md) | Case counts, differences, original test results |
| Cleanup after parity | [06-post-parity](prompts/06-post-parity.md) | Remaining issues, decisions, handoff |

The manifest is a tab-separated file with two columns, `source` and `target`: one source file to one target file. Duplicate outputs, overwriting original sources and symlinks inside managed paths are rejected. Overlap with protected roots is also checked against existing parents and file identities, and case-only aliases of the same file are rejected. Targets are checked again right before they are written. The bundled mappers are starting points for Python, JS/TS and C; Java/C# mappers and framework-specific rules must be added.

In runtime mode, review the prepared comparator, manifest, rules and reports, then run one stage at a time. Do not run the following in one go: read each result before the next approval.

```bash
# Original tests and comparator self-check
node migration-kit/scripts/run_migration.mjs judge

# After reviewing feasibility, rules, comparator and stress-test results
node migration-kit/scripts/run_migration.mjs approve translation --note "What you reviewed and why"
node migration-kit/scripts/run_migration.mjs translate
node migration-kit/scripts/run_migration.mjs status

# After reviewing every unit's reviews
node migration-kit/scripts/run_migration.mjs approve build --note "Reviewed the review results"
node migration-kit/scripts/run_migration.mjs build

# After reviewing the build
node migration-kit/scripts/run_migration.mjs approve smoke --note "Reviewed the build"
node migration-kit/scripts/run_migration.mjs smoke

# After confirming smoke behavior
node migration-kit/scripts/run_migration.mjs approve parity --note "Confirmed basic behavior"
node migration-kit/scripts/run_migration.mjs parity
```

When the build fails, run `repair-round`. The bundled parsers (Python, Java/Maven, JavaScript/Node/ESLint/tsc, shell/ShellCheck, Rust and the generic `file:line:col: error` form) read the recorded build output, build a repair queue per manifest target and run the repairs. Lines that map to no manifest target are listed, never guessed. Error counts per round are kept in `migration/build-rounds.tsv`. A fresh build after repairs still needs approval.

```bash
node migration-kit/scripts/run_migration.mjs repair-round
node migration-kit/scripts/run_migration.mjs approve build --note "Reviewed the repairs"
node migration-kit/scripts/run_migration.mjs build
```

For an unsupported format, name the unit and a diagnostic excerpt yourself:

```bash
node migration-kit/scripts/run_migration.mjs repair \
  --target ported/example.mjs --evidence migration/diagnostic-slice.txt
```

Repairs go through review → arbitration → fixing confirmed findings → re-review. A changed output revokes approvals from the old build onward, so review and approve again. If sources, configuration, rules or the comparator change, re-validate from judge, review the updated stress test and approve translation again.

Even with identical inputs, starting a re-run of build or any other stage revokes downstream results and approvals. After a successful re-run, review, approve and run smoke onward again. Re-running judge restarts from the translation approval.

After an interruption, run `translate` again. A normal `translate` re-checks units that were already done at the start and fails unless every unit has valid review records at the end. `repair` succeeds when the named unit is done. Only when a crash left a lock behind, confirm that the owning process has exited and use `unlock --pid OWNER_PID`; a live PID cannot be unlocked.

## Optional: Dynamic Workflows

Adding `--with-workflow` to the install command also installs `.github/extensions/code-migration/extension.mjs`. It registers the stages with the SDK's `defineWorkflow` / `joinSession`, and workers start through the same adapter as the normal CLI path. `ctx.agent`, which inherits the host session's context, is not used. Resumption, approvals and completion use the runner's records.

```bash
copilot --experimental --allow-tool read workflow run code-migration --args '{"stage":"translate"}'
```

The CLI must load it as a trusted extension. See [Dynamic Workflows](docs/DYNAMIC-WORKFLOWS.md). **This is an experimental entry point and is untested in a real CLI session.** One workflow run executes one stage; the next stage needs its own approval.

## Tests and limitations

Run these **in the unpacked distribution**. They need no AI usage or sign-in.

```bash
npm test
npm run demo
```

The `migration-kit/` copied into a project is a runtime package without tests or the demo. There, `npm run check` diagnoses configuration, profiles and tracked inputs; `npm test` / `npm run demo` are for the distribution source.

The demo replaces worker responses with prepared code and really runs the Python/Node comparison and build. It is not a benchmark of model output quality. Details are in [TESTING.en.md](docs/TESTING.en.md).

- The operating rules are language-neutral, but this is not a universal translator that prepares dependency mapping, builds and equivalence checks for every language automatically.
- Large real projects, very large single files, units that rewrite several files as one and automatic redesign are untested or unsupported.
- A CLI response is one JSON object. Worker responses are capped at 16 MiB and are also limited by the model's own output limit.
- Logs record the requested model and timing. Models, tokens and AI credits that cannot be measured are `null`. Call limits are not spending limits.
- Permission restrictions and hooks are workflow controls, not an OS isolation boundary. SDK extensions and configured commands run as local code.
- The old Bash `build_daemon.sh` is kept for compatibility. Do not run it alongside the shared runner; normally use the Node `build` stage.

The upstream records are kept in [UPSTREAM-README.md](docs/UPSTREAM-README.md), [UPSTREAM-CLAUDE.md](docs/UPSTREAM-CLAUDE.md) and the original `RUN-NOTES.md`. See [LICENSE](LICENSE) / [NOTICE](NOTICE) for notices, [OPERATING-MANUAL.md](docs/OPERATING-MANUAL.md) for runtime rules and [CONTRACTS.md](docs/CONTRACTS.md) for JSON formats.

## VS Code orchestration and verification modes

The parent agent's responsibilities (phase TODO, questions, distributing native jobs), the read-only `status --format markdown`, source-only mode and Rubber Duck are described in the [operating manual](docs/OPERATING-MANUAL.md#vs-code-orchestration-and-verification-modes).

## Phase order and usage records

`/code-migration` enables the [ten-phase order check](docs/ORDERED-WORKFLOW.en.md) and continues from the first incomplete phase. New configurations use phasePolicy=strict. Missing review records for 00–03 block the formal judge and the real translation. For existing projects, phase records are created by reviewing the actual artifacts in order.

The same [migration/cost-log.tsv](docs/COST-LOG.en.md) as upstream main is produced; usage or models that cannot be obtained are `unknown`. The current `models` setting assigns a model to each of the five worker roles, with the two reviewers as independent profiles. The automatic runner has no per-phase setting for investigators such as 01/02 or for optional review profiles.
