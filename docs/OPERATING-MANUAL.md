# Migration operating manual

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

1. Keep the original implementation runnable. It is the executable specification.
2. Decide once in `migration/RULEBOOK.md`; consult `migration/inventory.tsv` for
   each semantic gap. Workers never modify either. Propose amendments at a gate.
3. Complete one phase, report the evidence, then stop. The user's explicit next
   phase invocation authorizes that phase. Never self-issue `approve` without the
   user asking you to approve the concrete artifacts. Approval is bound to hashes.
4. Translate through the runner. Implementers, fixers and arbiters use read/search
   tools. Reviewers have no tools and receive the same frozen input. All return
   JSON. The coordinator validates and writes only the manifest target.
   Never route around a tool denial or substitute an unrestricted agent session.
5. Two independent reviewers examine every output: source behavior and rule
   adherence. The runner supplies source files, candidate, rules, inventory and
   any diagnostic; reviewer profiles must keep `tools: []`. They never receive
   each other's findings. An arbiter confirms or
   rejects disputed findings with evidence. Fix only confirmed findings and
   review the changed output again. Do not weaken tests to clear a queue.
6. Disk receipts, not conversation memory or file existence, determine completion.
   The receipt binds the input context, output hash and review evidence. Existing
   outputs without a receipt are reviewed again. Partial work is not done.
   Retrying an upstream stage revokes downstream results and approvals even
   if the inputs did not change. A fresh success requires fresh downstream runs.
7. Only the coordinator runs configured commands. Expensive builds and suites
   run once per round. A configured cheap unit typecheck may run inside the loop.
   A unit is one source file to one target file in this version.
8. Report requested model, timing and observed usage when available. Unknown
   usage/model fields stay null; never invent measurements. Set each worker model
   explicitly in config. The runner rejects profile-level model overrides.
9. Repeated failures signal an upstream rule/design problem. Stop at the repair
   limit and propose a rule amendment rather than endlessly patching instances.
10. Separate redesign from structural translation. In redesign mode, replace the
    rulebook bakeoff with adversarial design review and disposable module trials.

Read [usage](../README.md), [contracts](CONTRACTS.md) and
[permissions](../templates/settings.README.md) before a production run.
The CLI is the automated reference path. In VS Code, use the shared
`code-migration` skill with the Copilot harness, or phase prompt files with Local.
