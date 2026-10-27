# Using the kit as a Copilot plugin

[日本語](PLUGIN.md) | English

Requires Node.js 22 or later and VS Code / GitHub Copilot with Agent Plugins 1.0 support. Workers always run on the Copilot CLI, so it is required in VS Code too (if it is missing, the AI installs it and starts sign-in after you agree). Verified CLI versions: 1.0.93, 1.0.95 and 1.0.98. You also need the languages and tests of the project being migrated.

## Installation

Prepare a checkout that includes 0.2.0 from this branch, somewhere other than the project being migrated. The kit itself does not need to live in the project.

```bash
copilot plugin marketplace add /path/to/code-migration-kit
copilot plugin install code-migration-kit@code-migration-kit-marketplace
copilot plugin list
```

VS Code detects the CLI's `~/.copilot/installed-plugins/`. Enable `chat.plugins.enabled` and check the Agent Plugins list. A plugin installed from a local marketplace reads the checkout directly; restart the chat after changes.

A checkout under development can also be registered from VS Code user settings:

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/path/to/code-migration-kit": true
  }
}
```

Manage the plugin from one source only. If several versions are registered, the first agents and skills found win. An older repository copy's `.github/skills/code-migration/` also takes precedence as a skill of the same name. To switch, keep the existing data, explicitly remove the old skill and set `"runtime": "plugin"` in `migration/config.json`. Existing approvals and completion records must be re-checked.

Once Git distribution is in place, the marketplace Git URL can be registered. After the repository's default branch also has this layout, `Chat: Install Plugin From Source` with the Git URL works too.

## Starting a new migration

Open the target repository in VS Code, select `code-migration-plugin-orchestrator` in Copilot Chat's agent picker (`/agent` in the Copilot CLI), and ask something like "start migrating from Python to JavaScript", naming a model ID available to you. The orchestrator asks which language to report in (Japanese or English), checks initialization and configuration, and proceeds one phase at a time from feasibility.

To initialize manually, run the following with the target repository as the working directory. Replace `MODEL_ID` with a model ID available to your account.

At the end of each phase, Copilot reports links to the artifacts, review points, the next phase and a sample reply. When a decision is needed, it asks "continue / revise / stop" with the available question tool, or shows the same choices in chat and waits where no tool exists. Instructions you already gave are not asked again. Production translation, build, smoke and parity need explicit approval of the current artifacts. See [phase reports and user decisions](PHASE-HANDOFF.md) for details and examples.

At start or resumption, the parent orchestrator creates the ten-phase list in Copilot's TODO and shows the current phase, approval waits, revisions and stops. Phase reports include the number of completed phases and the next phase. On resumption the list is reconciled with the saved artifacts and validation records; a TODO check alone never means approved or complete. Where no TODO tool exists, a chat list is used. See [phase TODO tracking](PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list).

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --model MODEL_ID --language en
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --model MODEL_ID --language en --apply
```

Whether you start from VS Code or the Copilot CLI, the parent agent runs the runner in a terminal and the runner starts Copilot CLI workers. The AI runs these commands from chat too.

It creates three files, `migration/config.json`, `migration/RULEBOOK.md` and `migration/inventory.tsv`, plus `migration/preferences.json` (the report language) when `--language` is given. Models and rules of an already configured project are never overwritten. Initialization approves no phase. Configure the languages, source/output/test locations and validation commands.

Call the plugin's scripts by absolute path, with the target repository as the working directory.

```bash
node /path/to/code-migration-kit/scripts/run_migration.mjs doctor --check-cli
node /path/to/code-migration-kit/scripts/run_migration.mjs status
```

In a new project, doctor shows the dependency declaration as `pending` (not needed yet) until phase 01 is recorded. From then on, artifacts, run records and approvals live in the target's `migration/`, and translated output in the configured `outputRoots`. Updating the plugin, or changing the project's `.github/hooks/`, `.github/agents/` or `.claude/agents/`, revokes existing approvals and completion. Track additional scripts inside the target repository that a hook uses via `verificationInputs`.

## Backends and verification scope

`plugin.json` and `skills/` use the Agent Plugins 1.0 format. The worker profiles and the CLI hooks live in `com.github.copilot/`. The runner mounts the plugin explicitly with `--plugin-dir` and selects workers with `--agent code-migration-kit:code-migration-plugin-ROLE`. Reviewers get a frozen input and no tools (or, for oversized units, read-only `-read` profiles); other workers are read-only too. The Node coordinator writes the output.

If a custom agent in the project, a parent directory or your personal settings uses one of the fully qualified names above as its `name` or file-derived ID, doctor and the pre-launch check stop. YAML quoting, folding and aliases are resolved, and Markdown in subdirectories is checked. The unqualified `code-migration-plugin-ROLE` can coexist as a different name. Only regular UTF-8 files are checked; definitions whose YAML cannot be parsed, and symlinks, stop the check as unverifiable.

`--no-custom-instructions` does not disable hooks of a trusted project. Audit project hooks at approval time and confirm they add no other context or other workers' results to frozen-input reviews. After adding, changing or removing project hooks, re-check judge and approvals before resuming.

This plugin targets the Copilot session type. Choose VS Code Local hooks and the experimental Dynamic Workflows extension with the repository-copy installation.

Automated tests check translation of three files, independent review and build/smoke/parity without any `.github/` or `migration-kit/` in the project; model responses are test doubles. Plugin recognition, marketplace installation and resolution of the named worker IDs were also checked on the real CLI; re-check with `node tests/verify_plugin.mjs /absolute/path/to/copilot` (no external AI). `doctor --check-cli` also proves, under the same conditions as the workers, that every worker ID resolves.

`node tests/verify_plugin_resolution.mjs /absolute/path/to/runtime.node` compares worker collisions and post-hook invalidation with CLI 1.0.93's actual discovery, selection and hook APIs. Only this verification script depends on those internal APIs.

On macOS, the real CLI (1.0.95 and 1.0.98) with a loopback test provider was used to check plugin-layout translation, independent review (including tool-assisted review) and denial by the guardrail hook. An old CLI (1.0.40) cannot load the plugin's agents, and `doctor` reports the missing worker IDs. Translation quality with the VS Code UI and an authenticated real model is not verified. Before a real project, run the small check in [LIVE-SMOKE.en.md](LIVE-SMOKE.en.md), reading its `migration-kit/` as the plugin's absolute path.
