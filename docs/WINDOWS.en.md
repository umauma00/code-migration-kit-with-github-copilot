# Using the kit on Windows

[日本語](WINDOWS.md) | English

Windows is a primary platform for this kit. GitHub Actions runs `npm test` and `npm run demo` on `windows-latest` (Windows Server, PowerShell 7, Node 22, Python 3.12) for every change. A live run with the Copilot CLI and VS Code is still pending (see [LIVE-SMOKE](LIVE-SMOKE.en.md)).

## Requirements

| Requirement | Example install | Check |
|---|---|---|
| Node.js 22 or later | `winget install OpenJS.NodeJS.LTS` | `node --version` |
| Git for Windows | `winget install Git.Git` | `git --version` |
| Python 3 (bundled dependency parsers, demo) | python.org installer (includes the `py` launcher) | `py -3 --version` |
| Copilot CLI | `npm install -g @github/copilot` (a `copilot.exe` from WinGet or elsewhere also works) | `node migration-kit/scripts/run_migration.mjs doctor --check-cli` |

On Windows `python3` is often missing or only opens the Microsoft Store. Commands the kit prints use `py -3` when the launcher exists, otherwise `python`.

## What the kit handles on Windows

- **Starting the Copilot CLI**: npm's `copilot.cmd` shim runs the bundled `copilot.exe` (or `node` with the loader), also from a terminal whose PATH lacks npm's folder.
- **`.cmd` / `.bat` commands**: `commands` in `migration/config.json` may name `npm`, `npx`, `mvn`, `gradlew.bat` and the like. The kit runs them through `cmd.exe /d /s /c` with each argument quoted and escaped, so spaces, `"`, `%` and `&` arrive unchanged.
- **Guardrails**: `npm.cmd test`, `& "C:\...\npm.cmd" test`, `cmd /c git push`, `Start-Process git -ArgumentList push` and `py -3 -m pytest` match the same rules as `npm test`, `git push` and `python -m pytest`. PowerShell writes to `migration/guardrails.json` (`Set-Content`, `Out-File`, `Remove-Item`) are denied.
- **File replacement**: when another process (status polling, an editor, antivirus) briefly holds a record open, the replacement is retried for about two seconds.
- **Line endings and encoding**: the dependency parsers and the manifest generator write UTF-8 with LF; TSV and Markdown checked out with CRLF are read correctly.
- **Diagnostics**: absolute paths with spaces (`C:\Users\Taro Yamada\...`) and backslash relative paths (`ported\a.mjs`) map to manifest targets.

## Things to watch

- **Command syntax**: `commands` are argv arrays; PowerShell syntax (pipes, `;`) does not apply. Put several steps in one script such as `node scripts/check.mjs`.
- **Folder trust**: the Copilot CLI ignores `.github/hooks` in untrusted folders. Start `copilot` interactively in the target repository once and trust it (`doctor` checks this).
- **Long paths**: deep folders can hit the 260-character limit. Keep the repository short (`C:\work\proj`) or enable Windows long paths.
- **Line-ending conversion**: Git `core.autocrlf=true` works, but changing it mid-migration changes file hashes and revokes approvals.
- **WSL**: inside WSL the kit runs as on Linux; do not mix the Windows Copilot CLI with WSL-side files.
