# 0.4.0 — 2026-10-23

- 2026-10-23 dependency mappers for C#, Java, VB.NET, PHP and COBOL
  (`scripts/depmap_csharp.py`, `depmap_java.py`, `depmap_vbnet.py`,
  `depmap_php.py`, `depmap_cobol.py`). Only Python, JS/TS and C/C++ had one,
  so for a C# source an agent wrote and ran its own .NET tool, which read as
  if it ran the original. The new mappers use the Python standard library
  only, read source text only and keep the edges/order/cycles contract; they
  also write `unresolved.tsv` (dynamic includes and CALLs, reflection with a
  computed name, imports of undeclared repository types). C#, Java and
  VB.NET resolve type names through namespaces, imports, aliases, global
  usings (.cs/.csproj/.vbproj), extension methods, VB module members and
  partial types, in the language's lookup order (innermost namespace first,
  with the usings of each namespace declaration at its own step;
  Java single-type import, own package, then `pkg.*`). Types whose name is
  never written are followed through declared types: member and return
  types, base types, parameters, typed and `var` locals, foreach variables,
  indexers and generic element types (`var x = f(); x.M().N()` reaches every
  type on the way). `.csproj`/`.vbproj` ProjectReference and Maven/Gradle
  module dependencies narrow a name declared in several projects to the
  referenced ones, and files a .NET project does not compile declare
  nothing. Every name is resolved from the namespace block it is written in
  (a file with two blocks no longer merges them, and the output no longer
  depends on the hash seed), `global::`/`Global.` names from the root only,
  and global using aliases and project imports apply to their own project's
  files. A using alias or using static inside a namespace block applies to
  that block and the blocks nested in it only. `global using static` (and
  `<Using Static="true">`) gives an edge from each file of the project that
  names a member of the type. `<Compile Include/Remove>` values are item
  lists (`a.cs;b.cs`); `*` and `?` stay within one directory and `**` spans
  any depth; attributes may use either quote. A file left out only under a
  Condition keeps its declarations and is listed in `unresolved.tsv`.
  MSBuild paths are matched without case, as on Windows, and a
  ProjectReference is read whatever its attribute order. A name in an
  attribute list (`[Foo]`, `[A.B.Required]`, `[return: Foo]`) counts both
  `Foo` and `FooAttribute`; elsewhere, collection expressions
  (`F([Foo])`, `{ [Foo] }`) included, `Foo` does not mean `FooAttribute`; the
  types in a tuple alias (`using P = (A a, B b);`) count where it is written. Checked on old open
  source trees (Nancy, ShareX, Umbraco 7, WordPress, phpBB 3.0): C# extension
  methods are narrowed by receiver type (static calls such as `string.Join`
  do not count; `x.Add()` on a framework type with an unknown receiver is
  listed in `unresolved.tsv`); nested types are not reported as duplicates;
  a PHP declaration behind `!function_exists('f')` is used only when no
  unguarded one exists; PHP include paths take `--include-var NAME=VALUE`,
  constants with one relative `define()` literal and nested
  `dirname(dirname(__FILE__))`; Windows-1252 text is no longer reported as
  cp932, and a missing ProjectReference says it is missing. Checked again on
  NHibernate 3.3.1, NUnit 2.6.0, Drupal 7.0, MediaWiki 1.16, Tomcat 7.0.0 and
  Jenkins 1.416: a nested type's name means the nested type of its own file
  (and `Outer.Inner` anywhere), so same-named nested classes such as Java's
  `DescriptorImpl` are no longer duplicates or false edges; a name a C#
  declaration introduces (`string Schema {`) is not a type reference; PHP
  reads Drupal `.install`/`.test`/`.theme`/`.engine`/`.profile` files that
  contain `<?php`, replaces `--include-var` values inside strings
  (`"$IP/x.php"`) and uses `define()` constants whose value is a computable
  path. When a bundled mapper fails or cannot read a project's syntax, the
  docs, skill and prompt 01 say what to do: try its options, then fix a copy
  under `migration/tools/depmap-<language>/` and report it. A new
  depmap-adapter skill guides writing an adapter: Python (copying a bundled
  mapper) or another installed language, which mapper to start from, the
  fixture and the habits that keep it right. An imported namespace or
  package no file under `--root` declares (C#, VB.NET, Java, PHP; platform
  libraries left out) is listed once per library in a new `external.tsv`, so an
  in-house library outside `--root` is not silently missed. A
  using or alias target inside a namespace block is relative to the
  enclosing namespaces, and once resolved is kept as a full name.
  VB.NET joins implicitly continued lines (a trailing comma, an open
  parenthesis). Build-output and third-party directories (bin, obj,
  target, build, out, vendor, packages) are skipped only at `--root` or
  beside a build file, so a Java package named `build` is mapped, and each
  skipped directory holding sources is printed as a warning; `generated`
  directories are mapped. Names inside C# interpolation holes count in
  every form (parenthesized ternaries, `global::`, `$"""` and `$$"""` raw
  strings), and so do those in VB.NET `$"...{expr}..."`. A file name that is
  not UTF-8 is written with its original bytes, with a warning to rename
  it before `make_manifest.py`, which stops with a clear error on one.
  `#if` branches that leave a brace open no longer shift the C# namespaces
  after them; `using global::R;` in a namespace block (and an alias to
  `global::X`) is never read as relative; enum members count for
  `global using static`; a VB.NET line starting with `.` continues
  the previous one (outside With); PHP existence checks
  (`function_exists('f')`) are not references; COBOL keywords match whole
  words only (`ON-CALL`, `END-CALL`); directory symlinks are followed
  and only a loop back to an ancestor is stopped. A type declared without
  `partial` in two files is no longer linked to its copy (a false cycle);
  users get an edge to each and the copies are listed in `unresolved.tsv`.
  MSBuild Include/Remove apply in document order, an Include's `Exclude`
  applies to that item (`Update` is not read), an item that uses a
  property (`$(Gen)`) is treated like a Condition, a file linked in from
  another directory belongs to every project that compiles it (its global
  usings, references and VB RootNamespace apply), a conditional
  `EnableDefaultCompileItems` keeps the default files as "maybe", and ProjectReference paths
  ignore case; Gradle Kotlin `project(path = ":x")` and `projects.x`
  accessors are read. C# 14 `extension(...)` blocks, attributed enum
  members, VB.NET `Imports A, B` and PHP 7 classes named `Enum`, `Match` or
  `From` are understood; a Java import on the same line as `package` is
  read; PHP `{$...}` holes in strings and heredocs are code, and a
  `class_alias` alias is a class of its file. Code nested past Python's
  recursion limit is parsed on a larger stack instead of stopping the
  mapper. Lambda parameters, generic inference and overloads
  are not followed. PHP follows computable
  include paths and case-insensitive class/function names with namespaces
  and `use`, narrowed by composer.json autoload (PSR-4, PSR-0, classmap),
  with `--include-path` (an explicit `./` or `../` include never uses it:
  it is looked up next to the including file and at `--root`, and is listed
  as unresolved when those differ; `DIRECTORY_SEPARATOR`, `DS`,
  `realpath()` and a trailing `or die(...)` are understood), and string
  callables (a string argument of `array_map`, `usort`, `call_user_func`,
  `add_action`... and `['Cls', 'm']` pairs, by plain or namespaced name)
  give edges to the function or class of that name; COBOL follows COPY, EXEC SQL INCLUDE, CALL 'X' (also with
  the literal on a later line) and EXEC CICS LINK/XCTL in fixed or free
  format, with `--copy-path` as the copybook search order. Non-UTF-8 sources are read as cp932,
  then Latin-1, with a warning. `source-spec check` suggests the mapper for
  these languages. [Dependency mappers](docs/DEPENDENCY-MAPPERS.md) lists
  them and says how to write an adapter for any other language (static only,
  under `migration/tools/`, same output files, hand-written fixture first);
  the skills and prompt 01 point to it. Fixtures and expected outputs for
  each language are tested with `python -I`.

# 0.3.2 — 2026-10-23

- 2026-10-23 phase 01 on Windows: generating the review dependency map was
  refused as a write to `migration/guardrails.json`. The hook took any
  non-read command naming the file, or a pattern matching it, as a write, and
  knew only POSIX readers, so `Test-Path migration/guardrails.json`,
  `Get-Item migration/*` or `Format-Table *` after `Set-Location` on the same
  line refused the whole line. PowerShell and cmd.exe readers and formatters
  (`Test-Path`, `Get-ChildItem`, `Get-Content`, `Select-String`, `findstr`,
  `Select-Object`, `Format-Table`...) now count as reads, in any letter case.
  The exemption holds only when every command they pipe into is a reader or
  writes to a target named in its own segment (`Out-File`, checked on that
  target); a script block (`{ ... }`) or a pipe into `Remove-Item`,
  `Set-Content` or `iex` voids it. The refusal names the word that
  matched, and the `guardrails-write` guidance offers dropping it or splitting
  the line when no change was meant. Command names compare in any letter case
  everywhere in the hook, as Windows treats them: `remove-item -Recurse
  migration`, `set-location migration; remove-item guardrails.json` and a deny
  rule against `GIT push` or `NPM test` were missed before; `mi`, `Rename-Item`
  and `ren` now count as moves. A method call on what a reader returns
  (`(Get-Item migration/guardrails.json).Delete()`, `[IO.File]::Delete(...)`)
  voids the exemption, a listing of `migration/` piped into a command that
  changes what it receives (`Get-ChildItem migration | Remove-Item`,
  `ls migration | xargs rm`) is refused, and `-Path:value` counts like
  `-Path value`. Pipes are read per pipeline: a command after `;`, `&&`,
  `||` or a newline is not piped from the one before it.

- 2026-10-23 phase 00 on Windows stopped twice for no kit reason. The host's
  own source check took a `/P` switch for a literal credential, then read
  `guidance --message` as a second failure: an unknown message printed "This
  step did not succeed / Unexpected error". `guidance --message` now heads its
  output "What to do about this message" with a note that guidance itself
  succeeded (`explained: true` in JSON), and a message the kit has no entry
  for no longer claims an operation failed. A new `credential-candidate` rule
  says the kit runs no secret scan and no phase stops on one, that a switch
  alone (`set /P`, `xcopy /P`, `-p`) is not a credential, and offers the person
  checking the line, continuing 00 without reading it, or moving a real value
  out. Guidance never repeats a candidate message (Markdown or JSON), since it
  may hold the value, and masks an assigned `password=`/`token:` value in any
  other, as well as the value after a password switch (`-P`, `/P`, `/RP`).
  Protection and classification are separate. A message that names a
  credential, assigns a password, secret or token value, or has a value
  after a password switch (any characters) is never repeated, and its words
  are removed from every field a rule built from it (cause, choices,
  commands). Values are found by syntax, not by how they look: an
  assignment key in any case (`TOKEN=`), a quoted value, a short or
  lowercase one, a key inside a longer name (`DB_PASSWORD=`, `MYSQL_PWD=`),
  or a value attached to a SQL client's switch (`sqlcmd -Pvalue`,
  `mysql -pvalue`). Rules are chosen on the message as given, but build their
  text from captures of the protected message. A finding left after clean
  phrases are cut out wins, however it is joined, and wins over another rule
  (a worker's output carrying one); anything else left that names a
  credential is unsure, never clean; a credential check that failed, lacked
  access or was skipped gets `credential-incomplete` ("0 errors" and
  「エラーなし」 are not failures), while a build or worker failure that only
  names a password keeps its own rule. A clean phrase from a check that
  crashed, ran in part, timed out, hit a limit or exited non-zero is
  incomplete, not clean. A clean result
  ("No credentials detected", "0 matches", "found no issues", "passed",
  「検出されませんでした」「問題なし」) gets
  `credential-clear`, which is informational: `actionRequired: false` in JSON
  and a next step instead of choices in Markdown, so no question; Japanese
  findings such as 「検知しました」「見つかりました」 are recognized. Prompt 00's
  "Credentials in the source" says to stop reading a candidate line, keep
  only its file and line number, and pass guidance a description, never the
  tool's raw output: skipping the survey alone protects nothing.

# 0.3.1 — 2026-10-23

- 2026-10-23 every command line is checked against one spec per script
  (`lib/cli.mjs`). The scripts used to read any `--option` as taking the next
  word and ignored unknown options and stray words, so `phase --help` failed
  with "Missing value for --help" and a typo did something else or failed far
  from its cause. Now an unknown option, a missing value, an option that does
  not apply, a missing or extra word and a value outside its set (phase IDs,
  approval stages, `--format`, `--stage`...) stop with the accepted options,
  and `--help`/`-h` prints the usage on any command. A command-line error gets
  its own guidance (nothing ran; check `--help`). The guardrail hook takes the
  runner's flags and commands from the same spec, and a plain help call is no
  human gate (one with a comment, redirection, substitution or continuation
  still is). `tests/cli-usage.test.mjs` parses every command written in the
  guides, prompts, skills, agents, HTML guide and failure guidance; it found
  `survey --kind facts` in the skills, now `survey run --kind facts`.

- 2026-10-23 models and efforts are chosen in one question. The skill asked
  one question per role (and per effort); it now asks once, and
  `models set --assign "implementer=ID:EFFORT,reviewers=ID:EFFORT,..."` records
  the whole answer under one confirmation, checking every entry before it
  writes anything. `models list --format markdown` shows the form.

# 0.3.0 — 2026-10-23

- 2026-10-23 guardrails cover keystrokes typed into a running shell. On
  Windows, Copilot CLI's shell tools are `powershell` and `write_powershell`;
  the hook knew only `write_bash`, so `git push{enter}` sent with
  `write_powershell` passed `migration/guardrails.json`. With either tool,
  `{enter}` also hid the command (`git push{enter}` matched no rule). The hook
  now replays the input as the shell receives it: `{enter}` or a raw CR/LF
  runs a line, which later edits cannot take back, and `{left}`/`{right}`/
  `{backspace}` edit the current line (keys as in CLI 1.0.60). Keystrokes whose
  result it cannot see are denied while guardrails are installed: `{up}`/
  `{down}` (history or a menu), Tab (completion), other control characters, an edit reaching text
  typed before the call, and text left for a later `{enter}`.

- 2026-10-23 Copilot CLI 1.0.103 compatibility: workers no longer pass
  `--no-remote-export`. 1.0.103 renamed it to `--sync-session off` and stops
  with "--no-remote-export was renamed", so `doctor --check-cli` reported a
  missing option and no worker could start. Worker session sync now follows
  the person's CLI setting; no replacement flag is passed, so older and newer
  CLIs both run. Flags that change nothing the runner reads are no longer
  passed either: `-s`, `--no-color`, `--no-ask-user` (with JSON output and
  `--available-tools view,grep,glob` they made no difference on 1.0.103) and the
  session `--name`, which needed its own length workaround (100 characters,
  1.0.98). Sessions keep their runner-chosen `--session-id`.
- 2026-10-23 steps 00-02 without avoidable stops:
  - `doctor` runs before the worker models are chosen: it reports them as the
    failed check `worker models chosen` (guidance: `models list`, then
    `models set`) and runs every other check. Before, it stopped with
    "Set an available model ID" explained as an unexpected error.
  - Japanese questions may offer model IDs (`gpt-5-mini`, `claude-sonnet-4`)
    as choices: an ASCII identifier with a digit is a name, not English words
    (adjacent Japanese such as `候補1` still counts; `read-only` stays English).
    Before, the hook denied the model question.
  - Folder trust on Windows compares paths without regard to case, so a
    folder stored as `c:\work` is trusted for `C:\work`.
  - `phase check 00|00b|01|02|03` checks what `phase complete` checks, so a
    template RULEBOOK or a missing report is found before the person reviews.
- 2026-10-22 Windows as a primary platform (see docs/WINDOWS.md):
  - `commands` may name `.cmd`/`.bat` tools (`npm`, `npx`, `mvn`,
    `gradlew.bat`): they run through `cmd.exe /d /s /c` with every argument
    quoted and escaped as cross-spawn does. Before, Node refused to start them
    without a shell. A batch file named with its extension (`gradlew.bat`) is
    also found in the project folder; a bare name is looked up on PATH only.
  - Guardrails match `npm.cmd`/`git.exe`, the PowerShell call operator,
    `cmd /c`, `Start-Process` (switches such as `-Wait` take no value;
    abbreviated and `-Name:value` parameters are read) and `py -3 -m pytest`.
  - The dependency parsers and `make_manifest.py` write UTF-8 with LF (the
    Windows default was the console code page and CRLF) and never crash
    printing a path the console cannot encode.
  - Atomic replacements retry briefly on Windows sharing violations.
  - Node diagnostics keep absolute paths with spaces; printed commands quote
    a kit path with spaces and use `py -3` or `python` instead of `python3`.
  - CI runs `npm test` and `npm run demo` on windows-latest and ubuntu-latest.
- 2026-10-22 fewer repeated confirmations, compared with upstream step by step
  (guardrails and every confirmation's hook ask stay):
  - `build-loop --through smoke|parity` extends the one host-confirmed grant to
    upstream Steps 5-6: after a clean build it approves and runs smoke (then
    parity), sends their mapped failures to reviewed repairs and starts the next
    round from build. Before, every repair made the person approve build, smoke
    and parity again. A failing original suite or an unmapped failure still
    stops the loop; source-only refuses `--through parity`. Rounds record their
    `stage`; `stalled` compares rounds that failed at the same stage.
  - `approve translation --complete-phase 03 --note TEXT` records the reviewed
    phase 03 and the translation approval under one confirmation (the hook
    names both). `phase complete 03` alone still works.
  - New installs set `fixPolicy: single-pass` (upstream Step 3). Existing
    configurations keep their value; one without the key keeps `rereview`.
  - Prompts 00/00b no longer repeat the findings format PHASE-HANDOFF defines.
- 2026-10-22 phase 00 reads the source the way upstream does: the parent
  samples it and names what it skipped. `survey --kind facts` is optional
  there, so a Copilot CLI launch failure no longer stops the feasibility
  report; 00b (source-as-spec) and 02 keep the survey. On Windows, a bare
  `copilot` that PATH does not resolve is also looked up in npm's global
  prefix (`npm_config_prefix`, the user `.npmrc` prefix with `${VAR}` and `~`
  expanded, `%APPDATA%\npm`), and quoted PATH entries are read. A v0.3.0
  survey stopped with `spawn copilot ENOENT` while `doctor --copilot PATH`
  passed. Not yet run on a real Windows machine.
- 2026-10-22 the report language holds for the whole session. The interactive
  hook denies a question-tool call (Copilot CLI `ask_user`, VS Code
  askQuestions) that does not ask 日本語 / English while
  `migration/preferences.json` has no language, and, with `ja`, one whose
  question text (each question separately, not its header or backticked
  text) has no hiragana and, after setting aside whitespace-separated paths,
  no Japanese or two or more English words, or with a choice of two or more English
  words. Long sessions drifted back to English questions after
  compaction and English tool output. The VS Code tool name is matched by
  pattern and not yet checked in VS Code.
- 2026-10-22 preparation audits no longer stall on a host subagent. The
  auditor profiles now set `disable-model-invocation: true`, and the
  orchestrator, prompts 00b/01/02, skills and docs name `audit_inputs.mjs run`
  as the only way to start one: a tool-free auditor reached through the task
  tool got a path it cannot open, or a retyped body that breaks the hash
  binding. New `audit_inputs.mjs run-pending` runs every request without
  result.json, config.concurrency at a time, and reports each outcome. The
  profile change invalidates unsubmitted requests: freeze replacements, then
  `audit_inputs.mjs retire --directory OLD --superseded-by NEW --reason TEXT`
  each old one. retired.json keeps it as evidence with its replacement; run,
  submit and run-pending skip it.
- 2026-10-21 Windows: a Copilot CLI installed with `npm install -g
  @github/copilot` now starts. Node cannot run the `copilot.cmd` shim without a
  shell, so workers, doctor and `models list` run the bundled
  `copilot-win32-<arch>/copilot.exe`, or `node npm-loader.js` when it is
  missing. Only shims that reference the package's `npm-loader.js` are
  rewritten. Not yet run on a Windows machine.
- 2026-10-21 model choice by the person running the kit:
  - `run_migration.mjs models list [--format json|markdown]` reads the
    signed-in account's models from the Copilot CLI headless server
    (`models.list`, the call behind the SDK's `listModels()`): ids, policy
    state, supported reasoning efforts with the default, and token prices
    (`inputPrice`/`outputPrice` per `batchSize`, scaled by the unit from
    `models.listTokenPriceUnits` to AI Credits per million tokens).
  - `models set --role ROLE|reviewers|all --model ID [--effort LEVEL|default]`
    records the choice after checking the model is listed and enabled and the
    effort is one it supports. The hook asks the person to confirm it.
  - New optional `reasoningEfforts` per worker role (surveyor follows the
    implementer only while it has no model of its own, so an explicit
    "default" is honored; `--role all` returns it to the implementer's
    choice; the effective model/effort pairs, inheritance included, are
    checked against the list). Workers get `--reasoning-effort`; receipts record
    `requestedEffort`. Like `models`, it is reviewed configuration, so a change
    makes reviewed units be reviewed again. Worker profiles may not set model
    or effort fields of their own.
  - The skills ask for model and effort per role from the live list instead of
    asking the person to type model IDs.

- 2026-10-19 follow-up (questions, failure reports and progress):
  - Failure guidance: every rule offers at least two choices plus pause, with
    the recommendation first; a contract test holds each rule to it.
    `guidance --format json` adds `choices`, the option labels for the host
    question tool. New rules: `cannot-ask` (a refused confirmation, or the
    Copilot CLI autopilot answering `ask_user` itself, is not an answer),
    `guardrail-denied` and `guardrails-write` (the kit's own hook denials).
  - Phase order: an error names only the immediate predecessor, and its
    guidance recommended recording that phase, which failed the same way while
    an earlier phase was incomplete. The guidance now leads with the phase
    `phase next` reports. Source-only 05c recommends the unverified
    acknowledgment (`phase complete 05c`) instead of a runner stage.
  - `doctor` shows the review dependency map as pending until phase 01 is
    recorded, so a new project's phase 00 check no longer fails with a command
    that cannot run yet; the guidance points at phase 01 until a map exists.
  - Questions: Copilot CLI `ask_user` takes one question per call with optional
    string choices (CLI 1.0.98), so setup questions are asked one at a time
    there and grouped only with VS Code `vscode/askQuestions`. A free-text reply
    that picks no choice is not consent. The plugin orchestrator also lists
    `vscode/askQuestions`.
  - Progress: `status --format todo` descriptions follow the report language.
    PHASE-HANDOFF notes that Copilot CLI `update_todo` takes one markdown
    checklist (`status --format checklist`), and that TODO and question tool
    failures use their chat fallbacks rather than a failure report.
  - Review follow-ups (PR #4):
    - Arbitration: two findings citing the same source path:line were confirmed
      without the arbiter, even when they asked for opposite changes (for
      example rounding toward negative infinity and toward zero). Every
      finding now goes to the arbiter; same-location pairs reach it as
      `samePlace` candidates, and it confirms both only if they ask for
      compatible changes (upstream rule 4). A unit whose findings were all
      paired makes one more arbiter call.
    - TODO status: the current phase is `in-progress` only while it runs or is
      worked on; waiting, blocked or not yet started it is `not-started` with
      its state in the title, as PHASE-HANDOFF's three-state rule says.
      `status --format todo` adds `current`, and the checklist arrow follows it.
      The state is computed for the final current phase, so a running pilot
      shows 04 as running instead of the parent flow's phase state.
    - Guidance commands run as written: `survey status` takes the kind the
      error names (none when unknown), and the original-runtime question has
      no `a|b` placeholder command. A git denial recommends keeping history
      (`git status --short`) instead of running a runner stage.

- 2026-10-19 review (Copilot CLI 1.0.98 and 1.0.100-1, current VS Code docs):
  - Resumption: the receipt context hashes only what reaches workers. Run limits
    (`concurrency`, `maxAgentCalls`, `maxFixRounds`, timeouts, retries,
    `maxRunInputBytes`, `maxAiCreditsPerCall`), formatting of `config.json`,
    documents, phase prompts, skills and `.github/copilot-instructions.md` no
    longer revoke reviewed units, phase records and approvals. Before, lowering
    `concurrency` after rate limits sent a finished translation back to phase 02.
  - `translate|repair --max-calls N` sets one run's AI call budget without
    editing the configuration; `status --wait SECONDS` waits runner-side for
    progress so the parent agent checks a long run with few model turns.
  - Usage: every worker passes `--usage-output-file`; attempts record the CLI's
    own token, cache and AI-unit counts as `cliUsage`, run summaries total them
    as `measuredUsage`, and cost-log rows get measured tokens. Optional
    `maxAiCreditsPerCall` passes `--max-ai-credits`. The CLI version is checked
    once per 10 minutes per run instead of before every call.
  - Preparation audits: `audit_inputs.mjs run` runs a frozen request on the
    tool-free auditor as a fresh CLI worker with `--model` from phaseModels and
    records the CLI-reported model, version, session and usage.
  - Upstream Step 6: `diagnose|repair-round --stage smoke|parity` and
    `diagnostic_queue.mjs --stage` turn smoke/parity regressions into reviewed
    repair queues; a failing original suite is refused as inherited.
  - `doctor --check-cli` proves with a loopback model (no account or AI use)
    that the tool-assisted reviewer hook still loads in prompt mode, the one
    undocumented CLI behavior the kit depends on. Agent-scoped hooks do not run
    in prompt mode, and `--trust-folder` (1.0.99+) also loads the folder's other
    configuration, so the narrower switch stays.
  - LIVE-SMOKE adds VS Code Allow all/Autopilot gate checks and local sandboxing.
  - Fixes found on a pinned CLI 1.0.98 (`COPILOT_AUTO_UPDATE=false`; otherwise a
    cached newer build runs): worker session names are capped at the CLI's
    100-character limit (a deep target path made every call fail with "Session
    name must be 100 characters or less"); the orchestrator profiles also list
    `grep`, `glob` and `update_todo`, which 1.0.98 does not map from the `search`
    and `todo` aliases; a prerelease CLI version is recorded without the
    trailing period.
  - Review follow-ups (PR #3): `maxAiCreditsPerCall` must be at least 30, the
    CLI minimum; parity repair queues are refused when the original suite failed
    or did not run, on every path (parsed output, hand-written TSV, and when a
    queue is read); preparation audits compare the on-disk configuration, so a
    model change during an audit voids its result; a retried call counts the
    failed attempt's usage or leaves the run total unknown.

- Remove the VS Code subagent (native) worker backend: its runner adapter,
  claim/submit CLI, profiles, doctor checks, guidance and docs. Workers always
  run as Copilot CLI processes, also when the migration is driven from VS Code
  chat. A configuration that still names the native backend or its keys stops
  with migration instructions; the installer refuses `--worker-backend native`.
- Chat-only operation: the skill and orchestrator run every command themselves,
  install the Copilot CLI (`npm install -g @github/copilot`) and start
  `copilot login` after the person agrees. `run_migration.mjs guardrails show`
  proposes the deny list and `guardrails install` writes the agreed list as a
  host-confirmed human gate, so phase 03/04 no longer needs a manual file copy.
- Review follow-ups:
  - `build-loop --note TEXT [--max-rounds N] [--max-calls N]`: one host-confirmed grant runs
    upstream Step 4's build → diagnose → reviewed repair → rebuild rounds until
    clean, the round limit (default 5) or a stalled error count; every round's
    build approval records `loop: {grantId, round}`.
  - `reviewFocus: shared` (new installs) gives both independent reviewers both
    checks, each from its own lens first; `specialized` keeps upstream's split.
  - Worker sessions: `--no-remote-export` keeps transcripts (source code and
    prompts) off the GitHub account (the CLI's help: no export to GitHub web and
    mobile, no remote control; 1.0.98 accepts the flag, its effect on an
    authenticated account is not verified yet); each call gets `--session-id`/`--name`,
    recorded as `cliSessionId`. `sessions status | prune` reports or deletes only
    those; `sessions prune` and `build-loop` are host-confirmed.
  - Open files: the CLI raises its own soft limit to the hard limit (soft 256 →
    hard observed on 1.0.98), so `doctor --check-cli` checks the hard limit (at
    least 4096) and EMFILE stops the run with `file-limit` guidance.
  - `status` shows workers retrying after a rate limit or service error and adds
    a next action to tell the person.
  - Tool-assisted reviewer path check resolves symlinks (also through a missing
    leaf) and compares record directories case-insensitively.
  - `.github/copilot-instructions.md` managed block trimmed to the always-needed
    rules (about 640 bytes); the skill carries the rest.
- Second-opinion review fixes:
  - Human gates: the hook now splits commands like a shell (quoted values with
    spaces, `--option value` read exactly as the runner's parser does, globs on
    the runner path, quoted `bash -c`/`$(...)` command lines). As a best-effort
    text match, a runner or kit module reached in a form it cannot read, with a
    human-act word in the same segment, asks the person ("unrecognized runner
    command"). Forms split across segments, variables or indirection
    (`R=run_migration.mjs; node "$R" approve …`, `xargs`) are not detected.
  - `migration/guardrails.json`: globs, bare names after `cd migration` and
    removing or moving `migration/` itself are denied; strict-phase translate and
    build-loop refuse to run when the file is missing.
  - Sessions: the runner chooses and journals every worker session ID before the
    call (`migration/runs/<run>/cli-sessions.jsonl`), so retried and interrupted
    calls are pruned too; a relative `COPILOT_HOME` resolves against the project.
  - `build-loop --max-calls N` (default `maxAgentCalls`) caps the AI calls of all
    repair rounds together and stops with `budget`; the grant records its owner,
    stage and usage, `status` reports a running loop, and other processes cannot
    take the runner lock between its steps.
  - A hard open-file limit below 4096 is a doctor warning, not a failure.
  - Tool-assisted reviewers may read names that start with two dots (`..notes`).
  - The guardrails template note describes the chat-only install.
- PR #2 review follow-ups:
  - `migration/guardrails.json` protection no longer denies reads: output
    redirections count by their target (`2>/dev/null`, `2>&1` and other files
    are fine), `find` counts only with `-delete`/`-exec`/`-ok`/`-fprint`-style
    actions, and `migration/` resolves from the shell's working directory
    against the project root (`src/db/migration` is not protected; a `cd` in the
    same command line falls back to the name match).
  - HTTP 500 from the model (`session.error … 500`, `500 Internal Server
    Error`) is retried like 502-504; a bare 500 elsewhere in a message is not.
  - Deny list matching splits commands like a shell and checks `bash -c` /
    `pwsh -Command` strings and quoted `$(...)` as commands of their own; it
    skips wrapper options (`env -u X`, `sudo -u user`), git global options
    (`git -C . push`) and options between rule words (`cargo --locked build`).
    Values of other options (`npm --prefix x run`) and indirect forms (`xargs`,
    a variable) remain best effort.
  - Shell parsing keeps a backslash between path characters, so Windows paths
    (`.\gradlew`, `migration-kit\scripts\run_migration.mjs`) are matched
    again; inside double quotes a backslash escapes only `$`, `` ` ``, `"`, `\`.
  - Worker session names end with the first 8 characters of their (always
    new) session ID, so retries and re-runs of a unit do not share a
    `--resume` name.
  - The `build-loop` confirmation says builds run model-written code, the grant
    covers builds of repairs not yet written, and `maxRunInputBytes` also stops
    the loop.
  - Records of the removed native backend carry an archive banner; README and
    CHANGELOG cite the VS Code pages for the harness and prompt-file notes.
  - Human gates in practice: the skill and orchestrator say autopilot denies the
    gate questions (run them interactively) and the CLI may ask a second time;
    LIVE-SMOKE lists the interactive CLI, autopilot, VS Code and
    `--no-remote-export` checks, with `liveChecks` slots (null) in the evidence.
- 2026-10-18 review against Copilot CLI 1.0.98 and current VS Code docs:
  - JSON-mode failures: the CLI reports rate limits, 5xx and authentication only
    as stdout `session.error` events (stderr empty). The adapter now includes
    `errorType`, `statusCode` and the message, so 429/5xx retry and
    authentication/credit failures stop the run (verified on 1.0.98).
  - Prompt-mode hooks: tool-assisted reviewers set
    `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true`. Without it, an untrusted
    repository-copy folder skipped the hook and such a reviewer could read
    `migration/runs` (reproduced on 1.0.98). The variable admits every
    `.github/hooks` file regardless of folder trust, so other roles (limited by
    their CLI tool flags) do not set it.
  - Observed model and usage: CLI attempts record `model.call_final_result` and
    `result.usage`; a model different from the request is a run warning.
  - Scheduling: `dependencyOrder` (`auto` for new installs) stops holding
    dependents when no unit typecheck needs translated dependencies; the
    concurrency cap rises from 16 to 64 and the new-install default to 4.
  - `fixPolicy: single-pass` restores upstream Step 3 (one fix of the confirmed
    findings, then the build/test referees) with its own hash-bound receipt.
  - Windows plugin hook uses `$env:PLUGIN_ROOT` in its PowerShell command.
  - Docs: upstream feasibility report contract restored in prompt 00; bakeoff B
    runs with `--available-tools` excluding `skill` (skill descriptions otherwise
    reach it); VS Code 1.142 Copilot harness, Local-only prompt files, Auto and
    cost-tier subagent limits; skill reads documents only as the phase needs.
    Sources (checked 2026-10-18): [1.142 release notes](https://code.visualstudio.com/updates/v1_142),
    [Prompt files](https://code.visualstudio.com/docs/agent-customization/prompt-files), [AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings), [Subagents](https://code.visualstudio.com/docs/agents/run/subagents).
- Review fixes: the hook asks for confirmation when an approval or phase
  completion is chained after another command (`status && approve …`);
  `survey merge --kind contracts` replaces contracts.md only while it is the
  exact `source-spec init` skeleton; a transient retry re-checks
  `maxAgentCalls` after its backoff; a multi-phase `phase complete` computes
  the judge/context hashes in its dry run, so a missing dependency declaration
  records nothing.
- Delegated preparation surveys: `survey plan|run|status|merge --kind
  facts|contracts|inventory` splits the source into directory/size scopes, sends
  each to a fresh tool-free surveyor (new Copilot CLI process, or a host subagent
  in native mode) and saves each answer as a hash-bound file under
  `migration/surveys/`; merges build facts.md, fill the source-as-spec contracts
  skeleton, or publish inventory shards through the existing census merge.
  New surveyor profiles; `phaseModels.survey` (default: implementer model).
- Upstream fidelity: phase 02 refuses untouched RULEBOOK/inventory templates;
  findings both reviewers raise at the same source line are agreed and skip the
  arbiter (upstream: a third rules only on disagreements); a failing in-loop
  typecheck becomes a confirmed finding for the fixer; `install.mjs --models`
  maps the upstream model plan per role.
- Human gates: the hook denies agent edits of `migration/guardrails.json` and
  asks the person to confirm `approve`, `phase complete`, `pilot prepare` and
  `source-spec init --apply` (verified on Copilot CLI 1.0.98: non-interactive
  sessions refuse them with "unable to ask user for confirmation").
- Parallel resilience: rate-limit/5xx/network failures retry with backoff; a
  unit failure blocks only that unit and its dependents; systemic failures and
  `maxConsecutiveFailures` stop the run.
- Progress: run summaries record startedAt/unitsCompleted; status estimates the
  remaining time, calls and input, and names the current phase's waiting state.
- Failure guidance for doctor checks and blocked units in status, one section
  per distinct cause, and a 00b recommendation that follows
  `preferences --original-runtime`.
- Phase 01: parse Python from the import base (`make_manifest.py --prefix`);
  an all-empty dependency map needs `--confirm-no-dependencies`. One-page phase
  03 checklist. The test runner uses a hermetic COPILOT_HOME.
- Review fixes: failure guidance no longer routes file or diagnostic errors
  containing ENOENT/401/login to CLI install or sign-in, never pre-fills review
  notes, and offers the 00b–02 bundle only in source-as-spec; `phase complete
  00b,01,02` checks every phase before writing any receipt; status checklist/todo
  report unknown progress with its blocker instead of "all complete"; the Python
  parser skips `migration-kit/`/`migration/` only at the top when they are the
  kit, and `make_manifest.py --include` keeps only source roots; `TODO(spec)`
  blocks 00b only in source-as-spec; doctor runs the configured hook command for
  both worker and interactive paths; accurate profile-switch warnings.
- Align with current Copilot behavior: hook denials carry both the CLI
  top-level and the VS Code `hookSpecificOutput` decision; hook timeouts rise
  to 30 s (hooks fail open on timeout) and doctor times the hook; worker
  profiles set `user-invocable: false` and CLI workers
  `disable-model-invocation: true`; doctor lists VS Code native prerequisites
  (1.117+, `chat.customAgentInSubagent.enabled`).
- AI Credits: prompts lead with shared rules and end with the unit target so
  repeated calls share a cached prefix; optional `maxRunInputBytes` stops a run
  at a measured prompt-size budget; run summaries add `usageEstimate`.
- Run the native backend inside VS Code only: `nativeModelVerification:
  requested-unverified` (the default for new native installs) accepts results
  submitted with the requested model and records the executed model as
  unverified in attempts, run summaries, status and doctor. `host-metadata`
  keeps the previous experimental contract; copilot-cli stays the default.
- Add the source-as-spec preparation profile for projects without a runnable
  original or a specification: `source-spec init|check` scaffolds source-only
  preparation from every source file, 00b refuses unfilled `TODO(spec)` contracts,
  and `phase complete 00b,01,02` records one user review of the whole package.
- Every runner failure now prints its cause, impact and choices with one
  recommended option and reasons; `guidance --message` explains other failures.
- Add `status --format todo|checklist` so hosts show the ten phases with exactly
  one current phase; reports start with the checklist.
- The bundled Python dependency parser skips `migration-kit/` and `migration/`.
- Correct the operating manual: VS Code also defaults to the CLI worker backend.

- Preserve every admitted diagnostic repair job across Stop/resume, including
  undispatched dependencies; bind fresh reviews to immutable intent evidence and
  refuse downstream approval until all repair obligations are reviewed.
- Reject fixed inventory receipt/input collisions before any publication; correct
  executable examples and distinguish paired inventory reviews from extra sampling.

- Add sealed, disposable preserve-mode pilot grants before production phase 03,
  without importing experiment receipts or weakening production approval.
- Add early comparator validation/reuse, explicit preparation model plans and
  fixed audit task/result transport; restore source-map and inventory audit
  contracts with deterministic diff/sample/shard tools and package cycle checks.
- Add exact translation batch scopes and a single-lock multi-target diagnostic
  repair queue under the existing AI cap and fresh build approval policy.
- Fix plugin worker documentation links; show native host capabilities as unknown
  instead of verified, and keep manually reported models out of measured costs.
- Add protected complete design inputs/architecture template and explicit optional
  TODO line-count receipts. The generic redesign module runner and native host
  metadata/event bridge remain unimplemented.

- Enforce reviewed preparation order through phase records at the skill entry and runner gates; retain the ten existing phase IDs and explicit source-only parity applicability.
- Export main-compatible migration/cost-log.tsv with measured timing, actual worker counts and unknown usage/model values, retaining existing rows and deduplicating exports.

## Unreleased — VS Code orchestration

- Parent-session TODO ownership, verified-tool/chat fallback and actionable 00/00b reports.
- Read-only early status with Markdown, live lock/run roles, evidence and blockers.
- Explicit source-only judge plan and smoke-to-handoff receipts; parity stays unverified.
- Dependency-aware slot refilling under the existing global AI concurrency cap.
- Host built-in Rubber Duck advisory records and existing repair/reverification routing.
- Cancellation/resumption regressions and honest pending live VS Code checklist.


- Track the ten migration phases in the host TODO list from the parent
  orchestrator, including approval waits, revisions, failures and resumption
  from current evidence. Enable the `todo` alias in both orchestrator profiles
  and retain a chat-checklist fallback when the host tool is unavailable.

- Add a native host-worker backend for VS Code Local and Copilot sessions: task
  claim/submission, tool-free profiles, explicit models, stale-result rejection,
  and cancellation/resume through the shared runner. Preserve the CLI default.
- Record native host-managed instruction isolation separately from CLI isolation;
  add installer options, host-driving instructions and offline transport tests.
- Reserve native plugin worker names as well as qualified IDs, bind task listing
  to the active run ID, and make VS Code plugin initialization select native.
  Clarify per-call model selection and require host metadata checks before submission.
- Publish complete runner locks atomically without replacing an existing lock,
  preventing native clients from observing an empty lock during startup.

- Require interactive phase reports with artifact links, review points, the next
  phase and a copyable reply. Use available question tools for missing decisions,
  with chat fallback and explicit approval wording for production stages.
- Reuse existing answers, keep unanswered questions pending, and preserve
  noninteractive workers. Distinguish judge preparation from its later validation
  receipt so early phase routing does not repeat judge setup unnecessarily.

# 0.2.0 — 2026-10-11

- Add an Agent Plugins 1.0 manifest, portable code-migration skill, six
  Copilot-specific agent profiles, worker hook and local marketplace manifest.
- Add `install --layout plugin`: keep runtime in the plugin, initialize only
  project configuration/rulebook/inventory, and preserve existing project data.
- Mount the plugin explicitly for CLI workers; diagnose mounting support and
  reject personal/project worker profiles that would shadow plugin profiles.
- Fingerprint bundled runtime content so plugin changes invalidate approvals
  and reviewed completion receipts. Include project hooks and agent definitions;
  preserve fingerprints across plugin relocation.
- Resolve local agent YAML names and nested file IDs before CLI execution. Reject
  aliases of reserved plugin selectors while allowing unqualified names to coexist.
  Bundle the ISC-licensed yaml parser so plugin use requires no npm install.
- Retain repository-copy installation and its existing default configuration.

# 0.1.5 — 2026-10-10

- Disable ambient custom instructions for all CLI workers and require the flag
  in doctor. Keep explicit role profiles and put project migration policy in the
  reviewed rulebook/inventory. Verify request contents with discoverable canaries.
- Use the same isolated CLI adapter from Dynamic Workflows; retain runner-based
  resume, cancellation, limits and result validation. SDK agent journals/schema
  calls are no longer used. Workflow args may select the Copilot executable.
- Strip only the initial inventory BOM before comment/header classification.
- Separate parser depmap-root from enumerated source roots, accepting repo-root
  paths and cross-package edges. Report edges originating outside the selected
  roots; reject required dependencies outside the scope without replacing a map.
- Add rereview regressions and CLI/workflow worker transport validation. See
  [fixes and rereview](docs/reviews/2026-10-10-copilot-rereview-fixes.md) and
  [upgrading](docs/UPGRADING.md).

# 0.1.4 — 2026-10-10

- Read CLI JSONL machine output and require a successful terminal result plus
  the final main-agent response; preserve long code strings without text wrapping.
- Scope frozen reviews to the unit's declared transitive source dependencies and
  matching inventory rows, retaining full rules and global notes. Require an
  audited dependency-map artifact, include it in fingerprints and preflight
  static serialized input before implementation/fix calls.
- Add an edges.tsv conversion script that includes isolated source files. Missing
  declarations/evidence and malformed inventory fail instead of being omitted.
- Use concrete view/grep/glob tools for implementer, fixer and arbiter; reviewers
  remain tool-free. Check the machine-output CLI flag in doctor.
- Add compatibility regressions and an opt-in real-CLI/local-provider integration
  check. See [fix verification](docs/reviews/2026-10-10-copilot-fixes.md).

Existing installations must create/audit the review dependency map and update
worker profiles. See [upgrading](docs/UPGRADING.md). Actual AI migration quality,
account authentication, VS Code and SDK sessions remain unverified.

# 0.1.3 — 2026-10-08

- Independently reproduce and confirm both Astra findings with a real C compiler.
- Restrict inline-code exclusions to known interpreter options before their
  entrypoint; track cc/node -c inputs and unknown tools' file arguments.
- Add optional buildArtifactRoots to distinguish generated objects, binaries and
  reports from command inputs. Reject overlap with protected inputs, translated
  sources and migration metadata. Display the declaration in doctor.
- Add eight regression tests, update contracts and document the required artifact
  declaration for commands that directly name output files. Existing configs may
  omit the new field; the runner does not infer unknown output-option semantics.

Live model/IDE/SDK consumption and macOS/Windows remain unverified.
See [review fixes](docs/REVIEW-FIXES.md) and [validation](docs/TESTING.md).

# 0.1.2 — 2026-10-08

- Track directly configured command files and explicit verification inputs under
  migration/. Reject generated state/results/gates/runs and run.lock as such inputs.
- Include every explicit manifest target in validation output fingerprints,
  even below node_modules, __pycache__ or .git traversal exclusions.
- Reject invalid UTF-8 before supplying frozen input to either reviewer, including
  repair diagnostics, with the offending filename. Preserve valid Unicode, BOM
  and real U+FFFD characters.
- Add seven rereview regression tests and update contracts and upgrade notes.

Live model/IDE/SDK consumption and macOS/Windows remain unverified.
See [review fixes](docs/REVIEW-FIXES.md) and [validation](docs/TESTING.md).

# 0.1.1 — 2026-10-08

- Hash every manifest source, conventional root build/dependency files, directly
  configured command files and explicit verificationInputs; expose the list in doctor.
- Revoke downstream results/gates on retry and bind validation to predecessor
  execution IDs, including transitive checks and crash-visible running records.
- Give both reviewers identical bounded input with tool-free profiles for CLI and SDK.
- Finish POSIX process-group escalation before returning a timeout; preserve
  process and model failure diagnostics, including invalid JSON and interruption.
- Reject nonadjacent output ancestor collisions. Separate installed runtime check
  scripts from distribution-only tests/demo, and reject empty test runs.
- Select hook output explicitly and provide CLI decisions in the Local payload.
- Add 15 regression tests and update setup, contracts, live checks and upgrade notes.

Live model/IDE/SDK consumption and macOS/Windows remain unverified.
See [review fixes](docs/REVIEW-FIXES.md) and [validation](docs/TESTING.md).

# 0.1.0 — 2026-10-08

Unofficial Copilot adaptation of upstream commit
`cf91c9d5068d9aaf95a36164169f08c3e636c909`.

- Replace Claude-specific operational entrypoints with Copilot instructions,
  a repository skill, six agent profiles, ten VS Code phase prompt files, and
  separate CLI/Local hook templates. Preserve the original README/manual as provenance.
- Add a dependency-free Node coordinator with explicit models, read-only JSON
  workers, two independent reviews, arbitration, bounded repair, concurrency
  control, input-bound approvals, output/review receipts and resumable stages.
- Add install dry run/conflict checks, doctor, diagnostics-based repair, and an
  optional SDK Dynamic Workflows adapter using the same coordinator.
- Correct queue completion semantics, validate manifest mappings, propagate
  Bash build failures, and protect source/judge inputs from output mappings.
- Add a three-file Python/JavaScript fixture, mutation-tested parity harness,
  27 automated tests, Japanese setup documentation and live verification steps.

Live Copilot, VS Code and Dynamic Workflows execution is not yet verified.
See docs/TESTING.md for the exact validation boundary. No source repository
was pushed, published, or changed remotely as part of this adaptation.
