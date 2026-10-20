# Migration operating manual

Preparation follows [independent audit contracts](PREPARATION-AUDITS.md), including
early comparator validation, scanner regeneration and joint inventory/rule audit.
Use [sealed pilot grants](PILOT.md) before production 03 and
[explicit execution scopes](EXECUTION-SCOPES.md) for batches and parallel repair.
The six macro stages remain distinct from the ten internal evidence IDs.

These rules apply to running a language migration, not to maintaining this kit.

For plugin installations (`migration/config.json` has `"runtime": "plugin"`),
resolve the plugin root from the loaded skill/agent file. Replace `migration-kit/`
in executable paths below and in phase prompts with that absolute plugin root.
Run commands from the target repository; project artifacts stay relative to it.
See [plugin setup](PLUGIN.md). Repository-copy installations use the paths shown.

The main interactive orchestrator must follow [phase reports and user decisions](PHASE-HANDOFF.md)
at every phase boundary. Show artifacts, review points and a next-action example;
use the available question tool when an answer is needed. This reporting format
does not apply to automated workers, which keep their JSON-only contracts.

1. Without a runnable original or a specification, the user may choose
   [source as the only specification](SOURCE-AS-SPEC.md): 00b–02 are drafted
   from the source and reviewed once. Otherwise, in runtime mode (the default), keep the original implementation runnable as
   the executable specification and require original/mutation/parity validation.
   Explicit source-only mode instead validates source-derived preparation, then
   reviewed translation and actual target build/smoke. Handoff states behavioral
   equivalence unverified; the original runtime and parity are not required.
2. Decide once in `migration/RULEBOOK.md`; consult `migration/inventory.tsv` for
   each semantic gap. Workers never modify either. Propose amendments at a gate.
3. Complete one phase, report the evidence, then stop. The user's explicit next
   phase invocation authorizes that phase. Never self-issue `approve` without the
   user asking you to approve the concrete artifacts. Approval is bound to hashes.
   The hook asks the person to confirm approval, phase-completion,
   `guardrails install`, `build-loop` and `sessions prune` commands and denies any other agent write of
   `migration/guardrails.json`.
4. Delegate preparation reading by scope with `survey` (fresh tool-free
   surveyors, results as files under `migration/surveys/`); see [surveys](SURVEYS.md).
   Translate through the runner. Implementers, fixers and arbiters use read/search
   tools. Reviewers have no tools and receive the same frozen input; when it exceeds
   maxReviewInputBytes both receive the same hash-bound file list and
   run on read-only `reviewer-*-read` profiles, recorded as tool-assisted. All return
   JSON. The coordinator validates and writes only the manifest target.
   Never route around a tool denial or substitute an unrestricted agent session.
   Independent preparation audits run the same way: `audit_inputs.mjs run` sends
   a frozen request to the tool-free auditor as a fresh CLI worker on its phaseModels entry.
5. Two independent reviewers examine every output: source behavior and rule
   adherence (with `reviewFocus: shared`, the new-install default, each covers
   both from its own lens first). The runner supplies source files, candidate, rules, inventory and
   any diagnostic; reviewer profiles must keep `tools: []` (the `-read` twins keep
   read/search tools only). They never receive
   each other's findings. An arbiter confirms or rejects every finding with
   evidence, defaulting to not confirmed. Findings both reviewers raise at the
   same source path:line reach it as a pair: the same place is not agreement, and
   it confirms both only if they ask for compatible changes. A failing in-loop typecheck is a
   confirmed finding for the fixer. Fix only confirmed findings and
   review the changed output again, unless the user chose `fixPolicy:
   single-pass` (upstream Step 3: one fix, then build/smoke/parity judge it).
   Do not weaken tests to clear a queue.
6. Disk receipts, not conversation memory or file existence, determine completion.
   The receipt binds the input context, output hash and review evidence. Existing
   outputs without a receipt are reviewed again. Partial work is not done.
   Retrying an upstream stage revokes downstream results and approvals even
   if the inputs did not change. A fresh success requires fresh downstream runs.
   Run limits (concurrency, maxAgentCalls, maxFixRounds, timeouts, retries,
   maxRunInputBytes, maxAiCreditsPerCall), documents, phase prompts, skills and
   Copilot instructions do not reach workers' outputs and never revoke them.
7. Only the coordinator runs configured commands. Expensive builds and suites
   run once per round. A configured cheap unit typecheck may run inside the loop.
   A unit is one source file to one target file in this version.
   From phase 03, human-installed `migration/guardrails.json` denies destructive
   git and expensive build/test commands to every agent session through the
   preToolUse hook. The agent proposes it (`guardrails show`) and installs only the
   agreed list through the host-confirmed `guardrails install`; it never writes,
   edits or routes around the file otherwise.
8. Report requested model, timing and observed usage when available. Unknown
   usage/model fields stay null; never invent measurements. Set each worker model
   explicitly in config. The runner rejects profile-level model overrides.
9. Every failure ends with a report of its cause, impact and choices, one of
   them recommended with reasons, and waits for the user's choice
   ([When a step fails](PHASE-HANDOFF.md#when-a-step-fails)).
   Repeated failures signal an upstream rule/design problem. Stop at the repair
   limit and propose a rule amendment rather than endlessly patching instances.
   After the human agrees, `build-loop` runs upstream's build-until-clean rounds
   under one host-confirmed grant and stops by itself when the error count stalls.
   When status reports a worker retrying (rate limit, service error), tell the user.
   Smoke and parity regressions follow the same path (`repair-round --stage smoke|parity`);
   a failing original suite is never repaired in translated outputs.
10. Separate redesign from structural translation. In redesign mode, replace the
    rulebook bakeoff with adversarial design review and disposable module trials.

Read [usage](../README.md), [contracts](CONTRACTS.md) and
[permissions](../templates/settings.README.md) before a production run.
Workers always run as Copilot CLI processes, also from VS Code: the parent runs the
runner in a terminal and the runner starts the workers (the VS Code subagent
backend was removed in 0.3.0). The person drives the migration from chat only:
the agent runs every command, installs the CLI or starts `copilot login` after the
person agrees, and the person's own acts are chat answers and host confirmations
of human-gate commands. Use the shared skill with Copilot, or the skill/phase
prompt files with Local.

## VS Code orchestration and verification modes

The user-facing parent owns phase TODO and questions.
Status is read-only and available after initialization: `status --format markdown`
shows artifact candidates separately from validation, current reviewed units,
active lock/run roles, blockers and next actions. It never grants approval.
Use [source-only verification](SOURCE-ONLY.md) when the original runtime
is unavailable; runtime remains the default. Use [built-in Rubber Duck](RUBBER-DUCK.md)
only through host capabilities, with advisory decisions and existing repair/review.
Live VS Code rendering and Stop behavior remain pending until checked on a real
host. Models and existing execution limits are unchanged.

The [ordered workflow](ORDERED-WORKFLOW.md) records reviewed preparation before judge and implementation. The main skill starts with phase init/next; future phase requests return to missing prerequisites. Use [cost logs](COST-LOG.md) for main-compatible TSV output.
