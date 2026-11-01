# Copilot permissions

CLI 1.0.93 reads user settings from `~/.copilot/settings.json`; do not
configure user settings in `config.json`.

The automated runner starts a fresh `copilot -p` call for each role with:

- `--available-tools view,grep,glob`
- `--allow-tool read --deny-tool write,shell`
- explicit `--agent` and `--model`, no fleet/autopilot; no flag that changes
  nothing the runner reads (`-s`, `--no-color`, `--no-ask-user`, `--name`): each
  is one more way for a CLI update to stop every worker; no `--no-auto-update`, which
  would make native-installer launchers run their older bundled build
- `MIGRATION_KIT_ROLE` for the installed preToolUse backstop. Only the
  tool-assisted reviewers (`reviewer-semantics-read`, `reviewer-rules-read`) also
  get `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true`, so they load the repository
  hook even in an untrusted folder (otherwise CLI 1.0.98 skips it) and stay out
  of other workers' records. That variable admits every `.github/hooks` file in
  the project, so the other roles, already limited by the flags above, follow
  folder trust
- `--session-id <uuid>`: worker transcripts hold source code and prompts. The kit passes no
  session-sync flag (CLI 1.0.103 renamed `--no-remote-export` to
  `--sync-session off` and rejects the old name), so whether they also sync to
  the GitHub account follows the person's CLI setting. The runner journals
  each ID before the call (`migration/runs/<run>/cli-sessions.jsonl`) and the
  attempt or survey record keeps it as `cliSessionId`; `sessions status | prune`
  reports or deletes exactly those sessions, never the user's own
- no launcher wrapper: the CLI (Node) raises its own soft open-file limit to the
  hard limit (macOS defaults the soft limit to 256). `doctor --check-cli` reports
  the hard limit and warns below 4096 (the need is per process); raising it needs
  the person or an administrator

Workers run the CLI version the user normally runs. Each call records that
version; a change during a run is a warning in the run summary, not a stop.
`doctor --check-cli` uses the same arguments and environment and proves that
every worker agent resolves by asking the CLI for an unknown agent.

All workers, including implementers and fixers, return content as JSON. They
cannot run builds or edit through the exposed tool set. The coordinator checks
paths and writes only the assigned target. Output roots cannot overlap source,
migration artifacts, `.github`, or the bundled runtime. Symlinks in managed
paths are refused. These are workflow controls, not an OS security boundary.

The hook declines edits, shell commands and delegation for worker processes.
Ordinary interactive sessions without the role environment variable are not
restricted by this hook. Conversational phase prompts are not a sandbox.

The installer defaults to Copilot SDK hooks. Choose `--harness vscode-local`
for VS Code Local's different hook payload/response format. CLI workers still
have their command-line restrictions. Test the selected harness with the live
smoke procedure; model selection alone does not change the harness.

Hook timeout behavior can be fail-open, so the runner does not rely on hooks as
its only restriction. Dynamic Workflows use read/search-only agent profiles;
the extension's own filesystem writes and configured commands are made by the
same coordinator. Extension code runs outside normal tool permission prompts.

Commands in config are trusted argv arrays, executed without shell expansion.
Use a dedicated script for compound commands. Build output directories must be
outside outputRoots (which describe translated source). Keep old source and
judge files under version control. No worker may change its own grader.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

## Command guardrails (upstream settings.json denies)

Copilot has no repository setting that denies shell commands. The upstream
`.claude/settings.json` deny list is therefore `migration/guardrails.json`,
installed before phase 03 from `templates/guardrails.json` and adapted to the
target's build/test commands. Installing it stays the human's act in chat-only
use: the agent proposes the list (`run_migration.mjs guardrails show`) and runs
`guardrails install` only after agreement, and the host asks the person to
confirm that exact command. Any other agent write of the file is denied. The preToolUse hook denies matching shell
commands (Copilot CLI `bash`, VS Code `run_in_terminal`) in every agent session;
the runner's own build/test/typecheck processes are not tool calls and are not
affected. `phase start 03|04` refuses to start without the file or a recorded
waiver. To dissolve Step 4 for a cheap typecheck, the human removes that entry
at a gate. Interactive Copilot CLI sessions load repository hooks only in trusted folders,
so `doctor` fails when guardrails are installed in an untrusted folder; plugin
hooks load regardless, and runner-started workers always load them. Like upstream, this is a guardrail, not a security boundary.

## Tool-assisted reviews

When a unit's review evidence exceeds `maxReviewInputBytes`, CLI reviewers
switch automatically to `reviewer-*-read` profiles with `view,grep,glob`
(`--allow-tool read --deny-tool write,shell`). Both receive the same file list
bound by SHA-256 instead of contents. The hook requires an explicit path and
denies the repository root and `migration/runs|state|results|gates|phases`.
The run records `reviewInputMode`, `toolAssistedReviews` and a warning.
