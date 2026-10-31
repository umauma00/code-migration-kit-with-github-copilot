# Upgrading (0.34.0 and earlier releases)

[日本語](UPGRADING.md) | English

## 0.34.0 (workers run in a Copilot CLI home of their own)

The kit's files (lib, scripts) change, so existing approvals and completion records are revoked once. Record them again as `phase next` lists under `stale`.

1. The Copilot CLI workers the kit starts use `~/.copilot-migration-kit-workers`, next to the person's `~/.copilot`. They no longer write into the person's session index (session-store.db), which on the reporting PC held thousands of sessions, so the 120 s stall should become rarer.
2. Sign-in, settings and plugins stay the person's (settings files are copied, plugin and agent folders are linked). The person's sessions, index and logs are not brought in.
3. If the CLI says it is not signed in there, the call is repeated in the person's `~/.copilot` and the rest of the run stays there: no stop, a warning in the run report.
4. To keep the old behavior (everything in `~/.copilot`), set `"workerCopilotHome": "shared"` in `migration/config.json`. It is a run setting, so reviewed work and approvals are kept.
5. `sessions status` and `sessions prune` look in both homes.
6. For copy installs, replace all of `migration-kit/` with the staged copy. Plugins only need the update.

## 0.33.0 (the 120 s stall and network errors recognized correctly)

Kit files (lib) change, so existing approvals and completion records expire once. Record them again as `phase next` shows in `stale`.

1. The Copilot CLI's "session host did not complete the ... event within 120s" (the wording recorded on Windows) is recognized as a stall, and the same call is retried up to 5 times. Before, the kit did not recognize it and left the file unfinished on the first stall.
2. A network error (ETIMEDOUT and similar) followed by the CLI's sign-in help no longer stops the whole run as a sign-in problem; the call is retried (up to 5 times per call), and the guidance is a rerun and a proxy and sign-in check instead of `copilot login`.
3. No settings change is needed. Restart a stopped pilot from its preparation after the update.
4. A repository copy replaces the whole `migration-kit/` with the staged copy. The plugin installs with the update alone.

## 0.32.0 (one AI call at a time for new installs)

Kit files (lib, templates) change, so existing approvals and completion records expire once. Record them again as `phase next` shows in `stale`.

1. New installs get `concurrency` 1 instead of 4. Existing configurations keep their value.
2. When the Copilot CLI keeps stalling on its 120 s wait on a busy computer, set `concurrency` to 1 in `migration/run-settings.json` and run `settings apply` (run `settings init` first if that file does not exist). It is a run limit, so reviewed work and approvals are kept.
3. When runs pass at 1, raise it step by step (2, then 4) for speed.

## 0.31.0 (a Japanese report language gives a Japanese rulebook)

Kit files (lib, scripts, templates) change, so existing approvals and completion records expire once. Record them again as `phase next` shows in `stale`.

1. With the report language ja, initialization starts `migration/RULEBOOK.md` from the Japanese template (`templates/RULEBOOK.ja.md`), and the orchestrator writes its prose in Japanese. Code, identifiers, paths, tags such as `construct: NAME` and markers such as `TODO(port):` keep their exact form.
2. An existing rulebook is never rewritten. Translating one that already holds rules revokes every approval; to read it in Japanese during a run, ask the orchestrator for a summary.
3. Only new projects start from the Japanese template. No setting changes.
4. In a copy install, replace all of `migration-kit/` with the temporary install's. The plugin needs only an update.

## 0.30.0 (doctor always finishes)

Kit files (lib, scripts) change, so existing approvals and completion records expire once. Record them again as `phase next` shows in `stale`.

1. Each process `doctor` starts for a check (including the hook response check) now ends after 180 s. When the Copilot CLI got no answer (for example from a proxy that does not respond), continuous mode used to wait for hours. Doctor now names the check that did not finish, the time, and the usual causes (proxy, a sign-in waiting for input, a blocked network), and ends. Deadlines for migration work (translation, builds) are unchanged.
2. The checks that point the CLI at a loopback model provider add `127.0.0.1,localhost` to `NO_PROXY` for that CLI only. Behind a corporate proxy, no manual `NO_PROXY` change is needed; the person's environment is not changed.
3. No setting changes. In bounded mode an explicit `commandTimeoutSeconds` below 180 s is used instead; it never lengthens the deadline. The model-tools probes now wait 180 s instead of 120 s.
4. In a copy install, replace all of `migration-kit/` with the temporary install's. The plugin needs only an update.

## 0.29.0 (the runner hands the implementer its evidence)

Kit files (lib, scripts) change, so existing approvals and completion records expire once. Record them again as `phase next` shows in `stale`.

1. The implementer and fixer receive the rulebook, this unit's inventory rows, the source and its dependencies from the runner. Within the limit they run without file tools; over it they read only the listed files. They no longer open the whole inventory.
2. No setting changes. The limit is still `maxReviewInputBytes`. Implementer and fixer prompts grow by that evidence, so their models must hold it, as the reviewer models already do, and bounded runs reach `maxRunInputBytes` sooner.
3. In a copy install, replace all of `migration-kit/` with the temporary install's. The plugin needs only an update.

## 0.28.0 (no stop on the CLI's internal wait)

Kit files (lib) change, so existing approvals and completion records expire once. Record them again as `phase next` shows in `stale`.

1. A worker whose Copilot CLI ends with "Session host did not acknowledge 'assistant.reasoning' delivery within …" is retried instead of blocked (continuous mode: up to 5 times per call; bounded mode: the lower of `transientRetries`, default 2, and 5). No setting that lengthens the 120 s wait was found in CLI 1.0.105 or the kit.
2. A file that still does not pass stays unfinished: run the same command again, or try a lower `concurrency`. That change keeps approvals.
3. In a copy install, replace all of `migration-kit/` with the temporary install's. The plugin needs only an update.

## 0.27.0 (questions anyone can answer)

Kit files (lib, scripts, agent definitions) change, so existing approvals and completion records expire once. Record them again as `phase next` shows in `stale`.

1. A phase-03 pilot first runs the read-only `pilot plan --sources …` for the final file count (chosen files plus the files they use) and asks once with that count. `pilot prepare --expect-total N` stops when the scope no longer matches it.
2. A question-writing rule (docs/PHASE-HANDOFF.md) and a plain-words table (docs/PLAIN-WORDS.md) are added. The failure-guidance choices and the sandbox question no longer use kit terms or commands.
3. In a copy install, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md` and the SKILL.md in `.github/skills/` with the temporary install's. The plugin needs only an update.

## 0.26.0 (why a phase record is out of date, and what to do)

Kit files (plugin.json, scripts) change, so existing approvals and completion records expire once. From this release `phase next` explains it in `stale`. Records of 02 onward made before it have no breakdown: when no settings, verification or outside-source file was written after the record, the kit update is the cause and the action is `record-again`; otherwise it is `redo`.

1. `phase next`, `phase check` and the phase gate error name what changed after the record (its files, the sources or settings, the predecessor's record, and for 02 onward which part of the approved inputs) and the next step: `record-again` when only the phase's recorded files, an earlier record or the kit changed (check that change and record again, not a new review of the whole phase), `redo` when sources, settings, commands or verification files changed (rework what changed), with the exact `phase complete` command and the later phases to record again.
2. `status --fast` still does not hash, but marks a phase whose recorded files were written after its record and points to `phase next`.
3. The orchestrator follows `stale.next`: auto mode records again (or redoes) without asking; other modes ask once, recommending it. It never asks about the difference between the two views.
4. In a copy install, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md`, the SKILL.md in `.github/skills/` and the kit's section of `.github/copilot-instructions.md` with the temporary install's. The plugin needs only an update.

## 0.25.0 (per-model tool check)

Kit files (plugin.json, scripts) change, so existing approvals and completion records expire once. Revalidate from judge. Completed outputs are kept.

1. Run phase 03 comparison B with the command `stress-b command --dir DIR` writes. It lists only the file tools that model has (no AI usage).
2. `doctor --check-cli` checks that tool-assisted reviewers' models have reading and search tools and that B's model has a writing tool.
3. For a copied install, replace all of `migration-kit/` and the SKILL.md files in `.github/skills/` with the temporary install's. A plugin only needs updating.

## 0.24.0 (comparison B writes, and a local sandbox found during setup)

Kit files (plugin.json, scripts) change, so existing approvals and completion records expire once. Revalidate from judge. Completed outputs are kept.

1. Phase 03 comparison B's command adds `apply_patch`, so B writes with models that edit only through `apply_patch` (such as gpt-6-luna). For a phase 03 in progress, rerun B with the checklist's new command.
   The hook is fixed too: it denies `apply_patch` writes to `migration/guardrails.json`, and tool-assisted reviewers can use `grep`, `rg` and `glob` again (CLI 1.0.105 passes their targets as `paths`).
2. `doctor` gains the check `commands can write outside the project and use loopback`. It fails in a session with local sandboxing on and suggests `/sandbox off` or allowing the locations in the sandbox settings. The kit never changes them.
3. During setup, `settings apply` returns `sandboxQuestion` when it finds a sandbox and asks before phase 00 and the switch to autopilot (on each apply during setup until it is resolved). For a project already past setup, run `doctor` before phase 03.
4. For a copied install, replace all of `migration-kit/` and the SKILL.md files in `.github/skills/` with the temporary install's. A plugin only needs updating.

## 0.23.0 (one repair round, generated code and policies before the survey, faster phase next)

The kit files (plugin.json, scripts) change, so existing approvals and completion records expire once. Revalidate from judge. Completed outputs are kept.

1. Preparation audits and independent reviews in 00b–02 (the source-as-spec package review included) get one repair round in every mode, as upstream: confirm findings against the source, fix them and re-review only the fixed items once.
2. What is still open is not fixed again: inventory rows become UNKNOWN (most conservative translation plus TODO(port)), other findings stay as open limitations in judge-report.md or depmap/report.md. The phase report lists the fixed findings, the open ones with evidence and the rows made UNKNOWN (with counts); the person decides at the phase gate (in auto mode the list goes into the record's note and the run continues).
3. The 02 joint RULEBOOK/inventory audit is not re-run after its fixes, as upstream. Sampling audits of a hand-written dependency graph keep their three rounds.
4. Before the 02 inventory survey run `preparation_cli.mjs generated-files --write` and `policy-questions`. Sites in generated files become GENERATED rows without a model; report counts only. They are translated as ordinary code, and only files the person chose to regenerate with a target generator are regenerated (build approval waits until the target exists). Ask the policy questions once together and record answers with `policy-record` in the RULEBOOK's managed block (auto mode: the most conservative option).
5. Before the full survey, `rulebook-coverage --sites PATH` and `survey run --kind inventory --sites PATH --trial 3` show constructs without a rule and constructs that come back mostly UNKNOWN. In a project already surveyed, a RULEBOOK change means the inventory survey runs again.
6. `phase next` and `status` are faster on large projects (no configuration change).
7. In a copy install, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md`, the SKILL.md in `.github/skills/` and the kit's section of `.github/copilot-instructions.md` with the temporary install's. The plugin needs only an update.

## 0.22.0 (kit-wide AI usage)

Kit files (plugin.json, scripts) change, so existing approvals and completion records expire once. Revalidate from judge. Completed outputs are kept.

1. Each worker call's usage is recorded in `migration/runs/usage/calls.jsonl`, and `usage --format markdown` shows the kit-wide total. Recording starts with this release, so earlier calls are not included.
2. Survey run reports carry `measuredUsage`, and survey rows in cost-log.tsv get `tokens`.
3. For a copied install, replace all of `migration-kit/` and the SKILL.md files in `.github/skills/` with the temporary install's. A plugin only needs updating.

## 0.21.0 (1 MiB default for the frozen review input)

The plugin version changes, so existing approvals and completion records expire once. Revalidate from judge. Completed outputs are kept.

1. New installs set `maxReviewInputBytes` to 1048576 (1 MiB, roughly 260k–360k tokens). Existing `migration/config.json` files are not changed.
2. To raise it in an existing project, edit `migration/config.json`. It is part of the config fingerprint, so phase 02 onward and approvals are reviewed again. When the reviewer model's "Context (prompt limit)" in `models list` is smaller (for example 272K), lower it to fit that limit (655360 or less for 272K); a frozen input over the model's prompt limit cannot be sent and that call fails.
3. In a copy install, replace all of `migration-kit/` with the temporary install's. The plugin needs only an update.

## 0.20.0 (recording settings no longer asks)

The kit files (plugin.json, scripts) change, so existing approvals and completion records expire once. Revalidate from judge. Completed outputs are kept.

1. `models set` and `settings apply` run as a command of their own no longer ask the host (Hook approval) in any mode: they record what the person chose in a question or in the file. A `settings apply` that switches auto mode on, and either command chained with another, with `--root` naming another project or with `--copilot`, still ask.
2. In auto mode `pilot prepare` and `source-spec init --apply` run unasked too. Still asked: `sessions prune` (a deletion that cannot be undone), switching auto mode on, `guardrails install` with options or over an existing file, and kit calls the hook cannot read.
3. In a copy install, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md`, the SKILL.md in `.github/skills/` and the kit's section of `.github/copilot-instructions.md` with the temporary install's. The plugin needs only an update.

## 0.19.0 (one progress display for long commands)

The kit files (plugin.json, scripts) change, so existing approvals and completion records expire once. Revalidate from judge. Completed outputs are kept.

1. `translate`, `repair`, `repair-round`, `build-loop`, `pilot run` and `survey run` all run the same way: start the command alone in a background terminal and check it with `status --root TARGET --wait 600 --format markdown`. The hook denies a pipe such as `| Out-String` or a redirection to a file, which hide all progress until the end (`2>&1` alone is allowed).
2. Progress lines have one format: `14:03:45 [3/12] src/a.cs: review (agent calls 14)` (time, finished/total of this run, unit, stage, AI calls). A unit that becomes blocked prints a `blocked` line at once.
3. In a copy install, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md`, the SKILL.md in `.github/skills/` and the kit's section of `.github/copilot-instructions.md` (from `code-migration-kit:start` to `end`) with the temporary install's. The plugin needs only an update.

## 0.18.1 (distributed from main)

No behavior change. For the plugin the version number changes, so existing approvals and completion records are invalidated once. Revalidate from judge. Completed outputs are kept.

1. The kit is now on the repository's default branch (main), and the marketplace source is `umauma00/code-migration-kit-with-github-copilot` with no branch.
2. A marketplace registered with `#feat/github-copilot-migration-kit` per the earlier instructions keeps installing from that branch while it exists, but updates now land on main. To switch, first remove it with `copilot plugin marketplace remove code-migration-kit-marketplace --force`, then add the source in [PLUGIN.en.md](PLUGIN.en.md) again (so the same name is not registered twice).
3. Links from copy-installed documents to the records in `history/` point at the default branch, so they resolve now that the kit is on main.

## 0.18.0 (repository cleanup)

No behavior change. Files under `scripts/` (and, for the plugin, the version number) change, so existing approvals and completion records are invalidated once. Revalidate from judge. Completed outputs and survey results are kept.

1. Removed `skill/SKILL.md`, an upstream file no install loaded. The plugin uses `skills/` and the copy install uses `.github/skills/` (unchanged).
2. Moved the kit's development records (`docs/plans/`, `docs/reviews/`, `docs/validation/`, `docs/REVIEW-FIXES.md`) to `history/`. In a copy install you may delete the old record folders left in `migration-kit/docs/`; the kit does not read them, and links to the records point at the GitHub repository.

## 0.17.0 (GitHub Copilot app support)

The kit's files (plugin.json, scripts) change, so existing approvals and completion records are invalidated once. Revalidate from judge. Completed outputs are kept.

1. You can switch the plugin's source from a local checkout to the GitHub repository (`umauma00/code-migration-kit-with-github-copilot#feat/github-copilot-migration-kit`). A local checkout registration keeps working. To switch, first remove it with `copilot plugin marketplace remove code-migration-kit-marketplace --force`, then add the new source (so the same name is not registered twice).
2. To use the GitHub Copilot app, install it as in [PLUGIN.en.md](PLUGIN.en.md#github-copilot-app) and start sessions with This computer and Current checkout.
3. For a repository copy, replace all of `migration-kit/` and the SKILL.md files in `.github/skills/` with the contents of a temporary install. The plugin picks this up with an update.

## 0.16.0 (auto mode does not stop inside a phase; survey parts in parallel)

The kit's files (lib, scripts) change, so existing approvals and completion records are invalidated once. Revalidate from judge. Completed outputs and survey results are kept.

1. In auto mode an audit or review that returns `changes` gets one fix and one fresh re-audit; what remains goes into the report and the record's note, and the run continues. A choice the source and RULEBOOK leave open takes the most conservative option with `TODO(port)` (in the RULEBOOK before the inventory survey runs, afterwards only in the translated output). Tell the agent your choice before autopilot if you have one.
2. Surveys run the parts of one split scope in parallel within `concurrency`. A survey in progress resumes as is.
3. An inventory survey no longer reports a negative `droppedFacts`. Results saved by earlier versions are kept, and a negative value counts as 0.
4. For copy installs, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md` and the SKILL.md files under `.github/skills/` with the contents of a temporary install. Plugins pick it up with the update.

## 0.15.0 (verification method at setup; auto-mode handoff)

The kit's files (lib, scripts) change, so existing approvals and completion records are invalidated once. Revalidate from judge. Completed outputs are kept.

1. When the original does not run, setup's fifth question asks whether a specification or test suite exists, and without one switches to source-as-spec before phase 00. Projects whose setup is done do not change (`preferences --specification available|unavailable` records the answer).
2. An auto-mode project still in setup gets the "still manual" line when `settings init` runs again, and stops before phase 00 with the autopilot handoff when setup is done.
3. For copy installs, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md` and the SKILL.md files under `.github/skills/` with the contents of a temporary install. Plugins pick it up with the update.

## 0.14.0 (first choices are questions; the settings file holds values only)

The kit's files (lib, scripts) change, so existing approvals and completion records are invalidated once. Revalidate from judge. Completed outputs are kept.

1. While `originalRuntime` is open, `settings init` asks whether the original program runs here as a question; you never type it into the file. If it does not run, the file's `verificationMode` becomes `source-only`.
2. Source folders the kit cannot find are asked as a question too, recorded with `settings init --source-roots`.
3. Switching to source-as-spec with `source-spec init --apply` also sets `verificationMode` to `source-only` in run-settings.json.
4. run-settings.json no longer carries `_help` and `_choices`: the explanations and choices (such as the available models) moved to `migration/run-settings.help.md`. An existing file shrinks on its next `settings init` (your values are kept).
5. For copy installs, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md` and the SKILL.md files under `.github/skills/` with the contents of a temporary install. Plugins pick it up with the update.

## 0.13.0 (auto mode)

The kit's files (lib, scripts) change, so existing approvals and completion records are invalidated once. Revalidate from judge. Completed outputs are kept.

1. Nothing changes unless you choose it. To run through with Copilot CLI autopilot, before starting autopilot run `run_migration.mjs preferences --phase-mode auto` in an interactive session, or set `phaseMode` to `auto` in run-settings.json and run `settings apply` (the host asks you to confirm either). See [auto mode](ORDERED-WORKFLOW.en.md#auto-mode).
2. `phaseMode` gains the choice `auto`. Running `settings init` again refreshes the explanations and choices.
3. For copy installs, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md` and the SKILL.md files under `.github/skills/` with the contents of a temporary install. Plugins pick it up with the update.

## 0.12.0 (relaxed mode)

The kit's files (lib, scripts) change, so existing approvals and completion records are invalidated once. Revalidate from judge. Completed outputs are kept.

1. Nothing changes unless you choose it: the mode stays normal. For relaxed mode run `run_migration.mjs preferences --phase-mode relaxed`, or set `phaseMode` to `relaxed` in run-settings.json and run `settings apply`. See [relaxed mode](ORDERED-WORKFLOW.en.md#relaxed-mode).
2. A run-settings.json written by 0.11.0 has no `phaseMode`; it still applies as is (the mode does not change). Running `settings init` again adds the `phaseMode` entry after `originalRuntime`.
3. For copy installs, replace all of `migration-kit/`, `.github/agents/migration-orchestrator.agent.md` and the SKILL.md files under `.github/skills/` with the contents of a temporary install. Plugins pick it up with the update.

## 0.11.0 (run settings file)

Kit files (lib, scripts) change, so existing approvals and completion records lapse once; revalidate from judge. Completed outputs are kept. Nothing in an existing `migration/config.json` changes until you run `settings apply`. To move an existing project to the file, run `run_migration.mjs settings init`: it writes `migration/run-settings.json` from the current configuration, and `status` shows whether the file matches it. `models set` and `preferences` keep working.

## 0.10.0 (no mid-run stops; no contract memo)

Kit files (lib, scripts) change, so existing approvals and completion records
lapse once; rerun judge. Completed outputs and completed survey scopes are kept.

1. Survey rows whose citations cannot be verified after the one correction
   finish as UNKNOWN marked `uncited`. A scope that stopped before finishes when
   you rerun the same `survey run`. Counts are in the scope records and the `survey merge` result (`uncited`, `droppedFacts`,
   and `unsurveyedOversizedFiles` for oversized inventory files).
2. A `migration/run.lock` left by a crashed run on the same host is removed by
   the next command. Only a lock from another host (shared folder) needs
   `unlock --pid` after you confirm that run stopped. A lock left by an older
   version records no host and is judged by its PID on this host.
3. New installs set `maxReviewInputBytes` to 262144. Existing configs are not
   changed. Raising it in `migration/config.json` changes the config
   fingerprint, so phase 02 onward and approvals are reviewed again.
4. New source-as-spec plans draft no contract memo (`contracts.md`). Existing
   plans keep working, including their `TODO(spec)` check. To move to the source
   index, delete `migration/judge-plan.json`, rerun `source-spec init --apply`
   and review 00b–02 together again.
5. Phase 01's dependency audit for a bundled mapper is one auditor over about
   ten files from `preparation_cli.mjs dependency-targets` (no 2 x 20 files over
   three rounds). A project in progress can switch at its next audit.
6. For a repository copy, replace all of `migration-kit/`, the
   `.github/agents/migration-orchestrator.agent.md` file and the `.github/skills/`
   SKILL.md files with the freshly installed versions. The plugin only needs an
   update.

## 0.8.0 (choosing the context size)

Kit files (lib, scripts) change, so existing approvals and completion records
lapse once; rerun judge. Completed outputs are kept.

1. Each role's context size is chosen in the same single answer as its model
   and effort: add `:long_context` only for the roles that need it, as in
   `models set --assign "reviewers=ID:high:long_context,..."`. The Context column
   of `models list` shows which models offer it.
2. Roles without it start as before, with no `--context` flag. Existing
   configurations keep working.

## 0.7.0 (the orchestrator is the only entry point)

The orchestrator profile changes, so existing approvals and completion records
expire once. Revalidate from the judge. Completed outputs are kept.

1. Start the migration from the orchestrator in the agent picker
   (`migration-orchestrator` for a repository copy, `code-migration-plugin-orchestrator`
   for the plugin; `/agent` in the Copilot CLI). `/code-migration` is no longer in
   the `/` menu; the orchestrator reads the skill first.
2. The `code-migration` and `depmap-adapter` skills set `user-invocable: false`.
   The AI can still load them. If another agent loads the skill, it does not start
   phases and points the person to the orchestrator. This is an instruction to the
   AI, not something the host enforces.
3. The ten VS Code Local `/migrate-…` prompt files were removed. The installer does
   not delete a repository copy's `.github/prompts/migrate-*.prompt.md`; the
   orchestrator proposes deleting any it finds and deletes them after the person agrees.
4. For a repository copy, replace the whole `migration-kit/`,
   `.github/agents/migration-orchestrator.agent.md`,
   the two SKILL.md files under `.github/skills/` and the managed block of
   `.github/copilot-instructions.md` with a temporary install's content by hand (the
   managed block as in step 6 of 0.3.0): re-running the installer stops on files
   whose content differs instead of overwriting them. The plugin picks the change up on update.

## 0.6.1 (fixes from the 0.6.0 review)

Existing approvals and completion records are revoked once because the kit's files (lib, scripts) change. Re-validate from judge. Completed outputs are kept.

1. No stop based on time, CPU or silence was added; execution stays continuous.
2. `doctor` lists, under `execution limits`, configured limits that continuous mode does not enforce (values of `maxAgentCalls`, `maxAiCreditsPerCall`, `maxRunInputBytes` and similar that differ from the template). Set `"executionMode": "bounded"` to enforce them, or delete them.
3. When a build-loop's error count has not fallen for three rounds, it keeps going, records `stalled` and status suggests a rulebook amendment.
4. Spilled log paths are recorded relative to the root; 0.6.0 records with absolute paths still read in place.

## 0.6.0 (continuous execution and large surveys)

The mapper fixes make every Python mapper depend on depmap_common.py, add
depmap_js_scan.mjs beside the JS/TS mapper, and use every mapper's --source-root
and make_manifest.py --map-root from generated source-spec commands. Update the complete kit together; then
regenerate and audit the map, manifest and review dependency declaration.

After upgrading the installed kit, existing configurations without executionMode
also run continuously: saved 600-second/call/fix defaults no longer interrupt
work. Only choose bounded mode when finite limits are wanted. All survey kinds
process oversized source bodies as resumable validated fragments. Current valid
scope results are retained. Repository-copy installations must update their kit.
See [interruption conditions and logging](INTERRUPTION-POLICY.en.md).

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

Existing config is kept. markerPolicy, phaseModels, designInputs and packageMap are never added to existing projects automatically; the new template selects todo-lines-v1. To adopt it in an existing project, check the RULEBOOK's count rule, then redo judge and approvals after changing the setting. An existing translation gate without a batch is treated as the whole manifest, and an old receipt without purpose is production. New 00b records are also bound to the judge inputs. Updating the runtime revokes existing approvals and completion, so re-validate. Native doctor now treats real host capabilities as unknown and exits non-zero. inventory-merge.json is reserved as a generated receipt and cannot be registered as a protected input; move a conflicting existing input to another path and update the settings (nothing is overwritten automatically). The repair queue keeps a journal and review bindings for every job; after an interruption, resume with translate, and build approval stays blocked until every diagnostic, including unstarted jobs, has been reviewed. See [this change table](../history/plans/2026-10-15-review-implementation.md).

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
