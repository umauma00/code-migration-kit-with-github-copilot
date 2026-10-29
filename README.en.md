# Code Migration Kit with GitHub Copilot

[日本語](README.md) | English

An unofficial adaptation of Anthropic's [Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code) for GitHub Copilot, centered on the Copilot CLI. It covers cross-language ports end to end: feasibility → fixed rules → translation → independent review → build → old-versus-new comparison.

**0.16.0** lets the GitHub Copilot app install the same plugin (see [plugin installation](docs/PLUGIN.en.md), checked against the official documentation on 2026-10-29).

**0.3.0** removes the VS Code subagent (native) backend: workers always run on the Copilot CLI, also from VS Code. People complete the migration from AI chat alone; the AI runs the commands, including installing the CLI, starting its sign-in and installing the guardrails. **0.2.0** supports the Agent Plugins format for VS Code and the Copilot CLI. Install the kit itself as a plugin and keep only configuration and artifacts in the project. See [plugin installation](docs/PLUGIN.en.md), [fixes and re-review of the previous version](docs/reviews/2026-10-10-copilot-rereview-fixes.md) and [upgrading an existing install](docs/UPGRADING.en.md).

Reference versions: Copilot CLI **1.0.98** (provider transport also checked on 1.0.93 and 1.0.95; on 1.0.98 every role's round trip in both layouts, hook loading and the error output format were checked too) and VS Code **1.142**. In VS Code 1.142 the Copilot harness is becoming the default for new sessions, and prompt files are Local-harness only (`chat.promptFilesLocations` is deprecated; sources: [1.142 release notes](https://code.visualstudio.com/updates/v1_142), [Prompt files](https://code.visualstudio.com/docs/agent-customization/prompt-files), [AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings), checked 2026-10-18); from 0.7.0 the only entry point, in VS Code and the Copilot CLI alike, is the migration orchestrator in the agent picker (skills and workers are set to stay out of the slash menu and the picker). The pinned upstream commit and SDK reference are recorded in [UPSTREAM.json](UPSTREAM.json). This is not an official Anthropic or GitHub distribution.

**Verification status: automated tests, the offline fixture and real-CLI transport against a loopback test provider on macOS are verified. Real Copilot authentication, AI translation quality, interactive use in VS Code and live Dynamic Workflows sessions are not.** Run the small check in [LIVE-SMOKE.en.md](docs/LIVE-SMOKE.en.md) before a real project.

## Main changes

Following reviews 1 and 2, this version adds [isolated pilots](docs/PILOT.md) before phase 03, early comparator validation and [preparation audit contracts](docs/PREPARATION-AUDITS.md), and [translation batches, parallel repair and TODO count checks](docs/EXECUTION-SCOPES.md). See also [scope of the changes and remaining live checks](docs/plans/2026-10-15-review-implementation.md).

| Area | Behavior in this version |
|---|---|
| Entry point and skill | The orchestrator is the only entry point (`migration-orchestrator` for a repository copy, `code-migration-plugin-orchestrator` for the plugin). Its procedure is the plugin's `skills/code-migration/SKILL.md`, or `.github/skills/code-migration/SKILL.md` for a repository copy, which the orchestrator reads first; the skill is set to stay out of the `/` menu (`user-invocable: false`). Workers disable implicit instruction loading |
| Roles | Orchestrator / implementer / two independent reviewers / arbiter / fixer, plus a tool-free profile for preparation audits |
| Models | Set explicitly for each of the five worker roles, using model IDs available to your account |
| Translation | Copilot CLI workers get only `view,grep,glob`. JSON responses are validated and the Node coordinator writes only the target file |
| Independent review | Both reviewers receive the same frozen input and have no tools. A unit whose evidence exceeds the limit is reviewed automatically from a hash-bound file list with read-only tools. Workers use `--no-custom-instructions` |
| Completion | Hashes of output, inputs, both reviews and any arbitration are recorded. A file merely existing is never "done" |
| Resumption | Resumes from the interrupted stage. Missing reviews or changed outputs are reviewed again |
| Approvals | Bound to inputs, outputs and the previous stage's run ID. Re-running an upstream stage revokes downstream results and approvals |
| VS Code | In both the Copilot harness (becoming the default in 1.142) and Local, select the orchestrator in the agent picker. Local uses Local hooks with `--harness vscode-local` |
| Dynamic Workflows | Optional experimental adapter on the same execution engine |

## Chat only

People never type commands: the whole migration runs from AI chat in VS Code (or the Copilot CLI). Open the target repository and ask Copilot Chat, for example:

> Clone the `feat/github-copilot-migration-kit` branch of https://github.com/umauma00/code-migration-kit-with-github-copilot into `../code-migration-kit`, and install it into this repository with `scripts/install.mjs`

After installation, open a new chat, select `migration-orchestrator` in the agent picker (`code-migration-plugin-orchestrator` for a plugin install; `/agent` in the Copilot CLI), and ask, for example, "start a Python to TypeScript migration" or "continue the migration". Other agents do not start phases; they point you to the orchestrator. The AI runs everything itself and reports in chat:

- It checks the Copilot CLI. If it is missing, the AI explains why it is required and runs `npm install -g @github/copilot` after you agree. If sign-in is needed, it starts `copilot login` and shows the URL and one-time code in chat. This is needed once, separately from the VS Code sign-in.
- It runs initialization, configuration and every phase command, runs long translations in a background terminal with progress reports, and presents cause and choices when something fails.

Your part is limited to three things:

1. Answering questions in chat (language, models, policies, each phase's decisions).
2. Allowing the host's confirmation prompt for human-decision commands (`approve`, `phase complete`, `pilot prepare`, `source-spec init --apply`, `guardrails install`). When the AI runs one, the host asks you first.
3. Approving the Copilot CLI sign-in in the browser (first time only).

Workers are always Copilot CLI processes: `--model` fixes each role's model, and tool limits and implicit-instruction isolation are verified on a real CLI. A 0.2.0 configuration with the native backend (`workerBackend: "native"` and so on) stops with migration instructions; the AI shows them and fixes the configuration after you agree.

## Requirements

- Node.js 22 or later. The runner has no external npm dependencies.
- The Copilot CLI (if it is missing, the AI installs it and starts sign-in after you agree) and a plan or organization setting that allows the configured models.
- The runtime and build tools of the languages involved. The bundled demo and the Python/C dependency mappers need Python 3.
- Windows is a primary platform: GitHub Actions runs `npm test` and `npm run demo` on `windows-latest` and `ubuntu-latest` (a live Copilot CLI and VS Code run is still pending). `.cmd`/`.bat` build commands (`npm`, `npx`, `mvn`, `gradlew.bat`) may be used in `commands`. See [Using the kit on Windows](docs/WINDOWS.en.md) for requirements and caveats. Automated tests and CLI transport are also verified on macOS.

## Installing as a plugin

GitHub Copilot CLI, VS Code and the GitHub Copilot app all install it from the same marketplace. Until it is on the repository's default branch, name the branch after `#`.

```bash
copilot plugin marketplace add umauma00/code-migration-kit-with-github-copilot#feat/github-copilot-migration-kit
copilot plugin install code-migration-kit@code-migration-kit-marketplace
```

In VS Code, add the same source from the marketplace settings in **Chat: Open Customizations**; in the app, from the marketplace settings in **Customize**; then install `code-migration-kit`. VS Code also detects plugins installed by the CLI. For app session settings (This computer, Current checkout), registering a local checkout, installing from an internal Git server, project initialization and updates, see [PLUGIN.en.md](docs/PLUGIN.en.md). Open the target repository, select `code-migration-plugin-orchestrator` in the agent picker (`/agent` in the CLI) and ask it to start the migration.

## Copying the kit into the target repository

Run from the kit root. `--model MODEL_ID` is optional: without it, choose per role after installation with `models list` / `models set` below. If you pass it, use an actual ID that `/model` shows for your Copilot account; no model names or prices are hard-coded.

```bash
# Preview the changes first
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --language en

# Apply what you reviewed
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --language en --apply
```

**The person chooses models, reasoning effort and context size.** Install without `--model`, then in the target repository run the commands below: the first reads the models your account can use, each model's selectable efforts (and default), context sizes (prompt limits) and prices from the CLI. Right after installation the AI asks for every role's model from that list in **one question** and records it with `models set --role all` (the host asks the person to confirm once); per-role effort and context are changed in the run settings file below. To change models later from chat, the AI asks for every role's model, effort and context in one question and records it with one `models set --assign`. Values changed with `models set` and `preferences` are written to the run settings file too.

```bash
node migration-kit/scripts/run_migration.mjs models list --format markdown
node migration-kit/scripts/run_migration.mjs models set --assign "implementer=MODEL_ID:medium,reviewers=MODEL_ID:high:long_context,arbiter=MODEL_ID,fixer=MODEL_ID"
node migration-kit/scripts/run_migration.mjs models set --role reviewers --model MODEL_ID --effort high
```

`--assign` is one answer: `role=MODEL_ID:EFFORT` entries separated by commas (effort left out = default; `all=ID` first sets every role, and later roles override it). Every entry is checked before writing, so one refused entry changes nothing. `--role` takes a role name, `reviewers` (both reviewers) or `all` (the surveyor drops its own setting and follows the implementer). The surveyor inherits the implementer's model and effort only while it has no model of its own. Prices are the CLI's published token prices, shown as AI Credits per million tokens. `--effort default` returns to the model's default. A model that is not listed or is disabled by policy, or an effort the model does not support, is refused. Listing needs a signed-in Copilot CLI.

For context size, only roles with `:long_context` after the effort run the long context tier (the Copilot CLI's `--context long_context`), and only models whose Context column lists long_context accept it. It costs more, so keep it to the roles that need it. Without it a role runs the default context and workers get no `--context` flag (the CLI's own `contextTier` setting applies). For a single role, `--role ROLE --model ID --context long_context|default` works too. Like model and effort, a change makes reviewed units be reviewed again.

`--models implementer=ID,reviewers=ID,arbiter=ID,fixer=ID` still sets per-role models (unlisted roles use `--model`). As in the upstream model plan, choose by blast radius: reviewers on the largest or a mid model, high-volume implementers on a mid or small model, fixers and the arbiter on a mid model.

**Run settings are decided in one file.** After installation the AI first asks one question for every role's model (choices: your account's models; recorded with `models set --role all`), then guesses the source language from the files' extensions and asks one question for the target ("The source looks like C# (120 files in src). Which language do you migrate to?"; free text corrects the source). The answer is recorded with `settings init --source C# --target TypeScript`, which also fills the source folders from the guess. The third question is how phases advance: normal (recommended; each phase waits until its prerequisites are met) or relaxed (a missing prerequisite is a warning, you are asked "fix or proceed" each time, and a phase you proceed past is recorded as waived), or, to run through with Copilot CLI autopilot, auto (relaxed without asking; completions, approvals and waivers are recorded unasked and marked auto), recorded with `preferences --phase-mode` (see [relaxed mode](docs/ORDERED-WORKFLOW.en.md#relaxed-mode) and [auto mode](docs/ORDERED-WORKFLOW.en.md#auto-mode)). The fourth question is whether the original program can be built and run here (recorded with `preferences --original-runtime`); if it cannot, the file's verification mode becomes `source-only`, and a fifth question asks whether a specification or a test suite the target can use exists. Without either, setup switches to treating the source as the specification (source-as-spec) before phase 00 (the host asks once). With auto mode chosen, every setup question starts with a line saying setup is still manual and about how many confirmations remain, and when setup is done the run stops before phase 00 and tells you to switch to autopilot. First choices are always asked as questions, never typed into the file: the file is for changing settings later (several at once, such as every role's effort) and for resuming in another session. One source language is migrated: another language of comparable size is pointed out so you pick the main one, and a language with only a few files (such as SQL) is not treated as the source language (the bundled dependency mapper reads only the source language's files). `settings init` writes `migration/run-settings.json`: migration languages, folders, verification mode, whether the original can run, execution mode, concurrency, stage commands, and each role's model, effort and context size, holding values only. Each field's explanation and choices, and your account's models, efforts and context tiers, are in `migration/run-settings.help.md` beside it. Every role already holds the chosen model, so edit a role only to change it. Open entries read `FILL_IN`. Instead of answering one question per setting, fill in the file and answer the AI's single question ("filled in, or do you have a question?"). "Filled in" runs `settings apply`, which checks every entry and, if any is wrong, writes nothing and returns every problem (the host asks you to confirm once). Applying checks every model entry, so the Copilot CLI must be signed in.

```bash
node migration-kit/scripts/run_migration.mjs settings init
node migration-kit/scripts/run_migration.mjs settings check
node migration-kit/scripts/run_migration.mjs settings apply
```

The values are recorded where they always were, `migration/config.json` (languages, folders, models...) and `migration/preferences.json` (report language, whether the original can run), so changing the report language never revokes approvals. The file stays as the record of the conditions a run used; while an edit is not applied, `status` says so.

`--language ja|en` sets the language of phase reports, questions and `status --format markdown`. It is stored in `migration/preferences.json` and never affects approvals or completion. If omitted, the skill asks Japanese or English at the start. Change it later with `run_migration.mjs preferences --language ja`. Until it is set, the hook denies any other question; with `ja` it checks each question's text and choices (`ask_user`, VS Code askQuestions) and asks for a Japanese rewrite. Headers, other questions and \`backticked\` text do not count. Text with hiragana passes as Japanese, even with a path joined to it (`src/main.pyを移行しますか？`); without hiragana, whitespace-separated paths and file names are set aside first, so `Should we migrate 売上集計.java next?` is denied; a choice of two or more English words with no Japanese is denied (a one-word name such as `Java` passes). This is a character-class check, not language detection: an English sentence containing a name with hiragana still passes.

Scripts and documents go to `migration-kit/` in the target, and the Copilot entry points to `.github/`. A managed block is appended to existing Copilot instructions. Existing files with different content are never overwritten (the installer stops), and an existing `migration/config.json` is kept. Re-running with the same content changes nothing.

To use VS Code **Local** hooks, add `--harness vscode-local` to both commands; its event format differs from the standard `copilot` one. The option only selects which hook format is installed and does not switch the VS Code session: pick **Local** in the chat's session type. CLI workers also restrict tools on their command line.

Run everything below from the target repository root.

```bash
node migration-kit/scripts/run_migration.mjs doctor --check-cli
```

`doctor` checks the configuration, profiles, CLI version and required options. It also starts the CLI with the same arguments and environment as the workers and proves that every worker agent resolves (no AI calls). The dependency declaration created in phase 01 shows as `pending`, not failed, until phase 01 is recorded; after that a missing declaration fails. It then runs the real CLI against a local loopback model (no account, network or AI usage) and proves that the hook keeps a tool-assisted reviewer out of `migration/runs`. Loading that hook relies on the undocumented `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS` variable, so this check fails if a CLI update stops honoring it (verified on CLI 1.0.98 and 1.0.100-1). It does not guarantee model availability or that hooks run in interactive sessions.

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
| `maxReviewInputBytes` | JSON size limit of the frozen review input; new installs use 262144 bytes (256 KiB, about 65k–90k tokens), older configs keep their value and an omitted key means 65536. An oversized unit switches automatically to tool-assisted review (below) |
| `reviewDependencyMap` | Audited dependency declaration JSON; default `migration/review-dependencies.json`. A required phase 01 artifact |
| `sourceLanguage`, `targetLanguage` | The languages; the template's Python/JavaScript can be changed |
| `verificationMode` | `runtime` (default): runs the original environment and old-versus-new comparison. `source-only`: validates source-derived preparation and the translated build/smoke, and hands off with behavioral equivalence unverified. Existing settings are never changed automatically |
| `mode` | `preserve` for automatic file translation. `redesign` is supported up to the design and trial prompts |
| `phasePolicy` | `strict` for new installs. Unset in existing ones keeps legacy behavior; `phase init` from the skill enables ordered phases without changing the config |
| `models` | IDs for implementer, reviewer-semantics, reviewer-rules, arbiter and fixer, chosen by the person from `models list` and recorded with `models set` |
| `reasoningEfforts` | Optional per-role reasoning effort (`low` to `max`, as the model supports); unset means the model's default. Passed to workers as `--reasoning-effort`. Like models, a change makes reviewed units be reviewed again |
| `phaseModels` | Explicit host models for rulebook, judgeAudit, dependencyAudit, inventoryAudit, stressA/B, stressInspector and designAudit. Preparation audits run in the parent and are never inherited by the automatic runner |
| `designInputs` | Design documents included in full in the frozen input and protected. A link alone does not count as the body. This does not enable a redesign module runner |
| `packageMap` | Optional source→target package declaration JSON. When set, phase 01 records a separate package-cycle audit |
| `markerPolicy` | `todo-lines-v1` for new installs: the number of lines with TODO(port) must match the trailer's todos. Existing projects without it keep the old contract |
| `workerBackend` | `copilot-cli` only (may be omitted). The native backend was removed in 0.3.0 |
| `concurrency` | Concurrent AI calls, 4 for new installs, at most 64, both reviews included. CLI workers are separate processes, so the account's rate limits, not Copilot's subagent concurrency, are the practical limit |
| `dependencyOrder` | `auto` (new installs): hold a dependent until its dependencies have reviewed receipts only when a per-unit typecheck needs them; without one the approved scope fans out as upstream does. `reviewed` (unset, existing configs): always wait. `none`: never wait (not combinable with a typecheck) |
| `fixPolicy` | `single-pass` (new installs): as in upstream Step 3, one fix of the confirmed findings completes the unit and build/smoke/parity judge it; fewer calls and fewer blocked units. `rereview` (an existing configuration without the key): review a fixed output again until no confirmed finding remains |
| `reviewFocus` | `shared` (new installs): both reviewers check source behavior and rule adherence, each from its own lens first, and report every defect either check finds; they never see each other's output. `specialized` (unset, existing configs): one check each, as upstream |
| `executionMode` | Defaults to `continuous`, including old configurations without the key. Saved time/call/fix/input/retry limits do not interrupt work. Only the person choosing `bounded` enables those limits; `doctor` names any written limit that continuous mode does not enforce. See [all interruption conditions](docs/INTERRUPTION-POLICY.en.md) |
| `maxFixRounds`, `maxAgentCalls` | Per-unit fix rounds and per-run AI calls, enforced only in bounded mode. Continuous mode ignores them. An explicitly chosen `translate --max-calls N` is still a finite budget for that command |
| `maxRunInputBytes` | Optional cumulative prompt-byte cap in bounded mode only. Normal execution records usage without stopping on volume |
| `maxAiCreditsPerCall` | Optional `--max-ai-credits` for bounded workers only (CLI minimum 30). Continuous mode does not pass it. Service/account limits remain external |
| `transientRetries`, `transientRetryDelayMs` | Retry rate limits, 5xx and network failures with backoff (5 seconds initially, up to 60). Continuous mode has no retry-count stop; bounded mode defaults to two retries |
| `maxConsecutiveFailures` | Stop new dispatch after consecutive failures (default 3) in bounded mode only. Continuous mode still processes independent units. Authentication/credits and other actual shared failures are reported |
| `timeoutSeconds` | CLI call deadline in bounded mode only; 0 means no deadline. Normal execution ignores legacy values such as 600 |
| `commandTimeoutSeconds` | Build/comparison deadline in bounded mode only; 0 means no deadline. CPU, silence and elapsed time do not interrupt normal work |

`commands` are argument arrays, not shell strings. Put pipes or several commands in a separate script, and configure only commands you trust.

Sources and targets listed in the manifest are always tracked, even inside excluded directories. Main dependency/build files at the root and repository files named directly in command arguments are also tracked automatically, including files such as `migration/build.mjs`. Add indirectly loaded scripts and nested settings to `verificationInputs` and check the list in `doctor`; files like `migration/build-settings.json` can be listed explicitly. The generated `migration/state`, `results`, `gates`, `runs` and `run.lock` cannot be used as command files or `verificationInputs`. Changes to external tools or environment variables are not detected; after an environment change, re-validate from judge.

When a command argument also names an output, declare the output directory in `buildArtifactRoots`. For `cc -c native/shim.c -o artifacts/shim.o`, set `"buildArtifactRoots": ["artifacts"]`: the input `native/shim.c` stays tracked, and creating, deleting or regenerating outputs is not an input change. Output options like `-o` mean different things per tool, so they are never inferred. An undeclared output file may be treated as an input once created and stop validation.

Artifact directories cannot overlap original sources, translated sources, verification roots, explicit inputs or the kit's managed areas. Keep the settings and scripts that are actually loaded outside them and register them in `verificationInputs` as needed. `doctor` lists inputs and artifact directories separately. Artifact contents are not part of approval hashes, so validate them with the build, smoke and parity commands. Recognized inline Node/Python/POSIX shell code is not treated as a file, but FILE in `cc -c FILE` and `node -c FILE` is tracked.

The review input contains the unit's original file and the transitive closure of its declared dependencies, the candidate file, the whole RULEBOOK, the matching inventory rows plus global notes, and any diagnostic. Both reviewers get the same content and no tools. Inventory rows are selected by an exact repository-relative match on the leading `file` column. A UTF-8 BOM at the start of the file is removed once before comments, blank lines and the header are detected. Malformed rows or unknown leading columns stop the run. Shift_JIS, EUC-JP, Latin-1 and UTF-16 inputs are decoded and named with their `encoding` (the original is never rewritten); binary files with NUL bytes stop the run by name. Static sources are also checked before implementer and fixer calls. Integration with other translated files is checked by build/smoke/parity. A unit over the limit does not stop: it switches automatically to **tool-assisted review**. Both reviewers receive the same "file list with SHA-256" instead of contents, and read-only `reviewer-*-read` profiles read the files. A hook keeps other workers' records (`migration/runs` and so on) out of reach. Because this guarantees less independence than a frozen input, it is recorded in `reviewInputMode`, the run's `toolAssistedReviews` and `warnings`, and shown in phase reports. The full source scan for change tracking is kept.

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

Bundled mappers cover Python, JS/TS, C/C++, C#, Java, VB.NET, PHP and COBOL; all of them only read source (the original is never run). [Dependency mappers](docs/DEPENDENCY-MAPPERS.en.md) lists each command and how to write an adapter for another language.

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

This is the bundled fixture's example; replace it with your project's commands. On Windows use `py` (with `"-3"` as the first argument) or `python` instead of `python3`. `mutation` exits 0 when the comparator detects a deliberately broken implementation. Keep `typecheck` to a cheap check that is valid before the whole tree is translated, or set it to `null`.

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

## Delegating preparation reading by scope

Phase 00 reads a sample of the source directly, as upstream does, and reports what it skipped (survey is optional there). In 00b (source-as-spec) and 02, which must cover every file, instead of the parent reading every file itself, `survey run --kind facts|contracts|inventory` splits the source into scopes and hands each to a fresh surveyor (a new `copilot` process). Results are saved as files under `migration/surveys/`; `survey merge` builds the draft. Interrupted runs resume with the remaining scopes. See [preparation surveys](docs/SURVEYS.en.md).

## Working through the phases

Before phase 03, install the command guardrails `migration/guardrails.json`. They replace the upstream `.claude/settings.json` deny rules: a hook denies matching shell commands in every agent session (builds run by the runner are not affected). Installing them is the human's decision: the AI proposes a deny list (or a waiver with its reason) in chat from `run_migration.mjs guardrails show`, adapted to the target's build and test commands. Once you agree, it runs `guardrails install`, and the host asks you to confirm; that confirmation is your act. The hook denies the AI writing the file directly. `phase start 03` / `04` stops without this file (or a recorded waiver). When you drive the migration from an interactive Copilot CLI session, its repository-copy hook loads only in a trusted folder; `doctor` checks this (runner-started workers always load it).

Name the phase from the table below to the orchestrator, for example "continue with the comparator design", and review each phase's artifacts. The procedure the orchestrator reads (the skill) links every phase prompt. The entry point is the same in VS Code Copilot (Agent Host) and Local. The Local `/migrate-…` prompt files of 0.6.0 and earlier were removed in 0.7.0.

At start or resumption, the parent orchestrator registers the ten phases below in Copilot's TODO list and shows running, awaiting approval, revising and stopped states; initial setup is listed separately. Each phase ends with progress such as "5/10 phases complete, next: awaiting approval for 04", and on resumption the list is reconciled with the actual artifacts and validation records. Where no TODO tool exists, the same list is shown in chat. See [phase TODO tracking](docs/PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list).

The table and the CLI examples that follow are for **runtime mode**. In [source-only mode](docs/SOURCE-ONLY.md), 00b prepares a source-derived judge plan, 05c is shown as unverified and not run, and after a successful 05b the 06 handoff is approved and recorded.

| Phase | Prompt | Main artifacts |
|---|---|---|
| Feasibility and scope | [00-feasibility](prompts/00-feasibility.md) | `migration/feasibility.md` |
| Comparator design | [00b-judge-setup](prompts/00b-judge-setup.md) | Original tests, comparator, mutation self-check |
| Dependencies | [01-dependency-map](prompts/01-dependency-map.md) | depmap, `migration/manifest.tsv`, `review-dependencies.json` |
| Semantic gaps and policy | [02-gap-inventory](prompts/02-gap-inventory.md) | `migration/RULEBOOK.md`, `inventory.tsv` |
| Stress test | [03-stress-test](prompts/03-stress-test.md) ([checklist](docs/STRESS-TEST-CHECKLIST.en.md)) | `migration/stress-test/report.md` |
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

When the build fails and the person agrees in chat, the AI runs `build-loop` (the host confirms). Normal execution repeats build → diagnose → reviewed repair → rebuild until clean, without default round/call/stalled-count stops. Finite limits apply only when the person explicitly chooses `--max-rounds N`, `--max-calls N` or bounded mode. State the stages and whether any limits apply. Every round's approval is recorded under one grant in `migration/gates/build-loop-<id>.json`; while it runs, `status` shows it and other runner commands are refused. To go one round at a time, run `repair-round`. The bundled parsers (Python, Java/Maven, JavaScript/Node/ESLint/tsc, shell/ShellCheck, Rust and the generic `file:line:col: error` form) read the recorded build output, build a repair queue per manifest target and run the repairs. Lines that map to no manifest target are listed, never guessed. Error counts per round are kept in `migration/build-rounds.tsv`. With `--through smoke` or `--through parity` the same grant also approves and runs smoke (and parity) once the build is clean, sends their failures to reviewed repairs and starts the next round from build (upstream Steps 5-6). A failing original suite, or a failure that maps to no target, stops it instead of being guessed. Without the loop, a fresh build after repairs still needs approval.

```bash
node migration-kit/scripts/run_migration.mjs build-loop --note "Reviewed repairs until the build passes, as agreed"
# Through smoke and parity under the same grant
node migration-kit/scripts/run_migration.mjs build-loop --through parity --note "Reviewed repairs until parity passes, as agreed"
# One round at a time
node migration-kit/scripts/run_migration.mjs repair-round
node migration-kit/scripts/run_migration.mjs approve build --note "Reviewed the repairs"
node migration-kit/scripts/run_migration.mjs build
```

For an unsupported format, name the unit and a diagnostic excerpt yourself:

```bash
node migration-kit/scripts/run_migration.mjs repair \
  --target ported/example.mjs --evidence migration/diagnostic-slice.txt
```

Repairs go through review → arbitration → fixing confirmed findings → re-review. A changed output revokes approvals from the old build onward, so review and approve again. If sources, configuration, rules or the comparator change, re-validate from judge, review the updated stress test and approve translation again. Run limits (`concurrency`, `maxAgentCalls`, `maxFixRounds`, timeouts and retries, `maxRunInputBytes`, `maxAiCreditsPerCall`), documents, phase prompts, skills and Copilot instructions do not reach worker outputs, so changing them keeps reviewed units, phase records and approvals.

Smoke and parity failures take the same path (upstream Step 6). After classifying each divergence against the original, `repair-round --stage smoke|parity` turns output lines that name translated files into a reviewed repair queue. When the comparator reports cases only, write each confirmed regression as `file<TAB>module<TAB>code<TAB>message`, then run `diagnostic_queue.mjs --stage parity --diagnostics migration/PATH.tsv` and `repair --queue`. A failing original suite is inherited or environmental, so the runner refuses to queue it. Repaired outputs need fresh build, smoke and parity approvals.

Even with identical inputs, starting a re-run of build or any other stage revokes downstream results and approvals. After a successful re-run, review, approve and run smoke onward again. Re-running judge restarts from the translation approval.

While a long run is active, check it with `status --fast --wait 600 --format markdown`: this waits for status only, never terminates the worker, and returns at most 600 seconds later or when progress changes; keep monitoring the existing job, which keeps the parent agent's checks (each one an AI call) few. After an interruption, run `translate` again. A normal `translate` re-checks units that were already done at the start and fails unless every unit has valid review records at the end. `repair` succeeds when the named unit is done. A lock left by a crash on the same host is removed by the next command. Only for a lock from another host (shared folder) or a PID reused by another process, confirm that run stopped and use `unlock --pid OWNER_PID`; a live PID on this host cannot be unlocked.

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

The demo replaces worker responses with prepared code and really runs the Python/Node comparison and build. It is not a benchmark of model output quality. Details are in [TESTING.en.md](docs/TESTING.en.md). To compare quality with real models before folding workers together, see [REVIEW-BENCHMARK.en.md](docs/REVIEW-BENCHMARK.en.md).

- The operating rules are language-neutral, but this is not a universal translator that prepares dependency mapping, builds and equivalence checks for every language automatically.
- Large real projects, very large single files, units that rewrite several files as one and automatic redesign are untested or unsupported.
- A CLI response is one JSON object. Worker responses are capped at 16 MiB and are also limited by the model's own output limit.
- Logs record the requested model and timing. With the CLI backend they also record the model the CLI reports in its JSONL (`model.call_final_result`) and usage such as `premiumRequests`; a model different from the request is a run warning. Each call also uses `--usage-output-file`: the CLI's own input, output and cache tokens and AI units (nano AIU) go into `cliUsage`, and the run total into `measuredUsage`. The CLI does not report a conversion to AI Credits, so `aiCredits` stays `null`. Call limits are not spending limits.
- With `--output-format json` the CLI reports rate limits, 5xx and authentication errors only as `session.error` on stdout (stderr is empty). The runner reads it: 429/5xx are retried, authentication and exhausted credits stop the run, and the error message keeps the cause.
- Each CLI worker call is one session (the kit passes no sync flag, so syncing to the GitHub account follows the person's Copilot CLI setting) under `~/.copilot/session-state`; the runner journals its ID in the run records before the call (`cli-sessions.jsonl`, retried and interrupted calls included). The transcripts contain source code, so after the migration the AI reports `sessions status` and, if the person agrees, runs `sessions prune`, which deletes only the kit's worker sessions (the host asks to confirm).
- Parallel workers open many files. The Copilot CLI (Node) raises its own soft open-file limit to the hard limit at startup (256 → hard limit observed on 1.0.98), so the kit needs no wrapper. Only the hard limit cannot be raised that way: `doctor --check-cli` checks it and explains how to raise one below 4096.
- Rate limits (429) and service errors are retried automatically; `status` shows a retrying worker and the AI tells the person.
- Permission restrictions and hooks are workflow controls, not an OS isolation boundary. SDK extensions and configured commands run as local code.
- The old Bash `build_daemon.sh` is kept for compatibility. Do not run it alongside the shared runner; normally use the Node `build` stage.

The upstream records are kept in [UPSTREAM-README.md](docs/UPSTREAM-README.md), [UPSTREAM-CLAUDE.md](docs/UPSTREAM-CLAUDE.md) and the original `RUN-NOTES.md`. See [LICENSE](LICENSE) / [NOTICE](NOTICE) for notices, [OPERATING-MANUAL.md](docs/OPERATING-MANUAL.md) for runtime rules and [CONTRACTS.md](docs/CONTRACTS.md) for JSON formats.

## VS Code orchestration and verification modes

The parent agent's responsibilities (phase TODO, questions, running the commands), the read-only `status --format markdown`, source-only mode and Rubber Duck are described in the [operating manual](docs/OPERATING-MANUAL.md#vs-code-orchestration-and-verification-modes).

## Phase order and usage records

The orchestrator enables the [ten-phase order check](docs/ORDERED-WORKFLOW.en.md) and continues from the first incomplete phase. New configurations use phasePolicy=strict. Missing review records for 00–03 block the formal judge and the real translation. For existing projects, phase records are created by reviewing the actual artifacts in order.

The same [migration/cost-log.tsv](docs/COST-LOG.en.md) as upstream main is produced; usage or models that cannot be obtained are `unknown`. The current `models` setting assigns a model to each of the five worker roles, with the two reviewers as independent profiles. The automatic runner has no per-phase setting for investigators such as 01/02 or for optional review profiles.
