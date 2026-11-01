# 0.42.0 — 2026-11-01

A phase 03 pilot no longer blocks every unit at once on the Copilot CLI's own
lock, its input checks no longer read the whole source tree again and again,
workers run in the person's own CLI home again by default, and an auto-mode
pilot translates only the files it chose when nothing needs more. On 2026-11-01
a Windows pilot (kit 0.40.0, Copilot CLI 1.0.105, one worker at a time) stayed
at 0 of 40: every worker failed at session.send with "The shared writer lock
timed out." and the kit blocked each unit at once, several minutes apart.

- The CLI's lock waits ("The shared writer lock timed out.", "MCP installation
  storage is busy", "Another process is changing MCP configuration") are
  transient: the same call is retried with the usual backoff, in the same CLI
  home, up to 5 times per call like the CLI's event stall (bounded mode:
  `transientRetries` if lower). Before, the unit was blocked at the first one,
  and the guidance read it as a deadline ("timed out"). A lock wait the CLI
  reports as a failed MCP host start ("Failed to initialize MCP host: Another
  process is changing MCP configuration.") is the same wait: it never moves
  workers to the person's home. `status` names the wait while a file's call
  retries (the attempt record marks each such retry `cliLock: true`) and
  suggests checking for a CLI left from an earlier run if it persists; a
  survey names it in its progress line. When the retries run out, the
  guidance (`cli-lock`) suggests going back to `shared` first when workers ran
  in their own home (`workerCopilotHome` `separate`), and when they ran in
  `~/.copilot` a check for a Copilot CLI left from an earlier run first, then
  a rerun, then their own home. Switching the home is a run setting:
  approvals and finished units are kept.
- `workerCopilotHome` now defaults to `shared`: workers run in the person's
  `~/.copilot` (or `COPILOT_HOME`), as before 0.34.0. The kit's own worker
  home (`separate`) failed every worker on that Windows PC twice on the same
  day (kit 0.40.0): while starting MCP servers (from the copies 0.40.2 stopped
  making), and at the prompt with the lock above. Neither failure was seen
  with workers in the person's home: rerun with `shared`, the same pilot
  finished its first unit with no lock error, and a Mac had run that way all
  along. The reason the worker home was made (a large session index behind the CLI's 120 s
  event stall, 2026-10-31) was never confirmed. `"workerCopilotHome":
  "separate"` keeps the worker home, with its fallback to `~/.copilot`.
  Worker sessions now sit beside the person's own; `sessions prune` removes
  only the ones the kit recorded, and `sessions status` names the folder of
  the current setting first (`sessionState`). `doctor --check-cli` says which
  home workers use, and that a `separate` home that could not be prepared
  falls back to the person's.
- A pilot's input check (when a unit is dispatched, before and after every
  worker call, after a retry wait, and when a unit fails or completes) reads
  each file once. It computed the pilot's context twice and, for the
  production project, the context twice, the source fingerprint of phases 00
  to 02 four times and the phase 00b judge inputs once, each reading every
  source file again; one context alone read a source file three times (the
  source tree, the manifest and the review dependency map). In a fixture
  pilot that was 33 reads of a production source file and 18 of its pilot
  copy per failed unit, and 136 per finished unit; it is now 3 and 3, and 16.
  On that Windows PC one check took about 1 min 45 s (the time a unit shows
  `validating` is one check), and a unit with three worker calls runs eight.
  The context, the phase chain and the judge inputs of one check share one
  read (`readMemo` in `lib/core.mjs`), and every `contextHash` reads a file
  once, so production runs check faster too. What a check compares did not
  change: a change to the production project or to the pilot copy still stops
  the pilot at the next check.
- In auto mode a pilot stays small, like upstream (the same three files as
  the bakeoff, nothing added). Phase 03 chooses 3 files there, and a
  translation-only pilot without a unit typecheck translates only those:
  `pilot plan` and `pilot prepare` no longer add the files they use
  (`scopeKind: "chosen-only"`; they stay in the copy as originals, listed in
  `readOnly`, and the reviewers read them there as before). On 2026-11-01 an
  auto-mode pilot chose 3 files and the kit added the 37 they use, unasked:
  40 files, about half a day on that PC. A unit typecheck or a build, smoke or
  parity boundary needs those files translated, so those pilots keep them
  (`scopeKind: "with-dependencies"`), and outside auto mode nothing changes:
  the person is asked with the full count.
- Updating from 0.40.1 or later keeps approvals, finished units, phase
  records and prepared pilots: no input changed.

# 0.41.0 — 2026-11-01

The translation run now repairs slips of one worker answer by itself, so the
person no longer has to rerun `translate` and ask what to do. On 2026-11-01 a
Mac run (kit 0.31.0) ended phase 04 with 19 of 347 units blocked after three
reruns: 14 arbiters copied a placeholder reference, 2 PORT STATUS trailers sat
above the closing brace (reviewers and the arbiter saw only "invalid", so a
rerun reviewed the same file again and stopped at the same place), 2 fixers
returned the file unchanged for an inventory gap they could not fix, and 1
reviewer wrote text after its JSON. The orchestrator then proposed a RULEBOOK
edit, which would have sent all 328 finished units back to review.

- A worker answer that is not one JSON object or has the wrong shape, or that
  ended without a final message (an empty reply or a tool call, "Copilot JSONL
  is incomplete"), is asked once more, in place, with a `correction` naming
  what was wrong (the parser's reason, such as text after the object).
  Reviewers, who see no extra task data, get the correction written into
  their prompt. This was already done for arbitration references (0.38.0).
- The implementer's and the fixer's files are checked before they are written:
  a PORT STATUS trailer in the wrong place, with the wrong count or missing,
  and a single-pass fix that changed nothing, are sent back once with the exact
  problem.
- The fixer contract follows upstream's "can't fix it, flag it": a confirmed
  finding this file cannot fix (an inventory or RULEBOOK change, another file)
  is recorded as a `TODO(port): <reference>: <what is needed>` line instead of
  returning the file unchanged. A single-pass fix is not reviewed again, so one
  that changes nothing but the kit's flags (TODO(port) comments and the PORT
  STATUS trailer) is asked once to fix or name each finding it leaves open;
  findings whose message is about the trailer or a TODO(port) line are exempt,
  and a reference is named only whole (`reviewer-rules:F10`, `:F1-b` and
  `:F1.2` do not name `reviewer-rules:F1`). Only the flags are left out of the
  comparison (a TODO(port) or PORT STATUS comment after its opener, outside
  quotes, or a line that starts with one): any other edit, comments and
  spacing included, is a change, so a real fix is not told it fixed nothing
  (guessing each language's comments did that to a Python dedent, `a // b`, or
  a line starting with `*`). A fix that adds some other edit next to an
  unnamed flag is therefore not caught.
  What a single-pass fix leaves unfixed is kept in its receipt
  (`singlePass.flagged`) and reported in the run summary (`selfRepairs.flagged`
  and a warning), so the person hears of it. Accepting such flags without a
  review is single-pass's deliberate trade-off, as upstream.
- A wrong trailer still on a written file is no longer a block on the first
  try: it becomes the confirmed finding `marker:M1` for the fixer, like a
  typecheck error, and the fixed file is reviewed. A file goes to the fixer
  before any review spends two reviewer calls on it: the implementer's or a
  rereview fix (still wrong after its correction), one an earlier run left, or
  a unit resumed after a block (such as the two units a 0.40.2 run blocked at
  completion). A single-pass fix with a wrong trailer goes there when the unit
  would complete. Trailer fixes have their own limit, two per run, and are not
  fix rounds: `maxFixRounds` neither stops them nor counts them, so a bounded unit
  whose rounds are used gets the trailer reason, never "Fix-round limit
  reached" with its advice to amend the RULEBOOK. After two trailer fixes in
  one run the unit blocks with the reason.
- A fix refused for changing nothing no longer uses up a fix round, so a
  rerun is not stopped by the fix-round limit.
- An invalid trailer now says why, with line numbers, in its evidence
  (`markerEvidence.problem`), in the fixer's finding and in the error ("the
  PORT STATUS line is line 83, but line 85 "}" follows it: move the trailer
  below it, ..."). A valid trailer's evidence keeps its six fields, so finished
  units stay finished.
- Units still blocked by a contract slip, arbitration references or an
  unchanged fix get one more pass before the run ends; a unit waiting on such
  a unit runs after it. The pass resumes each unit where it stopped (a trailer
  fix stays a fix, without new reviews), counts the circuit breaker
  (`maxConsecutiveFailures`) afresh, and drops a unit's earlier error only once
  the unit runs again, so a unit a stop or the call budget never restarts
  keeps it. No pass follows a tripped circuit breaker, a used-up call budget,
  a systemic failure or an interruption, and a repair run does not add one.
  The run summary counts all of this in `selfRepairs` (`corrections`, which
  include the arbiter's reference re-ask, `markerFixes`, `repass: {units,
  done}`, `flagged`).
- The failure guidance and the skill say the runner already retried, so a unit
  still blocked takes the guidance's recommended option (a rerun for an
  arbitration slip, repair for a trailer or an unchanged fix; in auto mode
  without asking), never a RULEBOOK edit.
- Updating from 0.40.x keeps approvals and finished units. From 0.39.0 or
  earlier, 0.40.0's one-time full re-review still applies.
- Test: `tests/self-repair-2026-11-01.test.mjs` (the trailer reasons and the
  unchanged evidence fields, the slip classes, the prompts, the implementer's
  trailer correction, the trailer sent to the fixer before any review, from an
  earlier run's file, from a unit 0.40.2 blocked at completion, from a unit
  resumed with one review done and in a repair run, the block after two trailer
  fixes, also in continuous mode and shared with the last pass, the trailer fix
  under a used-up `maxFixRounds`, under rereview and after `verify-fix`, a
  forged trailer-fix receipt, the unchanged fix that flags, what the comparison
  leaves out (only flags; real changes that look like comments count), fixes
  that only flag or name another finding, what fixes leave open, the
  reviewer's JSON correction, an answer that ended without a final message, the
  arbiter's counted re-ask, the extra pass, its limit to one, a fixer slip
  during a trailer fix on the pass, the breaker and the budget on the pass and
  no pass after a tripped breaker, a refused fix that keeps its round, no pass
  in a repair run, and a dependent unit that runs after the pass).

# 0.40.2 — 2026-11-01

Worker CLIs no longer all fail while starting MCP servers in the kit's worker
home. On 2026-11-01 (Windows, Copilot CLI 1.0.105) every phase 00b survey
worker failed that way, before the prompt, in three runs in a row. The 0.34.0
worker home copied every top-level file of `~/.copilot` except session
records, which included the CLI's MCP ownership records
(`mcp-installations.json`, `mcp-activations.json`) and a `-writer.binding`
file bound to the person's home, and copied them again on every command.

- The worker home takes only `config.json` (the signed-in account and trusted
  folders) and `settings.json`, and links only `installed-plugins`,
  `marketplaces`, `agents`, `skills`, `hooks` and `extensions`. The person's
  MCP servers (`mcp-config.json`) and the CLI's own state stay behind. Workers
  were already limited to `--available-tools view,grep,glob`, so no MCP tool
  reached them; MCP servers that come with a plugin still start.
- A worker home made by 0.34.0 to 0.40.1 (no `.migration-kit-worker-home.json`
  marker) is emptied once, keeping `session-state`, `session-store.db`, `logs`
  and `pkg` (locks go too, so no lock outlives its binding). Links are removed
  as links, never followed. One kit process empties it at a time; another
  waits up to 30 seconds, then runs the rest of that command in the person's
  home with a warning. A lock whose process has ended is taken over at once,
  any other after 10 minutes untouched. The marker is written once nothing
  tied to the person's home is left (until then each command uses the
  person's home, with a warning); anything else Windows kept open is only
  warned about. A worker home that is a link,
  or resolves to the person's home, is refused (workers use the person's home
  for that command, with a warning).
- A worker that cannot start its MCP servers or its storage in the worker home
  (CLI 1.0.105's MCP host, MCP ownership storage and protected storage
  messages; lock contention does not count) before the model answered is
  repeated in the person's home, like a missing sign-in, and the rest of that
  command stays there, with a warning in the run report instead of a failure.
  `doctor --check-cli` follows workers there when it checks the agents. A
  failure in both homes fails that unit as before (each unit then starts the
  CLI twice) and does not stop the run.
- Test: `tests/worker-home-state-2026-11-01.test.mjs` (what the worker home
  takes and leaves, the one-time emptying that keeps records and never follows
  links, the upgrade lock and its takeover, a worker home that is a link, the
  failure patterns, the fallback, no repeat after the model answered, a
  failure in both homes, and doctor's agent check).

# 0.40.1 — 2026-11-01

A kit update now keeps phase 00b and the phases after it, as 0.40.0 said.
0.40.0 took the kit's own files out of the input fingerprint (contextHash),
but phase 00b's judge input fingerprint still hashed the kit's lib, scripts and
templates (`migration-kit/` in a copy install). Updating the kit therefore made
00b stale, phases 00b to 03 went stale in a chain, translation could not go on
until they were recorded again, and `rulebook accept` was refused because phase
02 stayed out of date.

- The judge input fingerprint no longer includes the kit's own files. The
  verification files, commands, sources and the source-only plan still count.
- Updating from 0.40.0 makes the 00b record stale once (its fingerprint
  formula changes), and with it 01 to 03 in order. A record made before
  0.40.1 is marked as a format change (`judge-format`), so `phase next` says
  to check and record again, not to redo the phase; new 00b records carry
  `judgeInputSchema: 2`. Finished units and approvals are not affected. If
  judge is run again, its preparation (the original and mutation commands)
  runs again once too. A migration that already recorded 05c or 06 records
  them again as well (in runtime mode: the parity and post-parity run and
  approval). Updating from an earlier release has the one-time effect
  described for 0.40.0.
- Test: `tests/kit-update-keeps-phases-2026-11-01.test.mjs` (plugin and copy
  install updates keep 00b to 02 current; a real judge input still makes 00b
  stale; a 0.40.0 record is recorded again without losing anything).

# 0.40.0 — 2026-11-01

Finished work now survives a RULEBOOK change and a kit update, as upstream
does: a change no longer revokes everything; the person decides what to redo
(upstream rule 6, regenerate only the slice the changed rule touches). On the
Mac run of 2026-11-01 one RULEBOOK line sent all 347 finished units back to
review, and every kit update had the same effect.

- `rulebook changes [--format json|markdown]` (read-only) compares the
  RULEBOOK with the version phase 02 recorded, section by section, and lists
  the finished units whose inventory rows (construct, classification or
  symbol) appear in a changed line or a changed section's `construct:` tag.
  Sections that match no file are named, so the person can widen the choice.
- `rulebook accept --note TEXT --redo listed|all|none|PATH,...` is a human gate
  (the hook asks; auto mode runs it unasked like the other approvals and
  chooses listed; for a changed section that matches no file by words, the
  agent reads it and adds the files it affects, or none when nothing is listed
  and it cannot affect translated code, instead of redoing every unit; when it
  cannot tell, it passes listed and the run goes on, and status and the report
  warn which sections were not checked against finished files. The runner
  refuses an auto-mode choice that drops a listed file, and status names an
  acceptance made in auto mode). It records the new
  RULEBOOK as the reviewed one in `migration/phases/rulebook-amendments.json`
  (written only by the runner; the hook refuses agent writes), so phases 02
  and 03, the judge, the approvals and the finished units stay current, and
  sends only the chosen units back to review (their output is kept). It is
  refused when anything else changed since phase 02, and the record must hold
  again or nothing is written. Without it the records go stale as before.
- Phase evidence and the input fingerprint (contextHash) hash the RULEBOOK by
  that identity, and the RULEBOOK is its own part (`rulebook`), so a stale 02
  or 03 caused only by it says so: `phase next` and the phase-order guidance
  offer `rulebook changes` / `rulebook accept` first.
- The kit's own files (plugin lib, scripts, templates, bundled agents,
  plugin.json, package.json; migration-kit/lib and scripts in a copy install)
  are no longer part of the fingerprint, so a plugin update keeps approvals
  and finished units. Each finished unit still passes its own checks (output,
  reviews, arbitration, trailer). The project's `.github/agents`,
  `.claude/agents` and `.github/hooks` (and `.github/extensions` in a copy
  install) reach workers and stay inputs.
- Phase 02's RULEBOOK is kept in `migration/rulebook-history/` when 02 is
  recorded and on every acceptance, for the diff.
- The hook's question before a RULEBOOK edit after translation started now
  says that `rulebook accept` lets the person choose which finished units to
  redo. The skill and the orchestrator describe the flow.
- Updating to this release changes the fingerprint once, so existing
  approvals and completion records go stale one last time.

tests/rulebook-amend-2026-11-01.test.mjs covers the diff and the listed units,
accepting with each redo choice, the records that stay current, a second
change after an accepted one, refusal when another input changed, the hook
(ask, auto mode, the protected record), the guidance and a plugin update.

# 0.39.0 — 2026-11-01

Documents only; no kit code changed.

- README (ja/en) is rewritten for the current version: the three supported apps
  and their session settings (VS Code 1.144: Copilot harness, Agents window
  Folder isolation, New Worktree runs Allow all), the five setup questions, the
  ten phases with links to their prompts, safety, AI usage in GitHub AI
  Credits and what has been verified. The detail it used to carry moved to the
  new docs/REFERENCE.md and docs/REFERENCE.en.md.
- guides/migration-guide.html is rewritten. For each phase it shows what is
  done, who calls the AI (the orchestrator, the runner's workers or a direct
  `copilot -p`), from where and how many times; the per-file translation and
  review loop; an estimator of call counts; the confirmations per mode; and
  what differs from the original Claude Code kit.
- PLUGIN, LIVE-SMOKE, WINDOWS, REVIEW-BENCHMARK, CONTRIBUTING, guides/README
  and the file map are brought up to date (VS Code 1.144, the Copilot app,
  the Windows run up to phase 03).
- README, PLUGIN, REFERENCE and the guide describe 0.36.0 to 0.38.0: the
  RULEBOOK protection (history kept, a confirmation after translation started,
  refused in auto mode), the PORT STATUS trailer form, repairing a blocked unit
  instead of editing the RULEBOOK, and not updating the kit in the middle of a
  migration.
- The orchestrator skill and OPERATING-MANUAL send configuration questions to
  REFERENCE instead of README.
- Removed development records that only described past work: `history/` and
  docs/TESTING. Links to them in CHANGELOG and UPGRADING point at commit
  0bea302 on GitHub.
- tests/doc-links.test.mjs checks that every relative link in the documents
  resolves (anchors included) and that every English document in docs/ has
  a Japanese twin linked both ways.
# 0.38.0 — 2026-11-01

A Mac run (C# to Java, 347 units, auto mode) finished translation with 333
units and 14 blocked. To clear them, the orchestrator fixed one example line in
the project's RULEBOOK, and that one edit sent all 347 finished units back to
review: every unit's record carries the RULEBOOK's hash, so phases 02 and 03
were recorded again and the whole translation re-reviewed (about three hours).
The blocks themselves came from the kit:

- The RULEBOOK template showed the trailer as
  `// PORT STATUS: confidence=[high|medium|low] todos=[N]`, and workers copied
  the brackets (`todos=[2]`), which the marker check rejected. The templates
  (English and Japanese) now show `// PORT STATUS: confidence=medium todos=2`
  and say what goes in each field, without brackets, after the last closing
  brace. The check accepts `todos=[2]`, `confidence=[low]` and spaces around the
  values as the same count,
  so existing RULEBOOKs need no edit. Under `markerPolicy` todo-lines-v1 the
  implementer and fixer prompts also name the trailer's exact form and place
  (in that project 3 files had it inside the class). A wrong count still fails.
- The arbiter's contract example read `"finding":"reviewer-role:ID"`, and
  models copied it: 63 of the project's 533 arbitrations used
  `reviewer-role:`, and each blocked its unit at once. The example is now
  `"reviewer-semantics:F1"`, the arbiter gets every reference to decide in
  `extra.references`, and an arbitration that names an unknown, repeated or
  missing reference is asked for once more, with the slip and the references
  named, before the unit blocks (the recorded error wording is unchanged).
- Nothing kept an agent from editing the RULEBOOK after phase 01, so a
  person's wording could be replaced and a format problem could be "fixed" in
  the rules. From phase 01 on, an agent's edit of `migration/RULEBOOK.md` first
  keeps the current text in `migration/rulebook-history/` (named by its hash,
  kept once), and once translation has started the hook asks the person,
  saying how many finished units the edit sends back to review and that format
  problems are repaired, not fixed in the RULEBOOK. In auto mode it does not
  ask, since autopilot cannot show a confirmation (on that Mac, an ask at 00b
  ended the autopilot session): the edit is refused with the way on (repair
  the unit, report the rule problem) and the run goes on. Only real writes
  count: edit tools, and in a shell a redirect, `tee`, `sed -i`/`perl -i`/
  `awk -i inplace`, a copy, link or move onto it, moving or removing it,
  PowerShell's content writers, `git checkout`/`git restore`, the same inside
  `bash -c`/`powershell -Command` strings and `$(...)`, and an interpreter line
  that names the file with a write call; reading it (`sed -n`, `awk`, hashes,
  scripts that only read it), copying it elsewhere and quoting its path in a
  note never ask. A path kept in a script variable is not seen (best effort). Runner commands that write
  the RULEBOOK (`policy-record`) are unchanged. The skill and the orchestrator
  say the same: a unit blocked in translation is repaired.
- On that Mac the 14 blocked units were reported as an unknown error whose
  choices included "review the previous artifacts and settings", which led to
  the RULEBOOK edit. A blocked unit's trailer, arbitration or unchanged-fix
  error now gets its own guidance, and the RULEBOOK is left alone: an
  arbitration slip recommends rerunning translate (the unit resumes at
  arbitration with its reviews; finished units are kept), a wrong trailer or
  an unchanged fix recommends repair with the error as evidence, since a plain
  rerun reviews the same output again. The fix-round-limit guidance, whose first choice is a
  RULEBOOK amendment, now says the amendment sends finished units back to
  review.

tests/rulebook-stability-2026-11-01.test.mjs covers the bracketed trailer, the
prompts, the arbiter's second chance and its block, the hook before
phase 01, after it and after translation started, and the guidance for a
blocked unit.

# 0.36.0 — 2026-10-31

A sweep of the repository for files nothing uses. Every script, library
module, prompt, test helper, fixture and example is still read by the kit, a
test, CI or a document, so only one file goes.

- `templates/claude-settings.reference.json` is removed. It was the upstream
  Claude Code permission file, kept as a reference that the kit, Copilot CLI
  and VS Code never read, yet every copy install wrote it into
  `migration-kit/templates/`. Command limits for Copilot live in
  `migration/guardrails.json` (from `templates/guardrails.json`) and the
  hooks, as before. A copy installed by an earlier version keeps its stale
  copy until `migration-kit/` is replaced; it can be deleted by hand.
- `templates/settings.README.md` no longer mentions it, and
  `docs/interruption-sources.json` was regenerated without it.

# 0.35.0 — 2026-10-31

The auto-mode handoff at the end of setup said "switch to autopilot with
Shift+Tab". Shift+Tab is a Copilot CLI key; the GitHub Copilot app and VS Code
switch with a picker, so the line was wrong for two of the three apps the kit
supports, and the kit cannot tell which app runs it. The handoff now just says
to switch to autopilot mode and send "continue", without naming a key or a
control, and that without switching the run still goes on by itself to some
extent.

Only the wording changed: when the handoff is shown, that it is shown once,
and that the run stops before phase 00 are as before. The ORDERED-WORKFLOW
pages say the same, and their auto-mode headings no longer say Copilot CLI
only. tests/setup-flow.test.mjs checks that the handoff names no app's key,
picker or command.

# 0.34.0 — 2026-10-31

The same Windows PC showed where the 120 s stall most likely comes from. Its
Copilot CLI home held 2,959 sessions and a 192 MB session index
(`~/.copilot/session-store.db`), and the CLI log said "Session store tracking
backlog limit reached; live indexing paused" while workers failed with
"session host did not complete the ... event within 120s". Every worker call
adds a session to that one shared home, so a migration grows it by thousands.
(The person's six company MCP servers were ruled out: a `copilot -p` call took
11.6 s with them and 12.2 s with all six disabled.)

- Workers run in a Copilot CLI home of their own, next to the person's
  (`~/.copilot` -> `~/.copilot-migration-kit-workers`), so their sessions and
  index no longer share the person's large records. The CLI finds its
  session-state, index and logs only through `COPILOT_HOME` (checked on
  1.0.105, where a full worker run with the real CLI kept every session and
  its own index in the worker home).
- The worker home carries the person's settings, not their records: the
  top-level settings files (`config.json`, which names the signed-in account,
  `settings.json`, MCP and permission settings) are copied when they changed
  (through a temporary file, so a CLI starting in parallel never reads half a
  file), and the folders the CLI reads plugins, agents and settings from are
  linked (a junction on Windows; settings kept as symbolic links are
  followed). The person's session-state, index, logs, command history and
  downloaded builds are left out. With a relative `COPILOT_HOME` inside the
  project, the worker home goes to the user profile instead. The workers' own
  index starts over once it passes 64 MiB and no CLI wrote to it for 15
  minutes. Worker transcripts stay until `sessions prune`.
- If the CLI says it is not signed in in the worker home (its sign-in help or
  "not signed in", without a network error; a single 401 or forbidden model
  does not count), the call is repeated in the person's home. Once that
  works, the rest of that command stays there, with a warning in the run
  report instead of a stop. Signed out in both homes still stops the run as a
  sign-in problem.
- `workerCopilotHome: "shared"` in `migration/config.json` keeps every worker
  in the person's home, as before. It is a run setting: changing it keeps
  reviewed work and approvals.
- `sessions status` and `sessions prune` look in both homes, so sessions from
  older runs are still found.
- `doctor --check-cli` shows the worker home (`worker Copilot CLI home`) and
  checks the CLI there, as workers run it. docs/LIVE-SMOKE notes that a local
  sandbox must allow writes there too.
- tests/worker-home-2026-10-31.test.mjs covers what the worker home carries,
  the per-process copy, the index reset, the sign-in fallback (and that a
  network error with sign-in help does not trigger it), the setting, and
  status/prune across both homes; tests/verify_cli_transport.mjs now checks
  that real CLI workers write only to the worker home.

# 0.33.0 — 2026-10-31

The same Windows pilot recorded what actually stopped it. Workers failed with
"session event delivery failed: session host did not complete the
assistant.reasoning event within 120s" (also `system.message`,
`user.message`, `model.call_final_result`). The kit knew only the CLI's other
wording ("Session host did not acknowledge ..."), so the 0.28.0 retry never
ran and each file was blocked on its first stall. A reviewer's connection
timeout (`ETIMEDOUT` while fetching models) followed by the CLI's sign-in help
stopped the whole run as a sign-in problem and offered `copilot login`,
although the CLI was signed in and other workers were running.

- The CLI stall is recognized in both wordings ("did not complete / did not
  acknowledge the ... event within", "session event delivery failed") and
  retried as before: up to 5 stall retries per call.
- A network error (`ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`,
  socket hang up, fetch failed) followed by the CLI's generic sign-in help is
  retried instead of stopping the run. Since the CLI may still be signed out,
  these retries are capped like the stall (5 per call, counted together),
  also in continuous mode. An explicit statement ("not signed in",
  "authentication required", 401, Bad credentials,
  `session.error authentication`) is still a sign-in problem, and the other
  run-stopping causes (missing agents, credits, the open-file limit...) still
  stop the run next to a network error.
- New failure guidance `cli-network`: the connection dropped or timed out,
  not a failed sign-in; rerun, and if it keeps happening check the proxy
  settings and the sign-in with doctor. It no longer offers `copilot login`
  for these.
- tests/cli-stall-network-2026-10-31.test.mjs covers the recorded wordings,
  a worker that stalls once with the new wording, and a run whose reviewer
  first fails with `ETIMEDOUT` plus sign-in help.

# 0.32.0 — 2026-10-31

No change ships under this number. It first lowered `concurrency` for new
installs from 4 to 1 because a busy company computer stalled on the Copilot
CLI's 120 s internal wait; that was withdrawn before release, once 0.33.0 and
0.34.0 addressed the stall itself. New installs keep 4, and existing
configurations keep their value (now covered by a test). A computer that still
stalls can lower `concurrency` in `migration/run-settings.json`; it is a run
limit, so reviewed work and approvals are kept.

# 0.31.0 — 2026-10-30

A person who chose 日本語 got an English RULEBOOK while reports and the judge
were in Japanese. The report language covered user-facing text only, the
rulebook was not named, and its template was English, so it was drafted in
English. Autopilot played no part.

- `templates/RULEBOOK.ja.md` is the same template in Japanese: the same
  sections, and every marker, tag and placeholder the runner and workers rely
  on (`TODO(port):`, `PORT STATUS`, `DEV-001`, `[source language]`...) kept
  as is.
- The installer uses it when the report language is ja (a recorded choice
  wins, as the installer keeps it); an existing RULEBOOK is never replaced.
- The Japanese template keeps the `[source language]` / `[target language]`
  placeholders, so phase 02 and the source-as-spec readiness check still treat
  it untouched as a template, with no code change.
- The skill and the orchestrator agents say the RULEBOOK's prose (and
  feasibility.md, gap-report.md, judge-report.md) is written in the report
  language, and that a RULEBOOK which already holds rules is never translated,
  because a rewrite revokes approvals. Worker prompts and JSON stay English,
  and so does the policy block `policy-record` writes (it is matched by its
  exact heading).
- tests/rulebook-language-2026-10-30.test.mjs covers both layouts, the
  template's markers, phase 02 and the instructions.

# 0.30.0 — 2026-10-30

On a Windows PC behind a corporate proxy, `doctor --check-cli` printed
"still running" for over an hour. Continuous mode gave doctor's probes no
deadline, and a Copilot CLI that gets no answer waits forever. Reproduced with
CLI 1.0.105 and a proxy that accepts connections but never answers: the agent
probe waited on api.github.com, and the reviewer-hook probe sent its loopback
request to the proxy and waited too.

- Each doctor probe now has a 180 s deadline (`doctorProbeSeconds`), also in
  continuous mode; an explicit bounded `commandTimeoutSeconds` can only shorten
  it. The deadline is per process, and also covers the hook response check.
  A probe past it ends as a failed check that names the stage
  (`Copilot CLI answers`, or the reviewer-hook check with `stalled: true`)
  and the usual causes, with its own guidance (`doctor-stall`: check the proxy
  and sign-in, or run `doctor` without `--check-cli`). No later CLI probe
  starts after a stalled one, and a stalled hook probe skips the model-tool
  probes that use the same loopback provider. A stalled model-tools probe stays
  "not-verified" (as before) but is marked `stalled` and skips the rest. Under
  doctor the model-tools probes now wait 180 s instead of 120 s. A probe that
  hangs after it already got its answer keeps that answer. Migration work
  keeps no implicit deadline.
- The loopback probes (reviewer hook, model tools, comparison B tools) add
  `127.0.0.1,localhost` to `NO_PROXY` for their own CLI child, keeping the
  person's entries. With a non-answering proxy the hook probe passed in under
  a second instead of hanging.

# 0.29.0 — 2026-10-30

In the same phase 03 pilot, one file's implementer stalled the Copilot CLI on
every attempt (the 120 s "Session host did not acknowledge" wait, once at
`tool.execution_start`). The implementer and fixer were told to read the
rulebook, the inventory and the dependencies with their own tools, so they
searched and opened large files themselves (a project's inventory can be over
1.5 MB).

- The runner now hands the implementer and the fixer the same evidence the
  reviewers get: the rulebook, design inputs, this unit's inventory rows, the
  source and the sources it depends on (decoded when legacy-encoded), and for
  the fixer its candidate. When it fits `maxReviewInputBytes` they run without
  file tools (`--deny-tool read,write,shell`).
- Over the limit they get the hash-bound file list and the inventory rows, keep
  read-only tools and are told to read only the listed files and never view
  the whole inventory or any record.
- Every attempt now sees the same input, and the CLI no longer records the
  worker's own searches. The prompt itself is larger (the evidence, up to
  `maxReviewInputBytes`), so in bounded runs `maxRunInputBytes` is reached
  sooner, and the implementer and fixer models must hold that much input, as
  the reviewer models already do. Over the limit a listed file is still read
  whole. The cause was not confirmed from the stalled session's log (the
  person could not run scripts on that computer); 0.28.0's retry stays as the
  safety net.
- The implementer and fixer profiles point people, not workers, at the manual.
- The fold benchmark (lib/bench.mjs) still runs its implementer and fixer with
  their own tools and no runner evidence (now under the reworded profiles), so
  its results are not directly comparable with earlier runs or with
  translation.
- The fixer's diagnostic travels once, inside the evidence.
- tests/implementer-evidence-2026-10-30.test.mjs covers the evidence for both
  roles, the implementer and fixer prompts and the CLI tool flags.

# 0.28.0 — 2026-10-30

A phase 03 pilot stayed at 0 of 26 files for over an hour: workers ended with
the Copilot CLI's own "assistant.reasoning event delivery" timeout, and each one
was blocked on the first try, together with every file that depends on it.

- The CLI's internal event wait ("Session host did not acknowledge '<event>'
  delivery within …", reported as 120 s, and its 60 s counterpart "the event
  poll loop may be wedged") is now a transient failure: the runner and surveys
  retry the same call with backoff, as for rate limits and network errors, but
  at most 5 stall retries per call (per part for surveys; `hostStallRetries`,
  counted apart from other transient retries; bounded mode's
  `transientRetries` still caps the total), so a stall that does not clear blocks that unit and its dependants
  instead of spending calls forever. The message reports a 120 s wait; no setting
  that lengthens it was found in CLI 1.0.105 or the kit. `status` names it when a call is retrying.
- Failure guidance has a `cli-host-stall` entry that says so in plain words and
  offers a rerun (finished files are kept) or fewer parallel workers (approvals
  are kept). The kit's own deadline and a cancellation stay with the timeout
  rule.
- tests/cli-host-stall-2026-10-30.test.mjs covers the classification, a worker
  retried after one stall, the retry cap (also after rate-limit retries) and
  the guidance; surveys use the same check.

# 0.27.0 — 2026-10-30

Questions are written for someone who knows nothing about the kit. In phase 03
a pilot approved for 4 files grew to 26 when `pilot prepare` added the files
they use, and the host asked a second question in kit terms ("translation-only
pilot", "revoke the grant and clean up the target") that the person could not
answer.

- `pilot plan --sources CSV [--through STAGE]` shows a pilot's final scope
  without writing anything: the chosen files, the files they use and the total
  (`counts`), with a plain sentence for the approval question. Phase 03 runs it
  first and asks once with the final count, so `pilot prepare` matches what the
  person approved and needs no second question. Plan applies the same checks
  as prepare, and `pilot prepare --expect-total N` refuses a scope that no
  longer matches the approved count.
- docs/PHASE-HANDOFF.md states how every question is written: the situation in
  everyday words, each choice as what will happen with its good and bad points
  (time, AI usage, whether it can be undone), one recommendation first with its
  reason, pause last, and no kit terms, IDs, paths or command lines. The skill
  and the orchestrator agents point to it. Phase numbers and the model-change
  answer format stay as they are.
- docs/PLAIN-WORDS.md lists everyday words for kit terms (pilot, grant, target,
  judge, manifest, receipt, waive, guardrails and others).
- The Japanese choice labels of the failure guidance (about 55) and the local
  sandbox question no longer use kit terms or commands. The command each option
  runs stays in its own field for the agent; the guidance text marks it as not
  for the person. A new test (tests/plain-questions.test.mjs) checks the labels,
  the sandbox question, the pilot plan sentence and the Japanese examples in
  docs/PHASE-HANDOFF.md.

# 0.26.0 — 2026-10-29

A phase recorded earlier that goes out of date now says why. A pilot fix
changed a file phase 01 had recorded: `status --fast` still showed 4/10,
`phase next` returned "done: 2, next: 01" with no reason, and the host asked an
unclear three-way question.

- `phase next` (`stale`), `phase check` and the gate error name what changed
  since the record: the recorded files, the source tree or settings, the
  predecessor's record, or for 02 and later the part of the approved inputs
  (rules and inventory, manifest, review dependencies, settings, kit files).
  New records keep the fingerprint parts; older ones say the reason is unsure.
- `action` says what to do. `record-again`: only files the phase recorded, an
  earlier record or the kit changed; check that change, fix what it affects and
  record again (not a new review of the whole phase). `redo`: sources,
  settings, commands or verification files changed, or the record is
  unreadable; rerun the phase for what changed. A record older than this release has no
  breakdown of its inputs: a settings, verification or outside-source file
  written after the record means `redo`, none means the kit changed and
  `record-again`. Each comes with the exact `phase complete`
  command (a source-as-spec package from that phase to 02) and the later
  phases to record again after it. The gate error keeps its phase-order
  guidance.
- `status --fast` still does not hash, but marks a phase whose recorded files
  were written after its record and points to `phase next`.
- The orchestrators and skills follow `stale.next`: auto mode records again (or
  redoes) without asking; other modes ask once, recommending it. They never ask
  about the difference between the two status views.

# 0.25.0 — 2026-10-29

The kit reads which file tools each model has instead of assuming them, so a
new model family does not leave a role without tools at phase 03 or in review.
Model families differ (CLI 1.0.105: gpt-6-luna has view, rg, glob and
apply_patch; gpt-4.1 has view, grep, glob, create and edit), and
`--available-tools` drops a name a model does not have without saying so.

- `probeModelTools` asks the real CLI with a loopback model provider which tools
  a model gets under given flags: no account, network or AI usage.
- New `stress-b command --dir DIR [--model ID]` writes phase 03 comparison B's
  exact command (bash and PowerShell) with only the file tools this model has,
  at least one of them writing. A model with no writing tool stops with
  guidance (`model-tools`: choose another model, or update the kit). When the
  CLI makes no loopback request, the command uses the fallback list and says
  it is unverified, never a stop. The 03 prompt and checklist use it; the
  fixed command stays as the fallback.
- `doctor --check-cli` checks per model that tool-assisted reviewers get a
  reading and a search tool, and that comparison B's model gets a writing tool
  (`model tools: ...`). Unverifiable probes are reported as not verified.
- The PowerShell line quotes the tool list (a bare comma is an array there)
  and curly single quotes; a directory named `..x` inside the repository is
  refused; a request without a tool list is not read as "no tools"; each probe
  is bounded to 2 minutes when commands are not.

# 0.24.0 — 2026-10-29

Phase 03 comparison B can write with GPT models that edit through
`apply_patch`, and a local sandbox no longer stops a run at phase 03 without
warning.

- Comparison B's command (03 prompt and checklist) adds `apply_patch` to
  `--available-tools`. On CLI 1.0.105, gpt-6-luna has no `create`/`edit` tool
  and writes only through `apply_patch` (`grep` maps to its `rg` by itself), so
  B got read-only tools and wrote nothing. Checked with a loopback model
  provider: with the new list both gpt-4.1 (`create`) and gpt-6-luna
  (`apply_patch`) write. Worker roles are unaffected (read tools only).
- The hook protects `migration/guardrails.json` (and the auto-mode record)
  from `apply_patch` too. CLI 1.0.105 sends its input as the bare patch text,
  not JSON; the hook skipped such a call, so a gpt-6-luna session could write
  the guardrails file directly (reproduced with the real CLI, now denied).
  JSON-quoted strings, `*** Move to:` destinations, indented headers and
  (on macOS, also for shell commands) another letter case are checked too.
- Tool-assisted reviewers can search again. On CLI 1.0.105, `grep`/`rg` and
  `glob` name their targets `paths` (a string or an array) for every model,
  so the hook found no path and denied every search. It now checks each of
  `paths` like `view`'s path (every target key present, an empty list denied)
  and denies a glob pattern with `..`, an absolute or drive-letter start (also
  inside `{a,b}`) or a non-string value. Paths resolve with the native
  realpath, Windows trailing dots are ignored, a `..` segment is refused (it
  could climb from a link's target), and an unused key sent as null is skipped. Symlinks reached inside a
  glob's own traversal are not resolved by the hook.

The sandbox part: With
sandboxing on (VS Code, Copilot CLI or the Copilot app), comparison B and the
pilot cannot write outside the repository and doctor's reviewer-hook check
cannot use loopback; the run found out only at phase 03 and asked then, and
autopilot stopped there.

- New `lib/sandbox.mjs`: a probe that writes a throwaway directory in the
  temporary directory (and /tmp) and connects to itself over 127.0.0.1.
- `doctor` (with or without `--check-cli`) reports it as `commands can write
  outside the project and use loopback`, with guidance: `/sandbox off`
  (recommended) or allowing the locations in the sandbox settings. The kit
  never changes sandbox settings.
- `settings apply`, while setup is not finished, returns `sandboxQuestion`
  (off / allow / keep) when the probe fails, and its `next` has the parent ask
  it before phase 00 and before the autopilot handoff.
- A reviewer-hook check that failed because loopback is blocked now says so
  and gets the sandbox guidance, instead of suggesting the CLI changed.
- The skill, phase 03 prompt and checklist describe the check.

# 0.23.0 — 2026-10-29

Preparation reviews stop after one repair round, as upstream. In normal mode
the 00b–02 independent review could go fix → re-review → fix with no limit.

- Every preparation audit and independent review in 00b, 01 and 02 (the
  source-as-spec package review included) gets one repair round in every mode:
  confirm each finding against the source, fix the confirmed ones and re-audit
  only the fixed items once. Upstream 02 says "revise once and resubmit; still
  contested, the row is UNKNOWN".
- What is still contested is not fixed again: an inventory row becomes UNKNOWN
  with a conservative `TODO(port)`, other findings are open limitations in
  `judge-report.md` or `depmap/report.md`.
- The phase report lists the fixed findings, the open ones with their evidence
  and the rows made UNKNOWN (with counts); the person decides at the gate (in
  auto mode the list goes into the record's note and the run continues).
- The 02 joint RULEBOOK/inventory audit is not re-run after its fixes, as
  upstream. The hand-written dependency graph keeps its three sampling rounds.

Generated code and undecided policies no longer fill the 02 inventory with
UNKNOWN rows. In one mid-sized C# project a LINQ to SQL designer file alone
gave 3,929 UNKNOWN rows and 2,324 more waited on policies nobody had decided.

- `preparation_cli.mjs generated-files [--write]` finds generated files in
  every language without a model: generator file names (designer, `.g`,
  protobuf, minified, `.generated`), `<auto-generated>` / `DO NOT EDIT` /
  `@generated` headers, project `LastGenOutput` / `AutoGen`, and
  `.gitattributes linguist-generated`, with the generator input beside it.
  Their census sites become GENERATED rows at merge, with no surveyor call;
  the merge reports counts only. They are excluded from the 02 census only,
  never from the migration: each file is translated as ordinary code unless the
  person names a target generator (`--regenerate FILE --how TEXT`, refused when
  the input is not in the repository). A regenerated file leaves the manifest,
  build approval refuses while its target is missing, and `status` lists it.
  `--translate FILE` switches back; a rescan keeps every decision.
- `preparation_cli.mjs policy-questions` lists, from the source, the choices it
  cannot decide (web UI, data access, session state, date/time, configuration,
  services, desktop UI, legacy encodings, generated inputs) with evidence,
  suggestions for the target language and the most conservative option. They
  are asked once in one `ask_user` call before the survey; `policy-record`
  writes each answer into one managed RULEBOOK block (auto mode: the
  conservative option, marked `TODO(port)`).
- `preparation_cli.mjs rulebook-coverage --sites PATH` lists census constructs
  no rule covers, and `survey run --kind inventory --trial N` classifies up to N
  sites per construct in a separate store and reports the UNKNOWN share per
  construct, so gaps are decided before the one full survey.

`phase next` and `status` are faster on large projects (12.2 s to 0.9 s, 4.26 M
to 230 k file system calls on a dense test dependency graph). One read
now checks each parent directory once instead of once per dependency edge and
walks the review dependency graph once; every symlink and missing-declaration
check is kept.

# 0.22.0 — 2026-10-29

The kit's whole AI usage can be read in one place. Before, only translation and
repair runs summed the CLI's usage records: survey runs dropped them,
preparation audits kept them only in each receipt, and nothing added them up.

- Every Copilot CLI worker call, successful or not, adds one line to
  `migration/runs/usage/calls.jsonl`: run, role, target, session, model, CLI
  version and the CLI's own usage (input, output and cache tokens, nano AIU).
  A call the CLI wrote no usage for is kept as unmeasured.
  A call the CLI reported one different (fallback) model for counts under that
  model (with several reported models, under the requested one); a call that never started a CLI process is not logged.
- New read-only command `usage [--format json|markdown] [--run RUN_ID]`:
  totals by role and model, AI units, and what is not included (the parent
  chat with the orchestrator, earlier calls, other roots such as pilots). The
  CLI does not report the AI Credits amount, so the report says to check
  GitHub billing for the charge and `/usage` for the parent chat.
  Totals with an unmeasured call, or a call without AI units, are marked as
  lower bounds; an empty report is never complete.
- Survey run reports get `measuredUsage`, and their cost-log rows get `tokens`
  when every surveyor call was measured (before: always unknown).
- The skill reports `usage` when asked about AI usage and in the handoff.

# 0.21.0 — 2026-10-29

New installs give the frozen review input more room.

- New installs default `maxReviewInputBytes` to 1048576 (1 MiB, roughly
  260k–360k tokens) instead of 262144, so fewer units fall back to
  tool-assisted review and fewer preparation audits need smaller batches.
  Existing configs keep their value, because it is part of the config
  fingerprint. Lower it when the reviewer model's prompt limit in `models list` is
  smaller (for example 655360 or less for a 272K limit).

# 0.20.0 — 2026-10-29

Fewer host confirmations, so the kit runs on its own as far as it can. The
GitHub Copilot app showed a "Hook approval" for every `settings apply`, even
though the person had just chosen those values in a question.

- `models set` and `settings apply` no longer ask in any mode when run as a
  command of their own: they record what the person already chose. A
  `settings apply` that switches auto mode on still asks and says so, and either
  command chained with another (`&&`, `;`, a pipe, `$(...)`) still asks.
- Auto mode also runs `pilot prepare` and `source-spec init --apply` unasked.
  `sessions prune`, switching auto mode on, `guardrails install` with options or
  over an existing file, and kit calls the hook cannot read still ask.
- They ask again with `--root` naming another project or with `--copilot`.
  A `--note` value that quotes a kit command is text: it no longer stands in
  for the gate it is attached to.
- The skill no longer tells autopilot to stop at those commands, and asks to
  batch setting changes into the file and apply them once.

# 0.19.0 — 2026-10-29

Long runner commands show their progress the same way. A `pilot run` piped into
`| Out-String` showed nothing for over an hour, because the pipe held back the
heartbeat and the unit lines until the command ended.

- One rule for every long runner command (`translate`, `repair`,
  `repair-round`, `build-loop`, `pilot run`, `survey run`) in the skill, both
  orchestrator agents, the Copilot instructions and prompts 03/04: start it
  alone in a background terminal with no pipe or file redirection, check it
  with `status --root ROOT --wait 600 --format markdown`, and tell the person
  the finished count and active units after each check. Before, only
  `translate` and `build-loop` were named.
- The hook denies a long runner command whose output goes through a pipe or
  into a file (`| Out-String`, `| Select-Object`, `| tee`, `> log`), including
  the runner path held in a variable (`node $r pilot run ...`), and its reason
  gives the way to run it. `2>&1` alone is still allowed.
- One progress line format for all of them:
  `14:03:45 [3/12] src/a.cs: review (agent calls 14)` (local time,
  finished/total of this run, unit, stage, AI calls so far). `pilot run`
  showed no counts or calls before; `survey run` counts scopes.
- A unit that becomes blocked prints a `blocked` line at once instead of
  appearing only in the final result.

# 0.18.1 — 2026-10-29

The kit moves to the repository's default branch (main): no behavior change.

- README, docs/PLUGIN.md and the visual guide: the marketplace source is
  `umauma00/code-migration-kit-with-github-copilot` with no `#branch`, and the
  chat clone request no longer names the feature branch. The GitHub Copilot app
  deep link drops the `#` value whose acceptance was unverified, and the app
  section no longer needs the CLI fallback for it.
- docs/UPGRADING.md: how to switch an existing `#feat/github-copilot-migration-kit`
  registration to main. Links into `history/` from copy installs, which point
  at the default branch, now resolve.

# 0.18.0 — 2026-10-29

Repository cleanup: no behavior change.

- Removed `skill/SKILL.md`, the upstream Claude Code skill that no install
  loaded (the copy install never copied it) and that had fallen behind
  `skills/code-migration/`. The plugin uses `skills/`; the copy install uses
  `.github/skills/`.
- Moved the kit's own development records (`docs/plans/`, `docs/reviews/`,
  `docs/validation/`, `docs/REVIEW-FIXES.md`) to `history/`. The copy install
  copies `docs/` into `migration-kit/docs/`, so these records no longer land in
  migration projects. Links were updated; in a copy install, links into
  `history/` point at the kit's GitHub repository.
- Deleted the 2026-10-14 parallel-queue probe script, which could not run since
  0.3.0 (it stays in git history).
- The review benchmark setup no longer removes the old record folders, since
  install does not copy them any more.
- README: replaced the 0.2.0, 0.3.0 and 0.17.0 release notes at the top with a
  short description and links to the plugin guide, upgrading notes and changelog.

# 0.17.0 — 2026-10-29

The plugin installs in the GitHub Copilot app too, alongside the Copilot CLI
and VS Code (installation methods checked against the GitHub and VS Code
documentation on 2026-10-29).

- docs/PLUGIN.md and README: installation per surface from the GitHub-hosted
  marketplace (`owner/repo#branch` until the plugin is on the default branch):
  CLI commands, VS Code Customizations and `chat.plugins.marketplaces`, and the
  app's Customize page with `ghapp://` deep links. App session settings (This
  computer, Current checkout, tool permissions, `/sandbox off` when a worker is
  blocked), installing from an internal Git server, and an optional
  `.github/copilot/settings.json` project default.
- `install.mjs` returns `existingMigrations` when another git worktree of the
  target already holds `migration/config.json` (the app can start each session
  in a new worktree, and migration state is not committed). Both skill copies
  tell the orchestrator to ask whether to resume there before `--apply`; the
  installer itself only reports it.
- The code-migration skill describes the app as a host built on the Copilot
  CLI (`ask_user`, `/agent`, Autopilot = auto mode).
- plugin.json and the marketplace entry carry author, homepage and keywords
  for the app's and VS Code's plugin browsers (Agent Plugins 1.0 fields only).

# 0.16.0 — 2026-10-29

Auto mode no longer stops inside a phase, and a large survey scope no longer
runs its parts one at a time.

- Auto mode: questions inside a phase are not asked either. A preparation
  audit or independent review that returns `changes` gets one repair round
  (fix the confirmed findings, re-audit once with a fresh request); what is
  still open, reviews limited by `maxReviewInputBytes`, and UNKNOWN or uncited
  rows are listed in the phase report and the record's note instead of
  stopping. A choice the source and RULEBOOK leave open (for example the
  target web framework, or where non-source assets go) takes the most
  conservative option unless the person gave one, with `TODO(port)`: in the
  RULEBOOK before the inventory survey runs, and after that only in the
  translated output (the RULEBOOK is part of the survey input and contextHash). It is listed as decided without the
  person.
- Surveys: the parts of one split scope now run side by side. One shared limit
  keeps every surveyor call of the run within `concurrency`, so one large
  directory left at the end uses every free slot. A transient failure waits
  outside its slot. Each part keeps its own receipt, so a failed part reruns
  alone.
- Surveys: inventory and contracts rows that end uncited no longer report a
  negative `droppedFacts` (it counted the kept rows). Only facts surveys drop
  answer rows. Results saved by earlier versions are kept and read as 0.
- Surveys: a part's correction or retry is served before parts still waiting
  for their first call, rejected answers are named by call and request so
  parallel parts never overwrite each other's evidence, and a failed scope
  reports a run-wide failure before a part's own.

# 0.15.0 — 2026-10-28

Setup settles the verification method, and auto mode hands over to autopilot
at a clear point.

- When the original does not run, `settings init` asks a fifth question
  (`specificationQuestion`): is there a specification or a test suite the
  target can use? It is recorded with `preferences --specification`. Without
  one, `settings apply` returns the source-as-spec switch as its `next`, and
  `source-spec init --apply` runs during setup (one host confirmation), so
  phase 00b no longer stops on it. Run during setup, its `next` says phase 00
  comes first.
- Auto mode: once auto is chosen, setup results carry `setupNotice` (setup is
  still manual, about how many confirmations remain), which the orchestrator
  puts first in each setup question. When setup is done, `settings apply` (or
  the setup-time `source-spec init --apply`) returns `autoHandoff`, and the
  orchestrator shows it and ends the turn before phase 00 for the person to
  switch to autopilot. A setup question answered by autopilot itself is not an
  answer.
  The handoff is shown once per choice of auto (marked in the auto-mode
  record); choosing auto after setup is applied but before phase 00 returns it
  from `preferences --phase-mode auto`. Once any phase has started, completed
  or been waived (or the handoff was shown) there is no fifth question, notice or handoff.
- The first phase command (`phase start`, `complete` or `waive`) refuses while
  that verification method is still open, with the step to take
  (`setup-unfinished` guidance), so an out-of-order phase 00 cannot skip it.
  A setup answer changed after the handoff still settles it before phase 00
  (only the handoff is not repeated), and `source-spec init --apply` ends
  setup only once the run settings are applied.
- Auto mode: if phase 00 finds a setup answer wrong, the orchestrator says
  which and stops for the person to decide in chat.
- Normal and relaxed mode: only the setup-time source-as-spec switch changes.

# 0.14.0 — 2026-10-28

First choices are questions; the run settings file holds values only.

- Whether the original runs here (`originalRuntime`) is the fourth question of
  `settings init`, after models, languages and the phase mode. The result
  carries `originalRuntimeQuestion` (a ready question in the report language,
  two choices) and the answer is recorded with
  `preferences --original-runtime`; the file follows. The person is no longer
  told to type it into the file.
- An answer of unavailable sets the file's `verificationMode` to `source-only`
  when it was `runtime`, instead of `settings apply` refusing the pair, and
  `preferences` says so; an answer of available over `source-only` asks the
  person whether to verify by running the original.
- `source-spec init --apply` writes `verificationMode: source-only` into the
  run settings file too, so a later `settings apply` neither refuses nor
  writes `runtime` back.
- Source folders the kit cannot find are asked too: `settings init` returns
  `sourceRootsQuestion` (free text) while `sourceRoots` is still the
  template's and holds no files, and once on the language answer when the
  language was not detected there. The answer is recorded with the new
  `settings init --source-roots DIR[,DIR]`; each folder must exist, hold files
  and not be the repository root, and an accepted answer is never asked again.
- `settings apply` with a question-filled entry still `FILL_IN` (models,
  languages, phase mode, originalRuntime) says to run `settings init` and ask
  it, never to edit the file.
- `migration/run-settings.json` drops `_help` and `_choices`: the explanations,
  allowed values and the account's models are written to
  `migration/run-settings.help.md` beside it by every `settings init`. An
  existing file loses them on its next `settings init`; `_about` stays and
  points to the help file.

# 0.13.0 — 2026-10-28

Auto phase mode, for Copilot CLI autopilot: relaxed mode without the person.
Normal and relaxed mode keep every gate as it was.

- `phaseMode` gains `auto`, offered as the third choice of the phase-mode
  question. Choosing it (`preferences --phase-mode auto`, or `settings apply`
  with `phaseMode: "auto"`) is always confirmed by the person through the hook,
  so an autopilot agent cannot switch it on; leaving it is unasked.
- In auto mode the hook no longer asks for `approve` (with `--complete-phase`
  too), `phase complete`, `phase waive`, `build-loop`, and a plain
  `guardrails install` while no guardrails file exists. `models set`,
  `settings apply`, `sessions prune`, `pilot prepare`,
  `source-spec init --apply`, `guardrails install` with options or over an
  existing file, and unreadable kit calls still ask, and a direct write of
  `migration/guardrails.json` stays denied. A gate runs unasked only as a
  command of its own; chained with anything else it asks.
- Auto mode is in effect only with `migration/phases/auto-mode.json`, which the
  runner writes, the hook keeps agents from writing, and leaving auto retires to
  `migration/phases/retired/`; a hand-edited
  preferences file is reported by status and asks as relaxed mode. Any
  `--phase-mode` value but a literal `normal` or `relaxed` asks, and a
  `settings apply` that would switch auto on names it in the confirmation.
  Writing auto into `migration/preferences.json` outside the runner asks, and a
  record left behind a non-auto mode is retired on the next read. The hook
  reads command text, so a forged record is no more fully prevented than a
  forged approval file in normal mode.
- Gate failures end with `Relaxed mode (auto): ...`: the orchestrator does the
  phase's work, waives only what the work cannot supply, and asks no
  phase-boundary question.
- With no guardrails file, the 03, 04 and 05 gates install the template deny
  list and record `installedBy: "auto-mode"`. An existing file is never changed.
- The deviation from upstream rule 3 is recorded in
  `migration/phases/auto-mode.json`. Phase receipts, approval gates, waivers
  and build-loop grants made in auto mode carry `auto: true`; `status` (and `status --fast`) shows
  `autoMode` with those records, and the checklist marks them
  【自動・人の確認なし】 / [auto, not reviewed by the person]. The list stays after
  leaving auto mode; completing a phase outside auto mode records it again
  (keeping its one cost row). Auto mode never replaces a current approval or a
  waiver the person recorded.

# 0.12.0 — 2026-10-28

Relaxed phase mode: when a phase's prerequisite is missing, the person decides
whether to fix it first or proceed, instead of the kit always stopping. Normal
mode (the default) keeps every gate as it was.

- `migration/preferences.json` gains `phaseMode` (`normal` or `relaxed`), set
  with `preferences --phase-mode` or `phaseMode` in run-settings.json. Setup
  asks it as the third question, after the models and the languages. It is not
  part of the configuration fingerprint, so switching revokes nothing.
- In relaxed mode a gate failure (a phase record, a judge/build/smoke/parity
  record, unreviewed translation units, or the reports translation approval
  reads) ends with `Relaxed mode: ... phase waive ID`, and the failure
  guidance adds "proceed without finishing ID" after the fixes. On the
  person's answer, `phase waive ID --note TEXT` records a waiver with the
  reason and what was missing; the hook asks the person to confirm it.
- A waived phase is never counted complete: `status` lists it under
  `waivers`, the checklist marks it 【見送り】 / [waived], and `phase next`
  moves past it. Records made on a waiver bind to it, so finishing the phase
  later (or switching back to normal) has them recorded again. Finishing a
  waived phase for real retires its waiver to `waivers/retired/`, and a
  phase's own record (such as 03's judge) is never stood in for by its own
  waiver. Pilots never use production waivers. Nothing is
  deleted; switching back to relaxed restores them.
- Never relaxed: guardrails, protected paths and source overwrites, approval
  commands themselves, sign-in and credits, and pilots.
- In normal mode the failure guidance for those gates adds "switch to relaxed
  mode and proceed" before pause; it is never the recommendation.
- A 0.11.0 run-settings.json without `phaseMode` still applies unchanged;
  `settings init` adds the entry in place.

# 0.11.1 — 2026-10-28

Remove stops caused by the kit itself: a phase no longer asks the person about
something the kit should have prepared or decided. Each case was reproduced by
running 00 to 02 on old open-source trees (NUnit v2, phpBB 3.0.0, MediaWiki 1.15).

- Source-only projects no longer need the installer's default
  `verificationRoots` ("tests") to exist: `judge-prepare`, `phase complete 00b`
  and the context hash treat a missing verification root as empty there.
  Runtime projects still need it; the error now names the setting to fix and
  has its own guidance.
- An empty source file (phpBB's `config.php`) no longer fails the judge plan
  ("Missing or empty source input"); only an empty scenario does.
- `source-spec init` in a project already on source-as-spec writes its drafts
  without `--apply`; only a profile switch still needs the person's consent.
- Source-as-spec: `phase start 01` / `02` work before 00b is recorded (the
  three are reviewed and recorded as one package), and `phase check` takes a
  package list such as `00b,01,02`. `phase complete 01` alone still needs 00b.
- Status no longer lists artifacts that the current or a later phase writes as
  blockers ("阻害要因: manifest.tsv missing" during 00b); they are shown as not
  written yet, and a context hash that cannot be computed before 03 is
  `inputsPending`, not a blocker.
- Legacy encodings no longer stop surveys or translation. Shift_JIS, EUC-JP,
  Latin-1 and UTF-16 sources are decoded by the bundled mappers' rules (which
  now also detect EUC-JP); every worker input names the `encoding`, and the
  implementer and fixer get the decoded text in `extra.legacyEncodedSources`.
  The original files are never rewritten. Binary files under a source root are
  left out of surveys (`binaryFilesLeftOut`) instead of making them incomplete.
- `source-spec check` prints the manifest command with the real extensions
  (`--ext '.cs=.ts'`). `make_manifest.py` gains `--ext` (replaces only the file
  extension) and refuses the `.SOURCE_EXT=.TARGET_EXT` placeholder instead of
  silently writing targets with the source extension.
- `survey merge --kind inventory` no longer fails on its own run lock (the
  inventory merge takes the lock itself).
- Preparation audits run on the phaseModels audit entry when it is set, and
  otherwise on the person's reviewer-semantics model. No kit command could set
  the audit entries, so every first `audit_inputs.mjs freeze` stopped.
- The PHP mapper names the variables that leave most includes unresolved
  (`$phpbb_root_path . 'common.' . $phpEx`: 364 of phpBB's 429 unresolved rows)
  and suggests `--include-var`; with it, phpBB's computed includes fall to 78.
- Independent re-review fixes: preparation audits hash legacy-encoded inputs
  as decoded text, so `freeze` and the request check agree; `phase check`
  takes a list only within 00 to 02; status still shows a missing source or
  verification root as a blocker while other inputs are pending (after 00);
  the implementer gets the unit's legacy-encoded source decoded before its
  dependencies (within the input budget); a deleted or binary audit input
  gives the "inputs changed" recovery instead of a raw error; a status
  blocker is listed once; `sourceEncoding` in `migration/config.json` names
  the encoding of non-UTF-8 sources (needed for kanji-only Shift_JIS or
  EUC-JP; `cp932` accepted) and is validated.
- Sonnet review fixes: the arbiter gets legacy-encoded sources decoded like the
  implementer; tool-assisted review file lists and preparation audit inputs
  name the `encoding`; status lists every missing artifact again (blockers
  are de-duplicated by path and reason); a lone `phase check 01`/`02` in a
  source-as-spec package names the phases still to record together;
  the missing-root guidance offers source-as-spec only for a missing
  verification root; C/C++ manifest commands name real extensions before the
  map exists; README, TESTING and DEPENDENCY-MAPPERS no longer say non-UTF-8
  input stops the run.

# 0.11.0 — 2026-10-28

- Decide run settings in one file instead of one question per setting.
  `run_migration.mjs settings init` writes `migration/run-settings.json` from
  the current configuration (report language, whether the original can run,
  migration languages, mode, roots, verification mode, execution mode,
  concurrency, stage commands, and every role's model, effort and context
  size), with the account's models, efforts and context tiers under `_choices` and `FILL_IN` where nothing was
  chosen. Setup asks two questions after the report language: one model for
  every role (`models set --role all`), which fills every role's model in the
  file, then "filled in, or a question?" The file takes per-role changes.
- `settings apply` checks every entry against the account's model list and the
  runner's configuration checks, reports every problem at once and writes
  nothing unless all pass; the host asks the person to confirm once, like
  `models set`. Values land in `migration/config.json` and
  `migration/preferences.json` as before, so the report language still never
  revokes approvals. An empty `phaseModels`/`reasoningEfforts`/`contextTiers`
  map is left out as `models set` leaves it, and the reviewed configuration now
  treats an empty map and an absent one alike, so neither command revokes
  reviews by tidying one. Applying needs the Copilot CLI's model list (sign in first), since
  every model entry is checked. `settings check` validates without writing.
- `status` (full and `--fast`) reports whether the file still matches the
  configuration, and lists the entries changed but not applied yet.
- Setup guesses the source language from the project's files (counted by
  extension, leaving out dependencies, build output, hidden folders and the
  output and test roots) and asks one question for the target with the guess
  shown; free text corrects the source. `settings init --source --target`
  records the answer and, while the folders are the template's, fills
  `sourceRoots` with the guessed language's folders. The runner migrates one
  source language: another of comparable size is pointed out so the person
  names the main one, and a language with only a few files is not treated as
  the source language. Typed names such as `csharp` or `VB` are recorded as the
  names the bundled mappers recognize.
- Only the report language is asked before initialization. `models set` stays
  for changing models alone from chat.

# 0.10.0 — 2026-10-27

Remove mid-run stops that a rerun would only repeat. Nothing here adds a stop
based on time, CPU, silence or output volume.

- Survey: rows whose citations or coverage are still invalid after the one
  correction no longer stop the scope. They finish as UNKNOWN/TODO(port) marked
  `uncited`, with evidence naming only the original file range and the
  rejected-answer record (never the worker's citation); facts drop only the
  invalid items. Scope records and the `survey merge` result count them
  (`uncited`, `droppedFacts`, `droppedAnswers`).
- Survey: an inventory file that does not fit in one input with the RULEBOOK
  and one census site is recorded as UNKNOWN/TODO(port) for every site without model calls and listed under
  `unsurveyedOversizedFiles`. Its fragment answers were always merged as
  UNKNOWN; one 20k-line, 1,000-site file took 148 serial calls for that result.
- Liveness notices now come from a separate thread, so synchronous checks
  (`status`, `phase next`) no longer look silent to a host; `phase`, `approve`,
  `diagnose` and `source-spec` get the notice too (without an opening line, so
  a failure still starts with `ERROR:`). Manifest checks resolve each protected
  path once per check: about 5.5 s to 2.2 s for 2,000 files.
- A `run.lock` or build-loop lock whose owner process is gone on this host is
  removed by the next command, under a short recovery claim so two recoverers
  never remove a fresh lock. Locks record their host; one from another host
  still refuses and `unlock` can clear it, as well as a recovery claim (a pre-0.10.0 lock has no host and
  is judged by its PID here). Release removes only its own lock.
- A "request/connection/... timed out" reported by the service or network is
  retried as transient; only the kit's own explicit deadline stays final.
- New installs default `maxReviewInputBytes` to 262144 (256 KiB). Existing
  configs keep their value.
- Source-as-spec drafts no per-file contract memo. `source-spec init` writes a
  mechanical source index (`migration/source-spec/sources.md`) as the plan's
  scenario, and reviewers read cited source lines. Plans drafted earlier that
  name `contracts.md` keep their TODO(spec) gate; the `contracts` survey stays
  only for them.
- Phase 01 with a bundled or fixture-tested mapper: replace the 2 x 20-file
  sampling over up to three rounds with mechanical checks plus one auditor over
  about ten files from the new `preparation_cli.mjs dependency-targets` (files
  flagged in `unresolved.tsv` first, then the largest). Misses are fixed and the
  same files compared again; what stays unresolved is reported, not a stop.
  Hand-written graphs keep the sampling rounds, also without the stop.
  The selection stays within the audit input limit and leaves out files that
  are not UTF-8 text; source-as-spec skips this audit.
- Prompts, skills and orchestrators: report uncited and oversized counts
  instead of asking; ask only when a rerun fails again with no progress or a new
  decision is needed. Add the English interruption policy.

# 0.8.0 — 2026-10-27

- Let the person choose each worker's context size with its model and effort,
  in the same single answer: `models set --assign "reviewers=ID:high:long_context,..."`
  (or `--role ROLE --model ID --context long_context|default`). `models list`
  shows each model's tiers and prompt limits from the CLI's `models.list`
  (`billing.tokenPrices.longContext`, `supportedContextTiers`). A model without
  a long tier is refused. Only roles that chose `long_context` get the CLI's
  `--context long_context`; other workers get no new flag. The choice is
  stored as `contextTiers` in `migration/config.json`, the surveyor inherits
  it like its effort, and a change makes reviewed units be reviewed again.

# 0.7.0 — 2026-10-27

- Make the orchestrator agent the only entry point in VS Code and the Copilot
  CLI. The `code-migration` and `depmap-adapter` skills set
  `user-invocable: false` (not `disable-model-invocation`, which makes a skill
  unreachable in the Copilot CLI, github/copilot-cli#4438), so they leave the
  slash menu but stay loadable. The orchestrators link and read the skill first,
  and the skill and repository instructions tell any other agent not to start
  phases but to point the person to the orchestrator.
- Remove the ten VS Code Local `/migrate-…` prompt files; the orchestrator
  covers every phase in both session types. Upgrade notes are in UPGRADING.

# 0.6.1 — 2026-10-27

Fixes from the review of 0.6.0. Nothing here adds a stop based on time, CPU,
silence or output volume; continuous execution stays continuous.

- Name limits that continuous mode does not enforce instead of ignoring them
  silently: doctor reports `execution limits` (a warning, not a failed check)
  and run/survey summaries carry `ignoredLimits` for configured values that
  differ from the template defaults.
- Keep upstream rule 6 visible in continuous build-loops: when the error count
  has not fallen for three rounds the loop keeps going but records `stalled`,
  and status and the result say to propose a rulebook amendment.
- Record spilled process logs relative to the migration root, so a moved or
  copied checkout can still diagnose them and no local path is recorded,
  including the record of a command or worker that failed after spilling.
  Records written by 0.6.0 with absolute paths still read in place.
- Keep benchmark check output inside the scratch folder that is removed.
- Survey citations: a foreign `NAME.EXT:LINE` is still rejected for any
  extension, but a URL (`https://example.sh:443`), a name without a directory
  whose extension is a common domain (`api.example.com:8443`, `example.rs:8080`)
  or one/two letters (`self.r:5`), and numbers (`0.5:3`) stay plain evidence,
  unless the scope itself uses that extension.
  A file with no census sites in an oversized inventory request no longer
  crashes the split, and is still surveyed.
- C/C++ mapper: string and character literals end at the line, so `#error
  don't` no longer exposes a commented-out `#include`. JS/TS scanner: a regex
  literal after `}` no longer swallows later imports.
- Docs: a call budget applies only when chosen; reusing an answer never reuses a
  past gate approval for a new gate; guidance names bounded mode for the
  maxFixRounds/maxAgentCalls options.

# 0.6.0 — 2026-10-26

- Exercise large legacy C# sources from three pinned OSS releases with a
  transport-only test double, using explicitly converted UTF-8 working copies
  for non-UTF-8 files. Real model analysis and formal phase 02 completion remain
  unverified. Balance source and census capacity to avoid thousands of redundant inventory calls;
  preserve readable scopes, report unreadable/missing inputs as incomplete,
  reject partial merges and reuse successful scopes after input repair.
- Address six P2 findings from Astra's full-change review: JSX closing tags,
  source selection before indexing across all eight mappers, diagnostic
  cancellation, malformed survey payload recovery through the real adapter,
  systemic failures with transient status codes, and shutdown log preservation.
- Harden all eight dependency-mapper paths: Python BOM/coding cookies and
  unresolved parse errors, PHP composer metadata shapes and decoded tagged
  sources, iterative C#/VB.NET Import expansion and directory/metadata walks,
  comment-aware C/C++ and JS/TS references and emitted TypeScript suffixes.
  Keep unparsed files explicit and retain existing fixture graph bytes.
- Generate source-spec commands for every configured source root with quoted
  paths and prefix-only manifest --map-root mappings, verified end to end for
  all languages without compiling or executing their original applications.
- Add inventory-preview using the formal merge's shared parser/renderer, so
  preparation needs no ad hoc TSV review-candidate helper. Preserve comments,
  validated shards and official files; optional inventory-merge --expected-hash
  verifies reviewed bytes before publication. Fix coordinator helper contract
  bugs within the authorized phase without asking to bypass validation.
- Make normal and legacy-config execution continuous: remove implicit worker,
  command and diagnostic deadlines, call/fix/input/credit/retry-count stops and
  default build-loop round/stalled stops. Explicit user budgets/cancellation
  and real validation/permission/input failures remain enforced.
- Spill large process output to full logs instead of terminating at 16 MiB;
  parse CLI JSONL and build diagnostics from all output, including the middle.
- Fragment a single oversized survey source, including huge minified lines,
  preserve original line/column ranges and Unicode, and resume validated parts.
  Require all parts for completion and retain cross-fragment unknowns.
- Document every stop category and add a reproducible source index of explicit
  exits, exceptions, cancellation, termination, deadlines and control flow.
- Number frozen survey source lines and validate citation bounds. Preserve valid
  rows and legacy completed scopes; correct rejected contracts/inventory once
  within the same call budget, and resume only unfinished rows. Split oversized
  pending requests by file/census subset without changing saved scope IDs or
  publishing incomplete scope results.
- Add `status --fast` for recorded progress without source scans, live survey
  progress records and CLI liveness messages. Reuse source fingerprints within
  a full read-only status report; execution/gates still revalidate normally.
- Continue authorized bounded recovery and diagnostics without repeated user
  questions. Treat quiet output as waiting, respect explicit cancellation and
  ask only when recovery is exhausted or a new decision is required.

# 0.5.0 — 2026-10-25

- Seeded-defect benchmark for folding workers together
  (`scripts/review_benchmark.mjs`, `lib/bench.mjs`, `fixtures/review-bench/`,
  [docs/REVIEW-BENCHMARK.en.md](docs/REVIEW-BENCHMARK.en.md)). It compares two
  independent reviewers with one shared reviewer (miss rate after the arbiter,
  findings on clean controls) and the fixer with the implementer handed the same
  confirmed findings (behavior-check pass rate), and lists the cases whose
  result changed. Start with one run per case (at most 59 calls); repeat with
  `--runs 3` before making a fold decision (at most 177 calls). It follows Anthropic's article
  "[Building agents: When to fold subagents into your main agent loop](https://claude.com/ja/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)"
  (2026-10-22): measure first, fold one worker at a time, keep it separate
  if the score drops. `run` refuses a `--max-calls` below the planned bound
  and stops when three calls fail before any works. The translation loop is unchanged; the
  implementer is told to apply findings only when the benchmark hands it
  `confirmedFindings`, which the loop never does.
- Benchmark checks now execute main's inputs and outputs, count generated-code
  timeouts as failed fixes, validate every arbitration reference, include failed
  calls in token totals (unknown usage stays unknown), and cap actual model calls
  at `concurrency`, including both reviewers.
- All benchmark checks require a real final PORT STATUS comment; a header or
  string containing those words no longer counts as a completed fix.

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
  namespaces such as System, java, javax and jakarta left out) is listed in a
  new `external.tsv`, one row per namespace with child namespaces folded
  into a listed parent, so an
  in-house library outside `--root` is not silently missed. A full name
  written where a type stands (`Acme.Billing.Invoice inv;`, `new`, every
  type of a base list, `where` constraint or Java extends/implements/throws
  list, an attribute or annotation) counts as an import; Java rows are
  always packages (`import static a.b.Util.*` gives `a.b`); PHP rows come
  from the names code writes (`use Acme\Billing;` with `Billing\Invoice`
  gives `Acme\Billing`), match case-insensitively and leave out PHP's own
  `Random`, `Dom`, `Pdo` and similar namespaces. Measured on
  NUnit, Tomcat and phpBB (50 random edges and 30 random files each): a
  type nested in another file's class no longer hides a using's type of the
  same name (NUnit's `Assert` was missed), and a PHP file's own
  declaration, then the declarations its includes reach, win over copies
  elsewhere. A
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
  `EnableDefaultCompileItems` keeps the default files as "maybe", a ProjectReference must name an existing
  project file (case ignored) or is warned about, Maven dependencies match
  by groupId:artifactId, global usings of a file the build leaves out apply
  nowhere, an alias whose `<Using>` items give several targets keeps each, project-file comments are not read, and a shared file linked in
  only under a Condition is listed; Gradle Kotlin `project(path = ":x")` and `projects.x`
  accessors are read. C# 14 `extension(...)` blocks, attributed enum
  members, VB.NET `Imports A, B` and PHP 7 classes named `Enum`, `Match` or
  `From` are understood; a Java import on the same line as `package` is
  read; PHP `{$...}` holes in strings and heredocs are code, and a
  `class_alias` alias is a class of its file. Code nested past Python's
  recursion limit is parsed on a larger stack instead of stopping the
  mapper. Lambda parameters, generic inference and overloads
  are not followed; a VB.NET type nested in a class is its own type.
  Enum members and the names Java and VB.NET fields, properties and
  methods declare, VB.NET parameters and locals, and enum members (also
  siblings named in a value, `Both = Order | Customer`, or in Java
  constant arguments) are not type references (`enum EntityType {
  Customer, Order }` made a false cycle); a Java annotation on a constant
  (`@a.b.Ann A`) still is. `<Using Include="A;B">` is an item list,
  `<Alias>`/`<Static>` may be child elements (one under a Condition is applied, with a warning, and every `<Alias>` of a `<Using>` applies, an empty one as a plain using), and a `<Using>` holding a
  property (`$(NS).A`) is warned about and listed as unresolved (so is a VB `<Import>` with one); `Imports Global.X` and an Imports
  continued over lines are read; a PHP include inside an expression
  (`if (!include_once 'x.php') {`) ends at its own parenthesis, and
  `namespace\f()` is the current namespace's function, never an import or
  a global one (and goes to `external.tsv` when it is not under `--root`), an imported function never falls back to a global one,
  and an include expression also ends at `or`; COBOL reads a `*>` inside a
  literal as text, tab-indented fixed format, and CICS HANDLE ABEND,
  RELEASE and ENABLE PROGRAM.
  .NET projects are read with the nearest Directory.Build.props and
  Directory.Build.targets, and the files imported by a path under `--root`
  (a `<Using>` there was lost, and Nancy's shared `ProjectReference` to its
  core project was not seen); `<Using Remove>` and VB `<Import Remove>`
  apply; VB `<Import Include="A;B">` is split and read in any attribute
  order (it gave one bogus namespace and lost every name of A and B), and
  the type arguments of a VB generic alias (`Imports L = List(Of X)`) count;
  a COBOL `CALL WS-PGM` gets edges to the literals `WS-PGM` is given
  (`VALUE 'SUB1'`, `MOVE 'SUB1' TO WS-PGM`), and stays listed.
  An `<Import>` under a Condition (or a conditional ImportGroup) keeps it
  for what the imported file adds or removes (a Release-only
  `<Compile Remove>` dropped Model.cs outright); `File`, `Path`, `Math` and
  the other static class names are a static call only when no variable,
  parameter or member of that name is in view (`Thing File` lost its
  extension edge); a PHP constant with several `define()` values, in one
  file's if/else too, gives an include through it an edge to each value's
  file, and the include stays listed (the last one used to win), unless
  a `define()` of it is not a literal; `Math.Max()` still names no member of
  a project-wide `using static` type; `Condition="Exists('x.props')"` on the
  import of x.props holds; `<Using Remove>` ignores case; a file imported
  first under a Condition is read again at a later import; VB RootNamespace
  comes from the project with `Directory.Build.props` and imports in place
  (the last unconditional value, plus any conditional one after it);
  `\define()` is a `define()` and `const A = 1, B = 2;` declares each name;
  names a `const` or enum `case` declares are not class references;
  `<RootNamespace />` is the empty namespace and an empty
  `<EnableDefaultCompileItems />` leaves the SDK default on; PHP names are
  looked up by position (`f()` a function, `Foo::`/`new Foo` a class, `FOO` a
  constant), so `date()` or `DEBUG` no longer link the classes `Date` and
  `Debug`; a later use of a parameter, local or member spelled like a type
  (`message.Length`, `Category == "food"`, also a member another partial part
  or a base type declares) is not that type, while a type position still is
  (`Customer? Customer`, `Wrapper<int>`, tuples, `is not T`, VB `CType`/
  `DirectCast`/`TryCast`, `TypeOf x Is T`, `(Of T)`), and a parameter or
  local is in view in its own procedure only; type flow reads `x as T`,
  `(T)x.M()`, C# `new` members and Java wildcards (`Job<?, ?>`); PHP attributes with arguments
  (`#[Route('/home')]`) name their class; a VB class with
  `Partial` on one part only (WinForms designer files) links every part; C#
  `Result` and `Result<T>` are different types (`Result<(int, string)>` has
  one type argument, and a partial `Result<T>` is not a part of `Result`; VB
  `Result(Of T)` is told from `Result` too); PHP return and union types are
  classes even beside a same-named constant; VB6/VBA (not `Visual Basic 2010`) get no VB.NET mapper
  command and a mapper that reads no file warns; `depmap_php.py --include-var`
  is in the CLI spec.
  PHP follows computable
  include paths and case-insensitive class/function names with namespaces
  and `use`, narrowed by composer.json autoload (PSR-4, PSR-0, classmap),
  with `--include-path` (an explicit `./` or `../` include never uses it:
  it is looked up next to the including file and at `--root`, and is listed
  as unresolved when those differ; `DIRECTORY_SEPARATOR`, `DS`,
  `realpath()` and a trailing `or die(...)` are understood), and string
  callables (a string in a callback position of `array_map`, `usort`,
  `call_user_func`, `add_action`... and `['Cls', 'm']` pairs, by plain or
  namespaced name) give edges to the function or class of that name (also the
  last argument of `array_udiff`-style functions, the nine
  `session_set_save_handler` handlers, named arguments by each function's
  parameter names, `['Cls', 'm',]` and `['Cls', $method]` pairs,
  the values of `preg_replace_callback_array`, `mb_ereg_replace_callback`,
  the `xml_set_*_handler` functions and WordPress activation hooks;
  `stream_wrapper_register` and `new ReflectionClass`/`ReflectionMethod`
  strings are class names; the lists are closed), named arguments (`callback: 'f'`) included and `is_a` strings read as
  class names, while a callback computed at run time (`$cb`, `"on_$x"`,
  `'on_' . $x`, `get_cb()`, `[$class, 'm']`), `$f()` and an include missing at its `__DIR__` path are
  listed as unresolved; COBOL follows COPY, EXEC SQL INCLUDE, CALL 'X' (also with
  the literal on a later line) and EXEC CICS LINK/XCTL/START/LOAD in fixed or free
  format, with `--copy-path` as the copybook search order. UTF-16/UTF-32 sources are read by their
  byte order mark; other non-UTF-8 sources are read as cp932, then Latin-1,
  with a warning, and a file with NUL bytes that is not UTF-16 is listed as
  not analysed. `source-spec check` suggests the mapper for
  these languages. [Dependency mappers](docs/DEPENDENCY-MAPPERS.md) lists
  them and says how to write an adapter for any other language (static only,
  under `migration/tools/`, same output files, hand-written fixture first);
  the skills and prompt 01 point to it. Fixtures and expected outputs for
  each language are tested with `python -I`. A "Scope and known limits" section says which
  reports are fixed (missed edges, false cycles, crashes, doc mismatches,
  regressions) and which are recorded limits (MSBuild evaluation, type
  inference, names decided at run time, extra edges).

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
  [fixes and rereview](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/history/reviews/2026-10-10-copilot-rereview-fixes.md) and
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
  check. See [fix verification](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/history/reviews/2026-10-10-copilot-fixes.md).

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
See [review fixes](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/history/REVIEW-FIXES.md) and [validation](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/docs/TESTING.md).

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
See [review fixes](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/history/REVIEW-FIXES.md) and [validation](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/docs/TESTING.md).

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
See [review fixes](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/history/REVIEW-FIXES.md) and [validation](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/docs/TESTING.md).

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
