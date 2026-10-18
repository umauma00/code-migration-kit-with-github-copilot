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
   The hook asks the person to confirm approval and phase-completion commands
   and denies agent edits of `migration/guardrails.json`.
4. Delegate preparation reading by scope with `survey` (fresh tool-free
   surveyors, results as files under `migration/surveys/`); see [surveys](SURVEYS.md).
   Translate through the runner. CLI implementers, fixers and arbiters use read/search
   tools; native host workers all use tools: [] with self-contained inputs.
   Reviewers have no tools and receive the same frozen input; when it exceeds
   maxReviewInputBytes (CLI only) both receive the same hash-bound file list and
   run on read-only `reviewer-*-read` profiles, recorded as tool-assisted. All return
   JSON. The coordinator validates and writes only the manifest target.
   Never route around a tool denial or substitute an unrestricted agent session.
5. Two independent reviewers examine every output: source behavior and rule
   adherence. The runner supplies source files, candidate, rules, inventory and
   any diagnostic; reviewer profiles must keep `tools: []` (the `-read` twins keep
   read/search tools only). They never receive
   each other's findings. Findings both reviewers raise at the same source
   path:line are agreed; an arbiter confirms or rejects the disputed rest with
   evidence, defaulting to not confirmed. A failing in-loop typecheck is a
   confirmed finding for the fixer. Fix only confirmed findings and
   review the changed output again. Do not weaken tests to clear a queue.
6. Disk receipts, not conversation memory or file existence, determine completion.
   The receipt binds the input context, output hash and review evidence. Existing
   outputs without a receipt are reviewed again. Partial work is not done.
   Retrying an upstream stage revokes downstream results and approvals even
   if the inputs did not change. A fresh success requires fresh downstream runs.
7. Only the coordinator runs configured commands. Expensive builds and suites
   run once per round. A configured cheap unit typecheck may run inside the loop.
   A unit is one source file to one target file in this version.
   From phase 03, human-installed `migration/guardrails.json` denies destructive
   git and expensive build/test commands to every agent session through the
   preToolUse hook. Agents never install, edit or route around it.
8. Report requested model, timing and observed usage when available. Unknown
   usage/model fields stay null; never invent measurements. Set each worker model
   explicitly in config. The runner rejects profile-level model overrides.
9. Every failure ends with a report of its cause, impact and choices, one of
   them recommended with reasons, and waits for the user's choice
   ([When a step fails](PHASE-HANDOFF.md#when-a-step-fails)).
   Repeated failures signal an upstream rule/design problem. Stop at the repair
   limit and propose a rule amendment rather than endlessly patching instances.
10. Separate redesign from structural translation. In redesign mode, replace the
    rulebook bakeoff with adversarial design review and disposable module trials.

Read [usage](../README.md), [contracts](CONTRACTS.md) and
[permissions](../templates/settings.README.md) before a production run.
The CLI worker backend (`copilot-cli`) is the default automated path in VS Code
as well: the parent runs the runner in a terminal and the runner starts Copilot
CLI workers. For VS Code without the Copilot CLI, the user may choose
`workerBackend: native` with `nativeModelVerification: requested-unverified`,
which records every executed model as unverified; follow [native workers](NATIVE-WORKERS.md).
`host-metadata` remains experimental and cannot complete on VS Code. The same
runner owns validation, writes, receipts and gates. Host-managed instruction
isolation is recorded and is not equivalent to the CLI's isolation.
Use the shared skill with Copilot, or the skill/phase prompt files with Local.

## VS Code orchestration and verification modes

The user-facing parent owns phase TODO, questions and native job dispatch.
Status is read-only and available after initialization: `status --format markdown`
shows artifact candidates separately from validation, current reviewed units,
active lock/run roles, blockers and next actions. It never grants approval.
Use [source-only verification](SOURCE-ONLY.md) when the original runtime
is unavailable; runtime remains the default. Use [built-in Rubber Duck](RUBBER-DUCK.md)
only through host capabilities, with advisory decisions and existing repair/review.
Live VS Code rendering, native model dispatch and Stop behavior remain pending
until checked on a real host. Models and existing execution limits are unchanged.

The [ordered workflow](ORDERED-WORKFLOW.md) records reviewed preparation before judge and implementation. The main skill starts with phase init/next; future phase requests return to missing prerequisites. Use [cost logs](COST-LOG.md) for main-compatible TSV output.
