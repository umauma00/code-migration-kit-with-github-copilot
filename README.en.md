# Code Migration Kit with GitHub Copilot

[日本語](README.md) | English

An unofficial adaptation of Anthropic's [Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code) (made for Claude Code) for GitHub Copilot. It moves a codebase from one programming language to another without changing its behavior.

The method is the original kit's: **feasibility → fix the rules → try them on a few files → translate everything with two independent reviews per file → build → start it → compare old and new behavior**. What differs is the part that runs the AI, rebuilt for Copilot, and approvals and completion that are checked against records ([differences from the original kit](guides/migration-guide.html#upstream)).

This is not an official Anthropic or GitHub distribution.

## Supported apps

Use it from any of the three below. In each, the entry point is one agent, the **migration orchestrator**, and you work with it in chat.

| App | Install | Select the orchestrator |
|---|---|---|
| GitHub Copilot CLI | `copilot plugin install` | `/agent` |
| GitHub Copilot app | Install the plugin from Customize | Agent picker or `/agent` |
| VS Code (chat and the Agents window) | Install the plugin from Chat: Open Customizations | Agent picker |

Whichever app you use, the AI that translates and reviews (the workers) runs in your local **Copilot CLI**, which the kit starts separately. The app and VS Code therefore need the Copilot CLI too (if it is missing, the AI installs it and starts sign-in after you agree).

Session settings per app:

- **Copilot app**: Environment **This computer**, Workspace **Current checkout**, and tool permissions **Ask every time** or **Assisted**.
- **VS Code**: use the **Copilot** harness (the default). In the Agents window choose **Folder** isolation: **New Worktree** always runs "Allow all", so no confirmation is ever shown, and it does not carry over an uncommitted `migration/`. Use **Manual permissions** (the default) or **Assisted permissions**.
- **Every app**: commands that need approval expect a person to allow them in the app's confirmation dialog. To run through automatically, choose "auto" mode at setup and, when setup is done, switch to autopilot mode and send "continue".

Step-by-step instructions are in [using the kit as a plugin](docs/PLUGIN.en.md).

## Requirements

- Node.js 22 or later (the kit uses no external npm packages)
- The GitHub Copilot CLI and a Copilot plan or organization setting that allows the models you want
- The runtimes and build tools of the source and target languages (Python 3 for the bundled Python dependency mapper and the demo)
- Windows, macOS or Linux. Every change is tested on Windows and Ubuntu in GitHub Actions. Windows notes: [using the kit on Windows](docs/WINDOWS.en.md)

## Installing

### As a plugin (recommended)

Nothing is placed in the repository you migrate. In the Copilot CLI:

```bash
copilot plugin marketplace add umauma00/code-migration-kit-with-github-copilot
copilot plugin install code-migration-kit@code-migration-kit-marketplace
```

In VS Code and the GitHub Copilot app, add the same source (`umauma00/code-migration-kit-with-github-copilot`) as a marketplace and install `code-migration-kit`. VS Code also finds plugins the CLI installed. Each app's screens, updates and installing from an internal Git server are in [PLUGIN.en.md](docs/PLUGIN.en.md).

**Do not update to 0.40.0 in the middle of a migration.** That one update revokes approvals once and sends every finished file back to review. From 0.40.0 on, a plugin update keeps approvals and completion records (each version's effect is in [UPGRADING.en.md](docs/UPGRADING.en.md)).

### As a copy in the repository

Clone the kit and copy it into the repository you migrate. Ask in chat "clone this kit and install it into this repository with `scripts/install.mjs`" and the AI does it. By hand, preview first, then apply with `--apply`:

```bash
node scripts/install.mjs --target /path/to/your-project --language en
node scripts/install.mjs --target /path/to/your-project --language en --apply
```

The kit goes to `migration-kit/`, and the agents and hooks to `.github/`. An existing file with different content is never overwritten (the installer stops). Add `--harness vscode-local` only for VS Code's Local harness ([detailed usage](docs/REFERENCE.en.md#what-a-copy-install-puts-in-the-repository)).

## Starting a migration

Open the repository you migrate, select **`code-migration-plugin-orchestrator`** in the agent picker (`migration-orchestrator` for a copy install) and ask, for example, "start a C# to TypeScript migration" or "continue the migration". Other agents do not start phases; they point you to the orchestrator.

You never type commands. The AI runs them and reports in chat. Your part is three things:

1. Answering questions in chat (language, models, policies, each phase's decisions)
2. Allowing the app's confirmation dialog for the person's own decisions (approvals, completing a phase, preparing a trial run, installing guardrails and so on; not shown in auto mode)
3. Once, approving the Copilot CLI sign-in in the browser

### What you are asked first

First the report language (Japanese or English), then, after installation, one question each. The answers go into `migration/run-settings.json`, which is used when you change settings later or resume in another session.

1. Every role's model (from the models your account offers)
2. The target language (the kit detects the source language from the files)
3. How phases advance: **normal** (recommended) / **relaxed** (a missing prerequisite is a warning, and you decide whether to fix it or go on) / **auto** (relaxed without asking)
4. Whether the original program can be built and run here
5. (Only if it cannot) whether a specification or a test suite the target can use exists

Per-role models and efforts, output folders, build and test commands and so on are changed in that file. Every entry is described in [detailed usage](docs/REFERENCE.en.md).

## The ten phases

Phases run in the order `00 → 00b → 01 → 02 → 03 → 04 → 05 → 05b → 05c → 06`, and a phase does not start until the previous phases are recorded. Each phase ends with its artifacts, what to check and the next phase. Who calls the AI, and how many times, in each phase is drawn in the [visual guide](guides/migration-guide.html).

| Phase | What it does | Main artifacts |
|---|---|---|
| [00](prompts/00-feasibility.md) | Checks whether the migration fits and its scope | `migration/feasibility.md` |
| [00b](prompts/00b-judge-setup.md) | Builds the old-versus-new comparator and checks it catches a broken implementation | Comparator, original tests |
| [01](prompts/01-dependency-map.md) | Maps file dependencies; sets the translation order and the source-to-target table | `migration/manifest.tsv`, dependency declaration |
| [02](prompts/02-gap-inventory.md) | Lists semantic differences between the languages and decides the translation rules | `migration/RULEBOOK.md`, `inventory.tsv` |
| [03](prompts/03-stress-test.md) | Tries the rules on a few hard files and fixes the rules | `migration/stress-test/report.md` |
| [04](prompts/04-translation-kickoff.md) | Translates every file, each reviewed by two independent reviewers | Translated sources, review records |
| [05](prompts/05-survey-build.md) | Builds everything and repairs errors with reviews | Build results, repair records |
| [05b](prompts/05b-smoke.md) | Starts and operates it to check basic behavior | Smoke results |
| [05c](prompts/05c-parity.md) | Runs old and new on the same inputs and compares | Case counts, differences |
| [06](prompts/06-post-parity.md) | Sorts out what remains and hands it off | Remaining issues, handoff |

Before 03, guardrails (`migration/guardrails.json`) are installed with your confirmation. They stop AI sessions from running commands that rewrite git history, and build or test commands, directly (the kit runs builds and tests itself and records them).

### When the original does not run or there is no specification

- If the original cannot run, the run uses [source-only mode](docs/SOURCE-ONLY.md), which hands off the old-versus-new comparison (05c) as unverified.
- If there is no specification either, setup switches to [source as the only specification](docs/SOURCE-AS-SPEC.en.md). The AI drafts the 00b, 01 and 02 artifacts together, and after one review by you the run continues from 03.

## Safety

- **The original source is never rewritten.** Workers only read files; the kit itself writes only the target files.
- **Reviews are independent.** Both reviewers receive the same frozen input and never see each other's results. Only when the input is too large do they get a file list with hashes and read it with read-only tools, which is recorded. The input limit `maxReviewInputBytes` is 1048576 bytes (1 MiB) for new installs.
- **"Done" is checked against records.** A file merely existing is never done; hashes of inputs, outputs and reviews are kept. When the source or the rules change, the related approvals and completions are revoked automatically.
- **The RULEBOOK is protected.** After phase 01, an AI edit of `migration/RULEBOOK.md` first keeps the current text in `migration/rulebook-history/`. Once translation has started, the edit asks for confirmation (in auto mode the edit is refused and the file is repaired instead). After phase 02, `rulebook changes` shows a change and the files it may touch, and `rulebook accept` keeps everything else, so only the files you choose are redone.
- **Work is not cut short.** Normally nothing stops on time or call counts, and transient network errors are retried after a wait ([every stop condition](docs/INTERRUPTION-POLICY.en.md)).

## AI usage and billing

Copilot bills by tokens used, in **GitHub AI Credits**. Each worker call is one Copilot CLI call and uses your account's AI Credits. The orchestrator you chat with uses its own share as well.

The `usage` command shows the tokens and AI units the kit's workers used, in total, by role and by model. The CLI reports no conversion to AI Credits, so no amount is shown ([usage records](docs/COST-LOG.en.md)). As the phase table suggests, translation and review in 04 call the AI the most.

## Verification status

| Item | Status |
|---|---|
| Automated tests and the bundled demo (no AI) | Run on Windows and Ubuntu for every change |
| Connection to the real Copilot CLI (with a stand-in model) | Checked on macOS |
| Runs with a signed-in real model | Run up to the phase-03 trial on the maintainer's Windows PC (as of 2026-10-31) |
| Translation quality through the last phase | Not evaluated yet |
| Use from the VS Code and Copilot app screens | Partly checked (for example, the orchestrator shows in the agent picker); not exhaustive yet |

Before a real project, run the [small check with a real account](docs/LIVE-SMOKE.en.md).

## Documents

| To read about | Document |
|---|---|
| How it works, AI calls per phase, differences from the original kit | [Visual guides](guides/README.md) |
| Settings and commands in detail | [Detailed usage](docs/REFERENCE.en.md) |
| Installing and updating the plugin | [PLUGIN.en.md](docs/PLUGIN.en.md), [UPGRADING.en.md](docs/UPGRADING.en.md) |
| Phase order and modes (normal, relaxed, auto) | [ORDERED-WORKFLOW.en.md](docs/ORDERED-WORKFLOW.en.md) |
| Splitting preparation reading (survey) | [SURVEYS.en.md](docs/SURVEYS.en.md) |
| Dependency mappers (Python, JS/TS, C/C++, C#, Java, VB.NET, PHP, COBOL) | [DEPENDENCY-MAPPERS.en.md](docs/DEPENDENCY-MAPPERS.en.md) |
| Phase 03 steps | [STRESS-TEST-CHECKLIST.en.md](docs/STRESS-TEST-CHECKLIST.en.md) |
| Changes | [CHANGELOG.md](CHANGELOG.md) |

The rules the orchestrator reads start at [OPERATING-MANUAL.md](docs/OPERATING-MANUAL.md). The original kit's documents are kept in [UPSTREAM-README.md](docs/UPSTREAM-README.md), [UPSTREAM-CLAUDE.md](docs/UPSTREAM-CLAUDE.md) and [RUN-NOTES.md](RUN-NOTES.md), and the pinned upstream commit in [UPSTREAM.json](UPSTREAM.json).

## Developing the kit

In the kit repository run the commands below. They need no AI usage or sign-in. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test
npm run demo
```

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for notices.
