# Copilot permissions

`claude-settings.reference.json` is historical reference, not a Copilot policy.
Do not copy it into a Copilot settings file. CLI 1.0.93 reads user settings from
`~/.copilot/settings.json`; do not configure user settings in `config.json`.

The automated runner starts a fresh `copilot -p` call for each role with:

- `--available-tools view,grep,glob`
- `--allow-tool read --deny-tool write,shell`
- explicit `--agent` and `--model`, `--no-auto-update`, no fleet/autopilot
- `MIGRATION_KIT_ROLE` for the installed preToolUse backstop

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
