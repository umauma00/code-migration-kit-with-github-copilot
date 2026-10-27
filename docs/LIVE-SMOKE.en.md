# Small check with a real account

[日本語](LIVE-SMOKE.md) | English

The automated tests never authenticate with Copilot or call AI. This procedure checks the normal CLI path in your own environment. Model calls consume your quota and may cost money.

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

When using VS Code, separately check the entry points and that hooks really run for the chosen session type.

- **Copilot (Agent Host):** confirm that only the orchestrator is visible in the agent picker and can start the requested phase, that the `code-migration` and `depmap-adapter` skills are not in the `/` menu, and that no worker is in the picker.
- **Local:** install with `--harness vscode-local` and switch the VS Code chat's session type to Local too. Besides the same entry-point checks as Copilot (Agent Host), confirm that the Local hooks are actually called. The `--harness` option alone does not change the chat's session type.

Before trying Dynamic Workflows, add its [specific checks](DYNAMIC-WORKFLOWS.md).

Example of what to record: CLI version, OS, Node version, model ID, phase, unit count, case count, difference count, time taken, usage actually measured and items not checked. Never fill unmeasured costs or model names with estimates.

## Human gates and worker sessions (live checks, not run yet)

Automated tests and the loopback checks cover prompt-mode workers only. Check the following on a real setup and record the results under `liveChecks` in `docs/validation/copilot-cli-1.0.98-review-2026-10-18.json` (`null` means not run).

- **Interactive CLI (trusted folder):** have the AI run `node migration-kit/scripts/run_migration.mjs approve translation --note test`. Record that the question appears, that "No" stops the command, and whether the CLI shows its own permission prompt again after "Yes" ([copilot-cli#3042](https://github.com/github/copilot-cli/issues/3042)) (`liveCLIInteractiveAsk`).
- **Autopilot:** confirm the same command is denied without a question (CLI 1.0.97 and later, `liveCLIAutopilot`). Also record whether `--allow-all` / `--yolo` shows the question (not documented, `liveCLIAllowAll`).
- **Questions in autopilot:** in autopilot, create a situation that needs a choice (for example a failure report). Record whether the agent chooses nothing, states the pending decision and stops when `ask_user` returns an automatic reply (that the user is not available and the agent should work autonomously), and keep the reply text (the CLI 1.0.98 changelog says autopilot auto-handles `ask_user`; `liveCLIAutopilotAskUser`).
- **VS Code:** check the same in the Local and Copilot session types (`liveVSCodeAsk`), and record whether the Copilot session type loads `.github/hooks` (`liveVSCodeCopilotHarnessRepoHooks`). Also record whether the confirmation appears, the command is denied, or it runs unconfirmed under the Allow all permission level, Autopilot and `/yolo` (`liveVSCodeAllowAll`). If it runs unconfirmed, tell people to switch back to Manual permissions while gate commands run.
- **Hooks in an untrusted folder:** re-run `node tests/verify_cli_transport.mjs` on an untrusted repository copy and record that the hook still applies to tool-assisted reviewers (they cannot read `migration/runs`) and that the other roles run (`liveRepoHooksAssistedReviewersOnly`). The same check against a loopback model runs every time as `doctor --check-cli`'s `tool-assisted reviewer hook loads in prompt mode`.
- **Sandbox:** with VS Code's or the Copilot CLI's local sandboxing on (generally available since 2026-10-07, off by default), run `doctor --check-cli` and a one-unit `translate`, and record whether worker CLIs started from the terminal can write `~/.copilot` and reach the Copilot API (`liveSandboxWorkers`). If they cannot, review the sandbox allowances or ask the person to approve running the runner outside the sandbox; the AI never changes sandbox settings on its own.

## VS Code orchestration checklist (pending live verification)

These checks require actual VS Code; offline fixtures do not establish UI behavior.

- Start via plugin skill, repository skill and Local prompt: user-facing parent
  shows all ten phases before long work; planning children return advice.
- Confirm actual exposed TODO tool/schema, response and rendered list separately.
  Preserve unrelated tasks, avoid duplicates; verify chat fallback on unavailable,
  failed or reported invisible TODO. Local children never use TODO/question tools.
- Drive the whole fixture from chat only: the agent checks/installs the Copilot CLI,
  starts `copilot login` and relays its code, proposes and runs `guardrails install`,
  and the host asks before every human-gate command. Nothing is typed by the person.
- During translate, confirm the background terminal and a responsive parent, slot
  refill, the reviewer cap and the CLI-reported models in the run summary.
- Invoke actual built-in Rubber Duck if exposed; record unavailable otherwise.
  Save adoption/rejection and actual fix/reverification references.
- Press VS Code Stop during implementation and between the two reviews. Inspect
  runner process, terminal and worker processes. If still active, Ctrl+C the runner;
  verify the lock release and that late results are rejected.
- Rerun translate: completed units reuse valid receipts, only missing reviews rerun,
  blocked/stopped status matches evidence. Confirm changed inputs require fresh approval.
- Walk source-only through judge, approval, reviewed implementation, actual build/smoke
  and handoff: no original invocation, no passed parity, final equivalence unverified.

Current repository automation does not claim these live checks have passed.
