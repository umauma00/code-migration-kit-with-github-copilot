# Plugin worker selection and approval fingerprints

Copilot CLI 1.0.93 can select a local custom agent by either its file-derived ID
or its YAML `name`. A project profile named `other.agent.md` with
`name: code-migration-kit:code-migration-plugin-reviewer-rules` was selected ahead
of the plugin reviewer while the previous filename-only guard passed. Conversely,
an unqualified local name was rejected even though the CLI chose the plugin.

The guard now recursively inspects personal, project and ancestor agent roots,
parses YAML names (including escapes, block scalars and aliases), and reserves
the fully qualified plugin selector. Definitions of that selector are rejected
before spawning a worker, even if another local profile currently hides them.
Unqualified selectors can coexist. The YAML parser is bundled with its ISC
license; production code does not depend on Copilot's internal native APIs.

Plugin mode also omitted project hooks from the execution fingerprint. Adding a
trusted project's `sessionStart` hook left translation approval and completed
receipts valid, while repository-copy mode invalidated both. Plugin fingerprints
now include `.github/hooks`, `.github/agents` and `.claude/agents` in addition to
the plugin runtime. Changes to these project inputs require judge and approval
to be repeated. Project hook scripts outside those directories must be declared in
`verificationInputs`.

## Validation

- `npm test`: 97 tests pass, including migration in both installation layouts.
- New regressions cover YAML name variants, nested/personal/ancestor/Claude
  profiles, noncolliding names, rejection before any worker call, and approval
  and completion invalidation after hook creation, edit and removal.
- [Native regression check](../../tests/verify_plugin_resolution.mjs): the real
  CLI selected local profiles in all 35 alias cases; the guard rejected each.
  All three noncolliding controls selected the plugin and passed the guard.
  A real project hook returned an additional-context canary; its addition now
  invalidated the prior approval and completed receipt.
- [Plugin install check](../../tests/verify_plugin.mjs) covers marketplace
  installation and all six qualified agent IDs without model requests.

The native check uses CLI 1.0.93 internals only for verification. Full model
communication remains blocked in this cloud environment by the CLI's file-watch
resource limit. VS Code UI and authenticated model behavior are unverified.

`--no-custom-instructions` does not disable trusted project hooks. Their contents
remain subject to project review, including whether they add context to frozen
reviews. These changes track hook changes and prevent selector overrides; they
do not claim to isolate arbitrary personal or third-party hooks.
