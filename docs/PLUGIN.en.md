# Using the kit as a Copilot plugin

[日本語](PLUGIN.md) | English

Requires Node.js 22 or later and GitHub Copilot CLI, VS Code or the GitHub Copilot app with Agent Plugins 1.0 support. Workers always run on the Copilot CLI, so it is required in VS Code and the app too (if it is missing, the AI installs it and starts sign-in after you agree). Transport with the real CLI and a stand-in model was checked on 1.0.93 to 1.0.98. On 1.0.105, the latest as of 2026-10-31, every option the kit passes to the CLI is still valid (checked with `copilot --help`). You also need the languages and tests of the project being migrated.

## Installation

GitHub Copilot CLI, VS Code and the GitHub Copilot app all install the same plugin from the same marketplace. Its identifier is `code-migration-kit@code-migration-kit-marketplace`. The kit uses the Agent Plugins 1.0 layout (root `plugin.json`, `skills/`, and the workers and hooks in `com.github.copilot/`), which all three read (checked against the GitHub and VS Code documentation as of 2026-10-29). The kit itself does not need to live in the project being migrated.

Register the marketplace from the source below (the repository's default branch, main). A marketplace registered with `#feat/github-copilot-migration-kit` by the 0.18.0 and earlier instructions keeps working while that branch exists, but updates now land on main; see [UPGRADING.en.md](UPGRADING.en.md) to switch.

```text
umauma00/code-migration-kit-with-github-copilot
```

Manage the plugin from one source only. If it is registered several ways at once (marketplace, local checkout, `chat.pluginLocations`), two orchestrators appear and the first one found wins. An older repository copy's `.github/skills/code-migration/` also takes precedence as a skill of the same name. To switch, keep the existing data, explicitly remove the old skill and set `"runtime": "plugin"` in `migration/config.json`. Existing approvals and completion records must be re-checked.

### GitHub Copilot CLI

```bash
copilot plugin marketplace add umauma00/code-migration-kit-with-github-copilot
copilot plugin install code-migration-kit@code-migration-kit-marketplace
copilot plugin list
```

To update, run `copilot plugin marketplace update code-migration-kit-marketplace`, then `copilot plugin update code-migration-kit`. To use a local checkout, register it with `copilot plugin marketplace add /path/to/code-migration-kit`. A plugin from a local marketplace reads the checkout directly; changes take effect in a new session (or after `/restart`). Do not update from a release before 0.40.0 in the middle of a migration (that one update revokes approvals once and sends every finished file back to review; from 0.40.0 only phase 00b is recorded again). From 0.40.1 on, an update keeps phase records, approvals and completion records ([UPGRADING.en.md](UPGRADING.en.md)).

### VS Code

Enable the `chat.plugins.enabled` setting, then use one of these:

1. Run **Chat: Open Customizations** → **Browse** → **Configure Marketplaces** in the source menu → **Add Marketplace**, enter the source above, then **Browse** and **Install** `code-migration-kit`. The same value in the `chat.plugins.marketplaces` setting also registers it.
2. VS Code automatically discovers plugins installed with the Copilot CLI (`~/.copilot/installed-plugins/`) and lists them under **Plugins** in Customizations.
3. Register a checkout under development with the `chat.pluginLocations` user setting (experimental).

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/path/to/code-migration-kit": true
  }
}
```

The `/plugin` commands in Copilot harness chats keep a separate inventory from the Customizations editor. Manage the plugin where you installed it.

When you start a session in VS Code (checked against VS Code 1.144 and its documentation as of 2026-10-31):

- Use the **Copilot** harness, the default for new sessions in 1.144. The plugin is read in this harness. **Local** is hidden by default in 1.144 and not available in the Agents window; to use Local, install a repository copy with `--harness vscode-local` ([detailed usage](REFERENCE.en.md#what-a-copy-install-puts-in-the-repository)).
- In the chat view and the **Agents window** alike, select `code-migration-plugin-orchestrator` in the agent picker.
- In the Agents window choose **Folder** isolation. **New Worktree** sessions always run "Allow all" and show no confirmation dialog, while the kit's approvals expect a person to allow them there, so do not use it. A new worktree also starts from committed files, so an uncommitted `migration/` does not carry over.
- Use **Manual permissions** (the default) or **Assisted permissions**. **Allow all** shows no confirmation.
- To run through automatically, choose auto mode at setup and, when setup is done, switch to autopilot mode and send "continue".

### GitHub Copilot app

1. Open **Customize** in the sidebar and, from the marketplace settings next to the marketplace dropdown, add the source above as a GitHub repository. Opening `ghapp://plugins/marketplace/add?source=umauma00%2Fcode-migration-kit-with-github-copilot` shows the form filled in (it is added after you confirm).
2. In **Customize**, search for `code-migration-kit` and click **Install**. `ghapp://plugins/install?source=code-migration-kit%40code-migration-kit-marketplace` opens it too. Check that it is turned on under **Installed**.

When you start a session in the app:

- Set **Environment** to **This computer**. The kit runs workers with your local Copilot CLI and writes the migration record to local files (Cloud is unverified).
- Set **Workspace** to **Current checkout**. **New worktree** creates a separate working copy per session, and the uncommitted `migration/` does not carry over. If another worktree already holds a migration when you initialize, the initialization preview returns where (`existingMigrations`) and the orchestrator asks whether to resume there.
- Select `code-migration-plugin-orchestrator` in the agent picker (or with `/agent`). To run through automatically, choose auto mode at setup and, when setup is done, switch to autopilot mode and send "continue".
- Set tool permissions to **Ask every time** or **Assisted**. Gate commands rely on a confirmation; whether **Approve all** shows it is unverified.
- If a worker cannot reach the network or its sign-in in a session with local sandboxing on, turn it off in that session with `/sandbox off`. Commands in that session then run without the sandbox's limits, so do this only for repositories you trust.

### Install from an internal Git server

A checkout on GitLab or another Git server can be added in all three with its Git URL (`https://git.example.com/group/code-migration-kit.git` or `git@git.example.com:group/code-migration-kit.git`) as the source (per the documentation; not tried on a real setup). A `#branch` suffix is documented only for the `owner/repo` form, so keep the kit on that server's default branch. Authentication appears to follow your local git setup; check first that `git clone` works from a terminal. Organization managed settings that restrict marketplaces block the addition.

### Make it the project default (optional)

Add the following to the migration target's `.github/copilot/settings.json` to enable it by default in the Copilot CLI, VS Code (Copilot harness) and the app for people working in that repository. Personal opt-outs and organization managed settings take precedence.

```json
{
  "extraKnownMarketplaces": {
    "code-migration-kit-marketplace": {
      "source": { "source": "github", "repo": "umauma00/code-migration-kit-with-github-copilot" }
    }
  },
  "enabledPlugins": {
    "code-migration-kit@code-migration-kit-marketplace": true
  }
}
```

### Primary sources checked (2026-10-29; VS Code session settings re-checked 2026-10-31)

- GitHub Docs: [Customizing the GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app), [Opening the app with deep links](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links), [Agent sessions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
- GitHub Docs: [Finding and installing plugins for Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing), [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference), [Plugins](https://docs.github.com/en/copilot/concepts/customizations/plugins)
- VS Code: [Agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins), [Agent plugin reference](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference), [Agent harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses), [Agents window](https://code.visualstudio.com/docs/agents/run/agents-window), [Approvals](https://code.visualstudio.com/docs/agents/run/approvals), [1.144 release notes](https://code.visualstudio.com/updates/v1_144)

## Starting a new migration

Open the target repository, select `code-migration-plugin-orchestrator` in the agent picker (`/agent` also works in the Copilot CLI and the app), and ask something like "start migrating from Python to JavaScript". The orchestrator asks which language to report in, initializes the project, asks the models and the other setup questions one at a time, and proceeds one phase at a time from feasibility.

To initialize manually, run the following with the target repository as the working directory (models are chosen by a question after installation).

At the end of each phase, Copilot reports links to the artifacts, review points, the next phase and a sample reply. When a decision is needed, it asks "continue / revise / stop" with the available question tool, or shows the same choices in chat and waits where no tool exists. Instructions you already gave are not asked again. Production translation, build, smoke and parity need explicit approval of the current artifacts. See [phase reports and user decisions](PHASE-HANDOFF.md) for details and examples.

At start or resumption, the parent orchestrator creates the ten-phase list in Copilot's TODO and shows the current phase, approval waits, revisions and stops. Phase reports include the number of completed phases and the next phase. On resumption the list is reconciled with the saved artifacts and validation records; a TODO check alone never means approved or complete. Where no TODO tool exists, a chat list is used. See [phase TODO tracking](PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list).

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --language en
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --language en --apply
```

Whether you start from VS Code, the Copilot CLI or the GitHub Copilot app, the parent agent runs the runner in a terminal and the runner starts Copilot CLI workers. The AI runs these commands from chat too.

It creates three files, `migration/config.json`, `migration/RULEBOOK.md` and `migration/inventory.tsv`, plus `migration/preferences.json` (the report language) when `--language` is given. Models and rules of an already configured project are never overwritten. Initialization approves no phase. The AI asks the models, languages, source location, phase mode and whether the original runs as questions and writes the answers into `migration/run-settings.json` (written by `run_migration.mjs settings init`). The remaining entries, such as output/test locations and validation commands, and later changes are made in that file and recorded with `settings apply`.

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

Automated tests check translation of three files, independent review and build/smoke/parity without any `.github/` or `migration-kit/` in the project; model responses are test doubles. Plugin recognition, installation from a local marketplace and resolution of the named worker IDs were also checked on the real CLI (installation from the GitHub-hosted marketplace is not); re-check with `node tests/verify_plugin.mjs /absolute/path/to/copilot` (no external AI). `doctor --check-cli` also proves, under the same conditions as the workers, that every worker ID resolves.

`node tests/verify_plugin_resolution.mjs /absolute/path/to/runtime.node` compares worker collisions and post-hook invalidation with CLI 1.0.93's actual discovery, selection and hook APIs. Only this verification script depends on those internal APIs.

On macOS, the real CLI (1.0.95 and 1.0.98) with a stand-in (loopback) model was used to check plugin-layout translation, independent review (including tool-assisted review) and denial by the guardrail hook. An old CLI (1.0.40) cannot load the plugin's agents, and `doctor` reports the missing worker IDs. Exhaustive checks from the VS Code and GitHub Copilot app screens, and translation quality with a real model through the last phase, are not verified yet. Before a real project, run the small check in [LIVE-SMOKE.en.md](LIVE-SMOKE.en.md), reading its `migration-kit/` as the plugin's absolute path.
