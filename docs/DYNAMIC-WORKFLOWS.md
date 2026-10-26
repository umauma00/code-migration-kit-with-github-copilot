# Experimental Dynamic Workflows adapter

This is optional. The ordinary CLI runner is the reference implementation.
The SDK API was checked against [github/copilot-sdk](https://github.com/github/copilot-sdk/blob/cf245cdf76ced14d2f61dc3d908dd37cf12e0978/nodejs/docs/workflows.md).
The host integration is tested with a simulated workflow context, **not a live
authenticated SDK workflow session**. Workers use the reference CLI adapter.

Install using `--with-workflow` and review the extension code before trusting it.
Repository extensions execute local code outside ordinary agent tool approvals.
Use Copilot's documented project-extension trust flow. In unattended environments,
`GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` opts in to project extensions; use it
only after reviewing and trusting this repository, never as a general bypass.
See [GitHub's workflow instructions](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-dynamic-workflows).

```bash
copilot --experimental --allow-tool read workflow run code-migration --args '{"stage":"translate"}'
```

Accepted stages are `judge`, `translate`, `build`, `smoke`, `parity`. Each invocation
runs one stage. It does not create approvals or proceed to the next stage. Use the
ordinary `run_migration.mjs approve` command after reviewing the concrete artifacts.
Do not combine `workflow run` with `-p`, `--agent`, fleet or autopilot.

The extension registers `defineWorkflow(...)` through `joinSession(...)`.
Since 0.1.5 it starts fresh CLI worker processes through createCopilotAdapter;
it does not use `ctx.agent`. The referenced SDK's WorkflowAgentOptions has no
per-call switch to disable automatic instructions. Using the CLI path enforces
--no-custom-instructions for every worker independently of the host's settings
and conversation. Explicit role profiles, models, JSONL parsing and local result
validation are the same as the ordinary runner.

The adapter does not memoize workers or filesystem writes with `ctx.step` keys.
Disk receipts decide what remains after restart; SDK durable subagent results
and SDK schema retries are no longer used. `ctx.signal` reaches CLI processes
and validation commands. The runner always enforces concurrency and authorized
scope; normal execution is continuous. Saved call/round/time budgets apply only
in executionMode bounded. SDK subagent limits do not control these child
processes. An actual outer workflow cancellation still reaches the runner;
never manufacture cancellation merely because a host wait returns or CPU/time
looks high. Host-imposed deadlines are external and must be reported as such.

By default workers run `copilot` from PATH. To select a particular executable,
run doctor with that executable first and set the workflow argument:

```bash
node migration-kit/scripts/run_migration.mjs doctor --check-cli --copilot /path/to/copilot
copilot --experimental --allow-tool read workflow run code-migration --args '{"stage":"translate","copilot":"/path/to/copilot"}'
```

Reviewer profiles must retain `tools: []`; other worker profiles must retain
`tools: ["view", "grep", "glob"]`. No worker may override its model. Both reviewers
receive the same frozen JSON input from the shared coordinator. Isolation no
longer depends on a per-worker environment variable reaching SDK subagents.
Observed usage and actual served model remain null in current receipts. Do not
interpret this adapter as measured cost control.

Before use, verify registration, CLI JSON output, no ambient AGENTS/personal
instructions, no tools for reviewers, view/grep/glob-only tools for other workers, an
interrupted run, and the absence of an unapproved next-stage execution in your
account's CLI. The SDK extension entrypoint is CLI-specific; VS Code's shared
`code-migration` skill and Local prompt files are separate conversational
entrypoints, not a native workflow runtime.
