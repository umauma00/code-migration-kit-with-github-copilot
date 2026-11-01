# Detailed usage (settings and commands)

[日本語](REFERENCE.md) | English

This continues the [README](../README.en.md). Normally the orchestrator runs the commands below and you only answer in chat. Read this when you want to change settings yourself or understand the details. For plugin installs, replace `migration-kit/` with the plugin's absolute path.

## Models, reasoning effort and context size

**The person chooses models, reasoning effort and context size.** Install without `--model`, then in the target repository run the commands below: the first reads the models your account can use, each model's selectable efforts (and default), context sizes (prompt limits) and prices from the CLI. Right after installation the AI asks for every role's model from that list in **one question** and records it with `models set --role all` (the person already chose, so the host does not ask); per-role effort and context are changed in the run settings file below. To change models later from chat, the AI asks for every role's model, effort and context in one question and records it with one `models set --assign`. Values changed with `models set` and `preferences` are written to the run settings file too.

```bash
node migration-kit/scripts/run_migration.mjs models list --format markdown
node migration-kit/scripts/run_migration.mjs models set --assign "implementer=MODEL_ID:medium,reviewers=MODEL_ID:high:long_context,arbiter=MODEL_ID,fixer=MODEL_ID"
node migration-kit/scripts/run_migration.mjs models set --role reviewers --model MODEL_ID --effort high
```

`--assign` is one answer: `role=MODEL_ID:EFFORT` entries separated by commas (effort left out = default; `all=ID` first sets every role, and later roles override it). Every entry is checked before writing, so one refused entry changes nothing. `--role` takes a role name, `reviewers` (both reviewers) or `all` (the surveyor drops its own setting and follows the implementer). The surveyor inherits the implementer's model and effort only while it has no model of its own. Prices are the CLI's published token prices, shown as AI Credits per million tokens. `--effort default` returns to the model's default. A model that is not listed or is disabled by policy, or an effort the model does not support, is refused. Listing needs a signed-in Copilot CLI.

For context size, only roles with `:long_context` after the effort run the long context tier (the Copilot CLI's `--context long_context`), and only models whose Context column lists long_context accept it. It costs more, so keep it to the roles that need it. Without it a role runs the default context and workers get no `--context` flag (the CLI's own `contextTier` setting applies). For a single role, `--role ROLE --model ID --context long_context|default` works too. Like model and effort, a change makes reviewed units be reviewed again.

`--models implementer=ID,reviewers=ID,arbiter=ID,fixer=ID` still sets per-role models (unlisted roles use `--model`). As in the upstream model plan, choose by blast radius: reviewers on the largest or a mid model, high-volume implementers on a mid or small model, fixers and the arbiter on a mid model.

## The run settings file (run-settings.json)

**Every first choice is asked as a question, and the answer is written into `migration/run-settings.json`.** You are never asked to type into the file. Setup asks, one question each:

1. **Every role's model**, from the models your account offers (recorded with `models set --role all`).
2. **The target language.** The kit guesses the source language from the files' extensions and asks "The source looks like C# (120 files in src). Which language do you migrate to?" (free text corrects the source; recorded with `settings init --source C# --target TypeScript`, which also fills the source folders from the guess). One source language is migrated: another language of comparable size is pointed out so you pick the main one, and a language with only a few files (such as SQL) is not treated as the source language.
3. **How phases advance**: normal (recommended; each phase waits until its prerequisites are met), relaxed (a missing prerequisite is a warning, you are asked "fix or proceed" each time, and a phase you proceed past is recorded as waived) or auto (relaxed without asking; completions, approvals and waivers are marked auto; for running through in autopilot). Recorded with `preferences --phase-mode` (see [relaxed mode](ORDERED-WORKFLOW.en.md#relaxed-mode) and [auto mode](ORDERED-WORKFLOW.en.md#auto-mode)).
4. **Whether the original program can be built and run here** (recorded with `preferences --original-runtime`). If it cannot, the verification mode becomes `source-only`.
5. **Whether a specification or a test suite the target can use exists** (only when the answer to 4 is no). Without either, setup switches to treating the source as the specification ([source-as-spec](SOURCE-AS-SPEC.en.md)) before phase 00 (the host asks once; not in auto mode).

Where a sandbox stops writes outside the project, setup also asks about it, because phase 03 needs them. With auto mode chosen, every setup question starts with a line saying setup is still manual and about how many confirmations remain, and when setup is done the run stops once before phase 00. Switch to autopilot mode and send "continue" to start phase 00.

The file is for changing settings later (several at once, such as every role's effort), for resuming in another session, and as the record of the conditions a run used. It holds values only: migration languages, folders, verification mode, whether the original can run, execution mode, concurrency, stage commands, and each role's model, effort and context size. Each field's explanation and choices, and your account's models, efforts and context tiers, are in `migration/run-settings.help.md` beside it. Entries not decided yet read `FILL_IN`; the setup questions fill them. After an edit, answer the AI's question "filled in, or do you have a question?". "Filled in" runs `settings apply`, which checks every entry and, if any is wrong, writes nothing and returns every problem (your edited file is the answer, so the host does not ask, except when it switches auto mode on). Applying checks every model entry, so the Copilot CLI must be signed in.

```bash
node migration-kit/scripts/run_migration.mjs settings init
node migration-kit/scripts/run_migration.mjs settings check
node migration-kit/scripts/run_migration.mjs settings apply
```

The values are recorded where they always were, `migration/config.json` (languages, folders, models...) and `migration/preferences.json` (report language, whether the original can run), so changing the report language never revokes approvals. The file stays as the record of the conditions a run used; while an edit is not applied, `status` says so.

## Report language

`--language ja|en` sets the language of phase reports, questions and `status --format markdown`. It is stored in `migration/preferences.json` and never affects approvals or completion. If omitted, the skill asks Japanese or English at the start. Change it later with `run_migration.mjs preferences --language ja`. Until it is set, the hook denies any other question; with `ja` it checks each question's text and choices (`ask_user`, VS Code askQuestions) and asks for a Japanese rewrite. Headers, other questions and \`backticked\` text do not count. Text with hiragana passes as Japanese, even with a path joined to it (`src/main.pyを移行しますか？`); without hiragana, whitespace-separated paths and file names are set aside first, so `Should we migrate 売上集計.java next?` is denied; a choice of two or more English words with no Japanese is denied (a one-word name such as `Java` passes). This is a character-class check, not language detection: an English sentence containing a name with hiragana still passes.

## What a copy install puts in the repository

Scripts and documents go to `migration-kit/` in the target, and the Copilot entry points to `.github/`. A managed block is appended to existing Copilot instructions. Existing files with different content are never overwritten (the installer stops), and an existing `migration/config.json` is kept. Re-running with the same content changes nothing.

To use VS Code **Local** hooks, add `--harness vscode-local` to both commands; its event format differs from the standard `copilot` one. The option only selects which hook format is installed and does not switch the VS Code session: pick **Local** in the chat's Session Target. In VS Code 1.144 Local is hidden by default (the settings that show it are in the [VS Code docs](https://code.visualstudio.com/docs/agents/run/agent-harnesses)) and is not available in the Agents window. The plugin install uses the Copilot harness (the default). CLI workers also restrict tools on their command line.

## Checking the installation (doctor)

Run everything below from the target repository root.

```bash
node migration-kit/scripts/run_migration.mjs doctor --check-cli
```

`doctor` checks the configuration, profiles, CLI version and required options. It also starts the CLI with the same arguments and environment as the workers and proves that every worker agent resolves (no AI calls). The dependency declaration created in phase 01 shows as `pending`, not failed, until phase 01 is recorded; after that a missing declaration fails. It then runs the real CLI against a local loopback model (no account, network or AI usage) and proves that the hook keeps a tool-assisted reviewer out of `migration/runs`. Loading that hook relies on the undocumented `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS` variable, so this check fails if a CLI update stops honoring it (verified on CLI 1.0.98 and 1.0.100-1). It does not guarantee model availability or that hooks run in interactive sessions.

## migration/config.json entries

The minimum settings in `migration/config.json`:

| Setting | Meaning |
|---|---|
| `sourceRoots` | Protected original sources, e.g. `["src"]` |
| `outputRoots` | Translated **sources**, e.g. `["ported"]`. Put build products elsewhere |
| `verificationRoots` | Comparators, tests and test data, e.g. `["tests"]` |
| `verificationInputs` | Extra build/dependency settings whose changes are tracked, e.g. `["build/config.json", "packages/api/tsconfig.json"]` |
| `buildArtifactRoots` | Directories where commands write binaries, objects and reports, e.g. `["artifacts", "dist"]`. Defaults to an empty array |
| `maxReviewInputBytes` | JSON size limit of the frozen review input; new installs use 1048576 bytes (1 MiB, roughly 260k–360k tokens). The implementer and fixer get the same input (0.29.0). When the reviewer, implementer or fixer model's "Context (prompt limit)" in `models list` is smaller, lower it to fit that limit (for example 655360 or less for 272K), older configs keep their value and an omitted key means 65536. An oversized unit switches automatically to tool-assisted review (below) |
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
| `markerPolicy` | `todo-lines-v1` for new installs: the number of lines with TODO(port) must match the trailer's todos. The trailer goes after the last closing brace as `// PORT STATUS: confidence=medium todos=2` (a bracketed `todos=[2]` counts the same). Existing projects without it keep the old contract |
| `workerBackend` | `copilot-cli` only (may be omitted). The native backend was removed in 0.3.0 |
| `concurrency` | Concurrent AI calls, 4 for new installs, at most 64, both reviews included. CLI workers are separate processes, so the account's rate limits, not Copilot's subagent concurrency, are the practical limit |
| `dependencyOrder` | `auto` (new installs): hold a dependent until its dependencies have reviewed receipts only when a per-unit typecheck needs them; without one the approved scope fans out as upstream does. `reviewed` (unset, existing configs): always wait. `none`: never wait (not combinable with a typecheck) |
| `fixPolicy` | `single-pass` (new installs): as in upstream Step 3, one fix of the confirmed findings completes the unit and build/smoke/parity judge it; fewer calls and fewer blocked units. `rereview` (an existing configuration without the key): review a fixed output again until no confirmed finding remains |
| `reviewFocus` | `shared` (new installs): both reviewers check source behavior and rule adherence, each from its own lens first, and report every defect either check finds; they never see each other's output. `specialized` (unset, existing configs): one check each, as upstream |
| `executionMode` | Defaults to `continuous`, including old configurations without the key. Saved time/call/fix/input/retry limits do not interrupt work. Only the person choosing `bounded` enables those limits; `doctor` names any written limit that continuous mode does not enforce. See [all interruption conditions](INTERRUPTION-POLICY.en.md) |
| `maxFixRounds`, `maxAgentCalls` | Per-unit fix rounds and per-run AI calls, enforced only in bounded mode. Continuous mode ignores them. An explicitly chosen `translate --max-calls N` is still a finite budget for that command |
| `maxRunInputBytes` | Optional cumulative prompt-byte cap in bounded mode only. Normal execution records usage without stopping on volume |
| `workerCopilotHome` | Defaults to `separate`: the kit's Copilot CLI workers run in `~/.copilot-migration-kit-workers`, next to `~/.copilot`, and do not share the person's sessions and session index (sign-in, settings and plugins stay the person's). If the CLI is not signed in there, workers fall back to `~/.copilot`. `shared` always uses `~/.copilot` |
| `maxAiCreditsPerCall` | Optional `--max-ai-credits` for bounded workers only (CLI minimum 30). Continuous mode does not pass it. Service/account limits remain external |
| `transientRetries`, `transientRetryDelayMs` | Retry rate limits, 5xx and network failures with backoff (5 seconds initially, up to 60). Continuous mode has no retry-count stop (except 5 retries for the Copilot CLI's internal event stall); bounded mode defaults to two retries |
| `maxConsecutiveFailures` | Stop new dispatch after consecutive failures (default 3) in bounded mode only. Continuous mode still processes independent units. Authentication/credits and other actual shared failures are reported |
| `timeoutSeconds` | CLI call deadline in bounded mode only; 0 means no deadline. Normal execution ignores legacy values such as 600 |
| `commandTimeoutSeconds` | Build/comparison deadline in bounded mode only; 0 means no deadline. CPU, silence and elapsed time do not interrupt normal work. The model-tool probes of `doctor --check-cli` and `stress-b command` use this deadline in bounded mode; in continuous mode or when it is 0 they stop after 2 minutes. Either way an unanswered probe reports the tools as unverified |

## Validation commands (commands)

`commands` are argument arrays, not shell strings. Put pipes or several commands in a separate script, and configure only commands you trust.

The example below is for the default **runtime mode**. Projects without a usable original environment use [source-only mode](SOURCE-ONLY.md).

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

## Tracked inputs and build artifacts

Sources and targets listed in the manifest are always tracked, even inside excluded directories. Main dependency/build files at the root and repository files named directly in command arguments are also tracked automatically, including files such as `migration/build.mjs`. Add indirectly loaded scripts and nested settings to `verificationInputs` and check the list in `doctor`; files like `migration/build-settings.json` can be listed explicitly. The generated `migration/state`, `results`, `gates`, `runs` and `run.lock` cannot be used as command files or `verificationInputs`. Changes to external tools or environment variables are not detected; after an environment change, re-validate from judge.

When a command argument also names an output, declare the output directory in `buildArtifactRoots`. For `cc -c native/shim.c -o artifacts/shim.o`, set `"buildArtifactRoots": ["artifacts"]`: the input `native/shim.c` stays tracked, and creating, deleting or regenerating outputs is not an input change. Output options like `-o` mean different things per tool, so they are never inferred. An undeclared output file may be treated as an input once created and stop validation.

Artifact directories cannot overlap original sources, translated sources, verification roots, explicit inputs or the kit's managed areas. Keep the settings and scripts that are actually loaded outside them and register them in `verificationInputs` as needed. `doctor` lists inputs and artifact directories separately. Artifact contents are not part of approval hashes, so validate them with the build, smoke and parity commands. Recognized inline Node/Python/POSIX shell code is not treated as a file, but FILE in `cc -c FILE` and `node -c FILE` is tracked.

## Review input and worker isolation

The review input contains the unit's original file and the transitive closure of its declared dependencies, the candidate file, the whole RULEBOOK, the matching inventory rows plus global notes, and any diagnostic. Both reviewers get the same content and no tools. Inventory rows are selected by an exact repository-relative match on the leading `file` column. A UTF-8 BOM at the start of the file is removed once before comments, blank lines and the header are detected. Malformed rows or unknown leading columns stop the run. Shift_JIS, EUC-JP, Latin-1 and UTF-16 inputs are decoded and named with their `encoding` (the original is never rewritten); binary files with NUL bytes stop the run by name. The implementer and fixer get the same input from the runner (the implementer without the candidate's content) and run without tools when it fits; over the limit they get the same "file list with SHA-256" and the matching inventory rows and read only the listed files, never the whole inventory. Integration with other translated files is checked by build/smoke/parity. A unit over the limit does not stop: it switches automatically to **tool-assisted review**. Both reviewers receive the same "file list with SHA-256" instead of contents, and read-only `reviewer-*-read` profiles read the files. A hook keeps other workers' records (`migration/runs` and so on) out of reach. Because this guarantees less independence than a frozen input, it is recorded in `reviewInputMode`, the run's `toolAssistedReviews` and `warnings`, and shown in phase reports. The full source scan for change tracking is kept.

All five CLI workers start a new process with `--no-custom-instructions`. This stops automatic injection of `AGENTS.md` and repository or personal Copilot instructions, so workers use only their role profile and the runner's contract. Put project-specific porting policy into the approved `migration/RULEBOOK.md` and inventory; changing implicit instruction files does not change worker behavior. Normal interactive sessions still use Copilot instructions.

## Dependency declaration (review-dependencies.json)

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

Bundled mappers cover Python, JS/TS, C/C++, C#, Java, VB.NET, PHP and COBOL; all of them only read source (the original is never run). [Dependency mappers](DEPENDENCY-MAPPERS.en.md) lists each command and how to write an adapter for another language.

The JSON format is `{"schemaVersion":1,"dependencies":{"src/a.py":["src/b.py"],"src/b.py":[]}}`. Without `--depmap-root`, the single `--source-root` is the mapping root, so older commands still work. Enumeration is limited to the given source roots, and isolated files get `[]`. Edges that start outside the scope (for example tests → pkg) are dropped and listed under `ignoredEdges` on stdout. A dependency from a source in scope to one outside (for example pkg → shared) stops the command and asks for the missing root. Audit the mapper's supported syntax, exclusions, unresolved imports and dropped edges, and add semantic references needed for inventory evidence. With several mapping roots, generate separate `--out migration/PATH.json` files and merge them into one map. Missing keys or files in a required closure stop the run. Changing the map or explicit dependencies revokes approvals and completion records.

## The manifest

The manifest is a tab-separated file with two columns, `source` and `target`: one source file to one target file. Duplicate outputs, overwriting original sources and symlinks inside managed paths are rejected. Overlap with protected roots is also checked against existing parents and file identities, and case-only aliases of the same file are rejected. Targets are checked again right before they are written. The languages the bundled mappers cover, and how to write an adapter for another one, are in [dependency mappers](DEPENDENCY-MAPPERS.en.md).

## Running the phases one stage at a time

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

Repairs go through review → arbitration → fixing confirmed findings (re-review only with `fixPolicy: rereview`). A changed output revokes approvals from the old build onward, so review and approve again. If sources, configuration, rules or the comparator change, re-validate from judge, review the updated stress test and approve translation again. When only the rules change after 02, check the change and the files it may touch with `rulebook changes`, and accept it with `rulebook accept --note TEXT --redo listed|all|none|PATH,...`: phase records, approvals and the other finished units stay, and only the chosen units are reviewed again ([steps](ORDERED-WORKFLOW.en.md#rulebook-amendment)). A kit (plugin) update does not revoke approvals or completion records either. Run limits (`concurrency`, `maxAgentCalls`, `maxFixRounds`, timeouts and retries, `maxRunInputBytes`, `maxAiCreditsPerCall`), documents, phase prompts, skills and Copilot instructions do not reach worker outputs, so changing them keeps reviewed units, phase records and approvals.

Smoke and parity failures take the same path (upstream Step 6). After classifying each divergence against the original, `repair-round --stage smoke|parity` turns output lines that name translated files into a reviewed repair queue. When the comparator reports cases only, write each confirmed regression as `file<TAB>module<TAB>code<TAB>message`, then run `diagnostic_queue.mjs --stage parity --diagnostics migration/PATH.tsv` and `repair --queue`. A failing original suite is inherited or environmental, so the runner refuses to queue it. Repaired outputs need fresh build, smoke and parity approvals.

Even with identical inputs, starting a re-run of build or any other stage revokes downstream results and approvals. After a successful re-run, review, approve and run smoke onward again. Re-running judge restarts from the translation approval.

While a long run is active, check it with `status --fast --wait 600 --format markdown`: this waits for status only, never terminates the worker, and returns at most 600 seconds later or when progress changes; keep monitoring the existing job, which keeps the parent agent's checks (each one an AI call) few. After an interruption, run `translate` again. A normal `translate` re-checks units that were already done at the start and fails unless every unit has valid review records at the end. `repair` succeeds when the named unit is done. A lock left by a crash on the same host is removed by the next command. Only for a lock from another host (shared folder) or a PID reused by another process, confirm that run stopped and use `unlock --pid OWNER_PID`; a live PID on this host cannot be unlocked.

## Optional: Dynamic Workflows

Adding `--with-workflow` to the install command also installs `.github/extensions/code-migration/extension.mjs`. It registers the stages with the SDK's `defineWorkflow` / `joinSession`, and workers start through the same adapter as the normal CLI path. `ctx.agent`, which inherits the host session's context, is not used. Resumption, approvals and completion use the runner's records.

```bash
copilot --experimental --allow-tool read workflow run code-migration --args '{"stage":"translate"}'
```

The CLI must load it as a trusted extension. See [Dynamic Workflows](DYNAMIC-WORKFLOWS.md). **This is an experimental entry point and is untested in a real CLI session.** One workflow run executes one stage; the next stage needs its own approval.

## Limitations and cautions

- The operating rules are language-neutral, but this is not a universal translator that prepares dependency mapping, builds and equivalence checks for every language automatically.
- Large real projects, very large single files, units that rewrite several files as one and automatic redesign are untested or unsupported.
- A CLI response is one JSON object. Worker responses are capped at 16 MiB and are also limited by the model's own output limit.
- Logs record the requested model and timing. With the CLI backend they also record the model the CLI reports in its JSONL (`model.call_final_result`) and usage; a model different from the request is a run warning. Each call also uses `--usage-output-file`: the CLI's own input, output and cache tokens and AI units (nano AIU) go into `cliUsage`, and the run total into `measuredUsage`. `usage --format markdown` shows the kit-wide total (translation, repair, survey and preparation audits; see [COST-LOG](COST-LOG.en.md#kit-wide-usage)). The CLI does not report a conversion to AI Credits, so `aiCredits` stays `null`. Call limits are not spending limits.
- With `--output-format json` the CLI reports rate limits, 5xx and authentication errors only as `session.error` on stdout (stderr is empty). The runner reads it: 429/5xx are retried, authentication and exhausted credits stop the run, and the error message keeps the cause.
- Each CLI worker call is one session (the kit passes no sync flag, so syncing to the GitHub account follows the person's Copilot CLI setting) under the worker home `~/.copilot-migration-kit-workers/session-state` (`~/.copilot/session-state` with `workerCopilotHome: "shared"` and in earlier versions); the runner journals its ID in the run records before the call (`cli-sessions.jsonl`, retried and interrupted calls included). The transcripts contain source code, so after the migration the AI reports `sessions status` and, if the person agrees, runs `sessions prune`, which deletes only the kit's worker sessions (the host asks to confirm).
- Parallel workers open many files. The Copilot CLI (Node) raises its own soft open-file limit to the hard limit at startup (256 → hard limit observed on 1.0.98), so the kit needs no wrapper. Only the hard limit cannot be raised that way: `doctor --check-cli` checks it and explains how to raise one below 4096.
- Rate limits (429) and service errors are retried automatically; `status` shows a retrying worker and the AI tells the person.
- Permission restrictions and hooks are workflow controls, not an OS isolation boundary. SDK extensions and configured commands run as local code.
- The old Bash `build_daemon.sh` is kept for compatibility. Do not run it alongside the shared runner; normally use the Node `build` stage.
