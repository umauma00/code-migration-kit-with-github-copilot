# Experimental Dynamic Workflows adapter

This is optional. The ordinary CLI runner is the reference implementation.
The SDK API was checked against [github/copilot-sdk](https://github.com/github/copilot-sdk/blob/cf245cdf76ced14d2f61dc3d908dd37cf12e0978/nodejs/docs/workflows.md).
The integration is tested with a simulated workflow context, **not a live authenticated CLI session**.

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
`ctx.agent` supplies a schema, profile and explicit model. Role/input-specific
labels keep independent reviewer results distinct. A null result fails closed.
The adapter intentionally does not memoize filesystem writes with fixed `ctx.step`
keys: disk receipts decide what remains after a restart. An SDK retry may reuse a
result only for the same role and input hash. Cancellation reaches the shared runner.

Reviewer profiles must retain `tools: []`; other worker profiles must retain
`tools: ["view", "grep", "glob"]`. No worker may override its model. Both reviewers
receive the same frozen JSON input from the shared coordinator. Isolation no
longer depends on a per-worker environment variable reaching SDK subagents.
Workflow concurrency/total-subagent limits are derived from config; the shared
runner also enforces its invocation limit. `timeoutSeconds` applies to spawned
CLI workers, not SDK `ctx.agent`; SDK run limits govern the experimental path.
Observed usage and actual served model remain null in current receipts. Do not
interpret this adapter as measured cost control.

Before use, verify registration, schema output, no tools for reviewers and
view/grep/glob-only tools for other workers, an
interrupted run, and the absence of an unapproved next-stage execution in your
account's CLI. The SDK extension entrypoint is CLI-specific; VS Code prompt files
are a separate conversational entrypoint, not a native workflow runtime.
