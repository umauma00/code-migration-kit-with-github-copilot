# Small check with a real account

[日本語](LIVE-SMOKE.md) | English

The automated tests never authenticate with Copilot or call AI. This procedure checks the normal CLI path in your own environment. Model calls use your account's GitHub AI Credits.

From VS Code the workers are the same Copilot CLI processes. Also confirm that the fixture can be completed from chat alone (see the checklist below).

1. Set the report language with `run_migration.mjs preferences --language ja|en`, or choose it at the skill's first question. Sign in to the Copilot CLI in your environment and confirm available model IDs with `copilot --version` and `/model`.
2. From the kit root, create a verification directory that **does not exist yet**.

   ```bash
   node scripts/demo.mjs setup --target /tmp/copilot-migration-live --model MODEL_ID
   cd /tmp/copilot-migration-live
   node migration-kit/scripts/run_migration.mjs doctor --check-cli
   ```

   setup places only three source files, a comparator and a draft configuration, selecting strict and todo-lines-v1. It makes no AI calls, approves nothing and writes no 03 report. `test-double` is a test-only name, not a real model ID.

3. Follow `phase init` and `phase next`, and actually review the scope and model plan of 00. Record phase start before each phase's work and phase complete ID --note after the user's confirmation. Review `src/`, `tests/judge.py`, `migration/RULEBOOK.md`, the manifest, inventory and `migration/review-dependencies.json`, and verify which [preparation audits](PREPARATION-AUDITS.md) apply. Check the declared dependencies from main to math_ops/text_ops and the empty arrays of isolated files, and update draft reports with real evidence. Anything outside the 12 cases is unverified.
4. After reviewing 00, run `judge-prepare` in 00b. Confirm that original passes 12 cases, that mutation detects the deliberate negative-number and Unicode differences, and that both exit 0. Run the formal `judge` after actually reviewing 00b/01/02. Confirm that reuse of the early evidence is recorded and that the production 03 prerequisite still holds.
5. Before 03, agree the deny list the AI proposes and allow `guardrails install` when the host asks. Confirm that `phase start 03` stops without the file and that commands such as `git reset --hard` are denied in an interactive session. With a repository copy, start `copilot` interactively once to trust the folder, and confirm that `doctor`'s `repository hooks load in Copilot CLI` does not fail.
   Then follow the [pilot procedure](PILOT.md): create an explicit disposable grant in another new directory and run the pilot with the same CLI profiles. Confirm that production refuses translation while 03 is unapproved and that pilot results never become production done. Write the 03 report from real trial and audit results; after the user's confirmation run phase complete 03, `approve translation --note "what you actually checked"`, then `translate`. Confirm that failures from the Copilot API, permissions, models or JSON format stop with an error. Do not widen permissions to work around them.
6. For each unit, check the two independent reviews, arbitration and post-fix re-review where needed, the requested model and the output hash. Confirm both reviews share the same `reviewInputHash` and that the reviewers' `tools: []` is actually applied. Confirm that every CLI worker gets `--no-custom-instructions`, that AGENTS or personal instructions do not leak in, and that the specified role profile is applied. Put project policy into RULEBOOK/inventory. Confirm `status` returns the equivalent of `3/3`.
7. Review each prior stage, then approve and run build → smoke → parity one at a time. Confirm parity shows 12 cases, 0 differences and 0 skipped.
8. Confirm that re-running `translate` makes 0 AI calls, that moving review records aside triggers re-review, and that an interrupted run resumes. Remove a failed verification lock only after its owning process has stopped.

9. Re-run build and confirm that an old smoke result cannot advance to parity. Confirm that failed attempts record the command, requested model, stderr and times. Also confirm that changing the configured build script or `verificationInputs` requires re-approval.

Check permissions in a disposable directory. Confirm that reviewers cannot use tools including read/search, that other workers cannot edit or use the shell, and that normal sessions work without the role environment variable. The hook's JSON conversion verified by tests and the real CLI/IDE actually running that hook are separate checks.

In VS Code and the GitHub Copilot app, separately check the entry points and that hooks really run.

- **VS Code (Copilot harness, the default):** confirm that only the orchestrator is visible in the agent picker and can start the requested phase, that the `code-migration` and `depmap-adapter` skills are not in the `/` menu, and that no worker is in the picker. In the Agents window check the same with **Folder** isolation (do not use **New Worktree**: it always runs Allow all and shows no confirmation).
- **VS Code (Local harness):** in 1.144 Local is hidden by default and not available in the Agents window. To use it, install a repository copy with `--harness vscode-local` and switch the chat's harness to Local too. Besides the entry-point checks, confirm that the Local hooks are actually called. The `--harness` option alone does not change the chat's harness.
- **GitHub Copilot app:** with Environment **This computer**, Workspace **Current checkout** and tool permissions **Ask every time** or **Assisted**, confirm that the orchestrator can be selected from the agent picker or with `/agent`, and that the person's own decisions show a confirmation.

Before trying Dynamic Workflows, add its [specific checks](DYNAMIC-WORKFLOWS.md).

Example of what to record: CLI version, OS, Node version, model ID, phase, unit count, case count, difference count, time taken, usage actually measured and items not checked. Never fill unmeasured costs or model names with estimates.

## Human gates and worker sessions (live checks, not run yet)

Automated tests and the loopback checks cover prompt-mode workers only. Check the following on a real setup and record the results in an issue or pull request of the kit repository, labelled with the name of each item below (for example `liveCLIInteractiveAsk`). Write "not run" for items you did not run.

- **Interactive CLI (trusted folder):** have the AI run `node migration-kit/scripts/run_migration.mjs approve translation --note test`. Record that the question appears, that "No" stops the command, and whether the CLI shows its own permission prompt again after "Yes" ([copilot-cli#3042](https://github.com/github/copilot-cli/issues/3042)) (`liveCLIInteractiveAsk`).
- **Autopilot:** confirm the same command is denied without a question (CLI 1.0.97 and later, `liveCLIAutopilot`). Also record whether `--allow-all` / `--yolo` shows the question (not documented, `liveCLIAllowAll`).
- **Questions in autopilot:** in autopilot, create a situation that needs a choice (for example a failure report). Record whether the agent chooses nothing, states the pending decision and stops when `ask_user` returns an automatic reply (that the user is not available and the agent should work autonomously), and keep the reply text (the CLI 1.0.98 changelog says autopilot auto-handles `ask_user`; `liveCLIAutopilotAskUser`).
- **VS Code:** check the same in the Copilot harness (and Local if you use it) (`liveVSCodeAsk`), and record whether the Copilot session type loads `.github/hooks` (`liveVSCodeCopilotHarnessRepoHooks`). Also record whether the confirmation appears, the command is denied, or it runs unconfirmed under the Allow all permission level, Autopilot, `/yolo` and Agents window New Worktree sessions (`liveVSCodeAllowAll`). If it runs unconfirmed, tell people to switch back to Manual permissions while gate commands run.
- **Hooks in an untrusted folder:** re-run `node tests/verify_cli_transport.mjs` on an untrusted repository copy and record that the hook still applies to tool-assisted reviewers (they cannot read `migration/runs`) and that the other roles run (`liveRepoHooksAssistedReviewersOnly`). The same check against a loopback model runs every time as `doctor --check-cli`'s `tool-assisted reviewer hook loads in prompt mode`.
- **Sandbox:** with VS Code's or the Copilot CLI's local sandboxing on (generally available since 2026-10-07, off by default), run `doctor --check-cli` and a one-unit `translate`, and record whether worker CLIs started from the terminal can write `~/.copilot` and the worker home `~/.copilot-migration-kit-workers` (shown by `doctor --check-cli` as `worker Copilot CLI home`) and reach the Copilot API (`liveSandboxWorkers`). If they cannot, review the sandbox allowances or ask the person to approve running the runner outside the sandbox; the AI never changes sandbox settings on its own.

## Running to the end from chat alone (live checks, not run yet)

Screen behaviour cannot be checked by automated tests, so check it in a real VS Code or Copilot app.

- Take a small verification repository to the end from chat alone. Confirm that the AI checks for and installs the Copilot CLI, starts `copilot login` and relays its code, proposes a deny list and runs `guardrails install`, and that a confirmation appears before every command for the person's own decisions (not for `models set` and `settings apply`, which record the person's choice). Confirm the person never has to type a command.
- Confirm that the setup questions (models, target language, how phases advance, whether the original can run, whether a specification exists) come through `ask_user` and that the answers go into `migration/run-settings.json`.
- Confirm that the ten phases and their progress are visible before long work, and that progress keeps showing and the chat stays responsive during long commands such as translate.
- During translate, confirm that freed slots are refilled, the cap on concurrent reviewers, and the CLI-reported models in the run summary.
- Press the chat's stop button during an implementation and between the two reviews, and check whether the runner and worker processes remain. If they do, stop the runner and confirm that the lock is released and that late results are rejected.
- Re-run translate: completed units reuse valid records and only missing reviews run again; changed inputs require fresh approval.
- In source-only mode, walk through the comparator, approval, reviewed implementation, a real build/smoke and handoff without ever starting the original; parity is never treated as passed and final equivalence is written as unverified.

The repository's automated tests do not claim these live checks have passed.
