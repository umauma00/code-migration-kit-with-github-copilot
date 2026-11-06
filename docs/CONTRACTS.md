# Worker and state contracts

Every model reply must be one JSON object (a single fenced JSON block is also
accepted). The local validator checks required values. Unknown/invalid results
never become completed units; SDK schema enforcement is not used.

In the default copilot-cli backend, all workers (including Dynamic Workflows) use fresh CLI
processes with --no-custom-instructions. Automatic repository, ancestor and
personal instruction discovery is disabled; selected --agent profiles still
apply. Project migration policy must be in the reviewed RULEBOOK/inventory.
The workflow host does not call ctx.agent or supply its conversation to workers.
Workers use --output-format json. stdout is a JSONL event stream,
not presentation text. The adapter selects the final main-agent assistant.message
content (no tool requests), excluding agentId/legacy parentToolCallId child
messages, and requires a successful terminal result. Malformed JSONL, session
errors, aborts, unfinished tool requests and events after result fail closed.
Informational/unknown event types may be ignored; they never supply a reply.
Implementer, fixer and arbiter profiles use the concrete CLI tools view,grep,glob.
When the implementer or fixer gets a frozen task input, its call also denies
read (`--deny-tool read,write,shell`); the profile keeps the tools for inputs
over the limit.
The read/search aliases are not accepted for these workers because the reference
CLI loses search tools with those aliases.

Workers always run as Copilot CLI processes, also when the migration is driven from
VS Code chat. The VS Code subagent (native) backend and its claim/submit protocol
were removed in 0.3.0; a configuration that still names it fails with migration
instructions.

## Implementation and fix

```json
{"schemaVersion":1,"kind":"implementation","target":"ported/example.mjs","content":"export const value = 1;\n","summary":"Preserve the source constant"}
```

`target` must exactly match the manifest. Content must be nonempty. The
coordinator chooses the destination from the manifest, not from model text.

## Review

```json
{"schemaVersion":1,"kind":"review","target":"ported/example.mjs","verdict":"changes","findings":[{"id":"F1","message":"Negative values are rounded differently","evidence":"src/example.py:8 uses floor division","rule":"RULEBOOK section 2 / source behavior"}]}
```

With `reviewFocus: "shared"` (new installs) each reviewer's contract names both
checks, its own lens first, and asks it to report every defect either finds;
`"specialized"` (unset, existing configs) keeps one check per reviewer as
upstream. Either way the two never see each other's output.

`pass` requires an empty findings array. `changes` requires findings. IDs must
be unique inside a review. Reviewers cite source/rule evidence and work in
fresh contexts. Both receive identical frozen JSON containing the current source
and its declared transitive dependencies, one candidate, full RULEBOOK, scoped
inventory and the optional diagnostic. The dependencies artifact uses schemaVersion
1 and a dependencies object mapping project-relative source paths to direct
dependency arrays. [] is an explicit audited declaration. All reachable nodes
must be declared, exist under sourceRoots and satisfy the path/text checks.
Dependency cycles are included once. Inventory requires a first column named file;
rows match the source closure exactly. A single leading inventory BOM is removed
before classifying comments, empty lines and the header; other text is preserved.
Header/global # notes remain. Malformed
rows and unsupported headers are rejected even outside the selected scope.
Include semantic evidence references as dependencies when auditing the map.
Reviewer profiles
have `tools: []`; they cannot read/search the repository. Their input hash is
recorded with each review. No reviewer outcome is supplied to the other reviewer.
Oversized input and binary files block the unit instead of silently omitting
evidence. A source in a legacy encoding (Shift_JIS, EUC-JP, Latin-1, UTF-16) is
decoded by the bundled mappers' rules and its entry names the `encoding`; the
implementer and fixer get such sources decoded inside their frozen task input;
when that input is over the limit (and for the arbiter) they come in
`extra.legacyEncodedSources` (the unit's source first, then dependencies,
within `maxReviewInputBytes`; a file over the budget is named with its encoding
only).
Kanji-only Shift_JIS or EUC-JP cannot be told from Latin-1 reliably; set
`sourceEncoding` (for example `"shift_jis"`) in `migration/settings.json` to
name the encoding of non-UTF-8 sources (`cp932` is accepted). It is tried
first for every non-UTF-8 file, so declare it only when the legacy sources
share one encoding.
The original bytes are never rewritten. Static input is checked at its serialized JSON size
before implementer/fixer calls; the final candidate is checked after generation.

## Arbitration

```json
{"schemaVersion":1,"kind":"arbitration","target":"ported/example.mjs","decisions":[{"finding":"reviewer-semantics:F1","confirmed":true,"reason":"The input -1 demonstrates the mismatch"}]}
```

The arbiter receives every finding from both reviews (`findings`) and the
`samePlace` pairs of semantics and rules findings that cite the same source
location. A pair is a candidate, not an agreement: both are confirmed only if
they ask for compatible changes. Every finding is decided exactly once. Only
confirmed findings reach the fixer. The fixed output goes through both
independent reviews again.

## Receipts

`migration/state/units/<unit-id>.json` contains stage, status, input context,
output hash and references/hashes for model evidence in `migration/runs/`.
Statuses can be pending, implement, review, arbitrate, fix, verify-fix, done or blocked.
The `stage` is retained on failure for resumption. A changed output or context
invalidates the receipt; an existing nonempty file is reviewed again.

With `fixPolicy: "single-pass"` a unit whose reviews confirmed findings completes
after one fix. Its receipt keeps both reviews of the earlier candidate and adds
`singlePass`: `reviewedOutputHash`, the fixer attempt `fix: {path, hash}`, the
sorted `confirmed` finding references and whether an arbitration applied. The
receipt is valid only while the fixer record's content is exactly the current
target, every unrejected finding is in `confirmed`, and the records keep their
hashes. Since 0.46.0, when the trailer was fixed after the fix
(`singlePass.trailerFixedBy`: `runner` when the runner rewrote it, `fixer`
when a fix of `marker:M1` changed it alone), the content may differ from the
target in nothing but its whole-line PORT STATUS comments and whether the
text before them ends with a line ending (`sameButTrailer` in
`lib/trailer-repair.mjs`); the trailer itself passes the marker check.
`sameButTrailer` reads lines, not the language: a comment-looking PORT STATUS
line inside a multi-line string counts as a trailer line too, as `withoutFlags`
reads quotes only on their own line (the marker check still counts every line
with `PORT STATUS:`). A fixer that returns the reviewed candidate unchanged
is asked once more to change the file or record what this file cannot fix as a
`TODO(port): <reference>: <what is needed>` line; unchanged again, it fails the
unit without using up a fix round. A fix that changes nothing but the kit's
flags (TODO(port) comments and the PORT STATUS trailer, after a comment opener
outside quotes or starting a line; any other edit, comments and spacing
included, is a change) is asked once to fix or name each
finding it leaves open, except findings whose message is about the trailer or a
TODO(port) line; a reference counts as named only whole.
`singlePass.flagged` lists the findings the fix left unfixed (named in a
TODO(port) line it added, or all but those trailer and flag findings when it
changed nothing but flags); the run summary repeats them in
`selfRepairs.flagged` and `warnings`. No review checks that a flagged
finding could not be fixed: that is single-pass's trade-off, as upstream.
A fix of a typecheck-only finding has no reviews of its own, so it is reviewed as usual;
with a unit typecheck configured, `verify-fix` runs it once and a failure returns
the unit to the full review loop.

With `markerPolicy: "todo-lines-v1"` a unit completes only with exactly one
PORT STATUS trailer, on the last nonempty line, whose `todos` is the number of
lines containing `TODO(port)`. Only the closer of a comment that ends on that
line may follow the number (`trailerClosers`: `-->`, `--%>`, `%>`, `*/`, `*@`,
`#}`, `*)`), so a format without line comments, such as XML, ends the file
with `<!-- PORT STATUS: confidence=medium todos=2 -->`. A comment opened
right before `PORT STATUS:` (`<!--`, `<%--`, `<%#`, `/*`, `{#`, `@*`, `(*`;
spaces aside) ends on the trailer line with its own closer; one opened earlier
on the line or on a line above is not checked. A JSON-family file (`.json`,
`.jsonl`, `.ndjson`, `.geojson`, `.topojson`, `.jsonld`, `.webmanifest`,
`.ipynb`, `.har`, `.sarif`, `.gltf`) has no comments and completes without a
trailer; a trailer there is a
`marker:M1` finding to remove it. These rules hold every new answer. A unit
finished by an earlier kit keeps its receipt while its file passes the count
and the place (`finishedMarkerEvidence`, used by `unitDone`): a JSON file
finished by 0.45.0 or earlier with the trailer those kits asked for, or an XML
file finished with a comment left open, stays finished, and a receipt holds
only for the content it was recorded with. Since 0.46.0 a trailer wrong only
in its form or its place is rewritten by the runner with no worker call
(`lib/trailer-repair.mjs`): every PORT STATUS line is a whole-line comment,
they all say the same confidence and count (read leniently: either order,
capitals, `=`, `:` or a space, `todo` or `todos`, quotes or brackets around a
value, brackets around the whole; a quote, a backtick or a bracket left over
is not read, since the line may end a string opened above it), the count
matches the `TODO(port)` lines, and every nonempty line after the first
trailer closes a block: a closing brace, bracket or parenthesis, an end
keyword (`end` or a word of lowercase letters that starts with it, not
`endef`; not a bare `END` or `End`, nor a name such as `end_time`), below a
`#` comment `fi`/`done`/`esac`, `#endif`/`#endregion`, or a line comment of
the trailer's own kind, each with no quote or backtick on its line (VB's `'`
is its comment) and ending no block comment or long string (`-->`, `*/`, `*)`,
`#>`, `]]`, `]=]`, `-}`, `%}`, PHP's `?>` and the like, or a line of nothing
but CoffeeScript's `###`); below a `//` or `/*` trailer with no block comment
open above it (a `/*` in a string or a line comment counts too), whole
`/* … */` comments with no quote or other closer in them are read away first
on such a line (`#endif /* A_H */`), and a line of nothing but such comments
passes too; below a markup comment only closing tags and HTML comments, not
the end of an element whose text is kept as written (`</pre>`, `</textarea>`,
`</script>` and the like). No such line may start with the word that ends a
heredoc opened above the trailer (`<<END`, `<<<END`, `<<~end`, or an end of
other characters quoted right after the `<<`, as `<<"}"`, or after spaces
below a `#` trailer, and an end that looks like a closer, bare or after a
backslash, as `<<-\}`), and no line a backslash continues may run into a
trailer line. A block-comment trailer does not move while a comment of its
kind is open above it (its closer may end that comment; an opener in a string
or a line comment counts too, and nested ones are counted). The trailer is not
moved in YAML, nor below code in Razor, MDX, Astro or Svelte files (after a
code block comes page text; Razor's `@*` and markup comments still move), nor
in Markdown unless it is a markup comment (a `#` line there is a heading), nor
below a line with a bracket in Ruby, Perl, Elixir, Crystal, Pascal or Tcl
files (a bracket may end `%w[ ]`, `qw( )`, a `{ }` comment or a Tcl `{ }`
string); an indented trailer in YAML or Markdown is left alone. The rewrite
keeps the comment's opener, adds a missing closer, puts the trailer after the
last nonempty line (where its first line was, when nothing nonempty follows
it), keeps the line endings, the file's last line ending (or its lack of one)
and the byte order mark, removes a JSON-family file's trailer comments unless
one holds a `TODO(port)` note, and is used only when it passes and nothing but
the trailer changed; a target the review stage does not read as UTF-8 is never
rewritten. Answers are rewritten before they are written (the worker's record
keeps its answer), and a written file at the review, fix and done stages
before its trailer would go to the fixer; `selfRepairs.markerRewrites` counts
them. The implementer's and the fixer's files are checked before they are
written, as they would be written, with one correction. A trailer the runner
cannot rewrite on a written file becomes the confirmed finding `marker:M1` for
the fixer, and the fixed file is reviewed: a file about to be reviewed (a
worker's, an earlier run's, a resumed unit's) goes to the fixer first, a
single-pass fix when the unit would complete. After a single-pass fix
(0.46.0), while `fixPolicy` is `single-pass`, the fix keeps its reviews and
receipt when the fixer changed nothing but the trailer
(`trailerFixedBy: "fixer"`, counted in `selfRepairs.reviewsKept` once the
trailer passes; one still wrong goes back to the fixer with the reviews kept);
a fix that changed more (a `TODO(port)` line included) or returned the
reviewed candidate is reviewed as before, and a rewrite by the runner there
keeps them too (`trailerFixedBy: "runner"`). Under `fixPolicy: "rereview"`,
also after a switch from `single-pass`, every trailer fix is reviewed. A
trailer the runner rewrites on any other file already reviewed sends it to
review again. A trailer fix is not a fix round (`maxFixRounds` neither stops
nor counts it) and keeps its stage `fix` when resumed, with no reviews (after
a single-pass fix, with that fix's reviews); before the fixer is called the
file is checked again, and one that passes now, or that the runner rewrites,
needs no fixer call: it goes to review with no review records (a fix stopped
under an earlier rule), or after a single-pass fix keeps that fix's reviews,
while one that still fails gives the fixer the problem as this kit finds it.
After two in one run the unit is blocked with the reason; after a single-pass
fix it keeps that fix's reviews and the next run starts at the fix. An invalid
`markerEvidence` carries `problem` (what is wrong, with line numbers); a valid
one keeps its six fields, so existing receipts still match. The evidence of a
JSON-family file adds `noTrailer: true`, valid or not.

A worker answer that is not one JSON object or has the wrong shape, one that
ended without a final message ("Copilot JSONL is incomplete"), and an
arbitration with miswritten references, is asked once more with a `correction`
saying what was wrong. Units still blocked by such a slip, by an unchanged
single-pass fix, or (since 0.44.0) by a temporary failure that used up its
retries (a call that wrote nothing for `workerSilenceSeconds`, the CLI's event
stall or lock wait, a call the CLI gave up on, a connection taken over, a
network error next to the sign-in help, a token check or a list of models the
CLI could not get for a reason other than a network error, a rate limit or a
5xx; in bounded mode any transient failure), get one more pass before a translate run ends (not a repair
run, and not after a tripped circuit breaker, a used-up call budget, a
systemic failure or an interruption), resuming where they stopped; the circuit breaker counts that pass
afresh, and a unit the pass never restarts keeps its error. The run summary
counts these in `selfRepairs` (`corrections`, the arbiter's reference re-ask
included, `markerFixes`, `repass`, `flagged`, and since 0.46.0, when they
happened, `markerRewrites` and `reviewsKept`).

Since 0.47.0 each worker call of the translation loop (implementer,
reviewers, arbiter, fixer) has a call limit, in both execution modes:
`workerCallBaseMinutes` in the settings file (`workerCallMinutes` until 0.47.0
and in the record `migration/state/config.json`; 30 by default, 0 for none,
otherwise 10 to 1440) plus one
minute for every 8 KiB of the files the call reads whole: the unit's source
and current target, `migration/RULEBOOK.md` and the design inputs
(`callLimitMinutes` in `lib/execution-policy.mjs`). Bounded `timeoutSeconds`
stays final; the earlier of the two stops a call. The limit counts the
call's time, a step delayed by sleep as two at most (`workWatch`). While the
silence check is on, a call at its limit that has written nothing for
`callIdleMs` (2 minutes) is stopped at its next output instead, or by the
silence check first (`callLimiter`, `runProcess` `idleMs`), so a silent call
stays a silent call. A call
still at work at its limit is stopped with its child processes ("Process ran
past its call limit"). Since 0.48.0 a call writing its final answer without
tools at its limit may finish, up to twice the limit (`callLimiter` `writing`:
the adapter's `answerWatch` reads the CLI's stream events; `writingAtLimit`
on the error when it was stopped there), and one that finished its answer
(`finished`: its last reply without tools, or the CLI's result) has
`finishWaitMs` (a minute, or the limit when shorter) after the tick that saw
it for its CLI to exit; a CLI that does not exit is stopped at its limit or
when that wait is over, whichever is later, with "had not exited Ns after it
finished its answer" and `finishedAtLimit` (its retry's
`extra.previousAttempt` says the answer was lost because the CLI did not
exit). While the silence check is on, that is only for a CLI that wrote
within `callIdleMs` before; one silent longer is stopped by the silence check
as a silent call, as above. The call is tried once more in a new
session, since 0.48.0 with twice the limit (`tryLimitMinutes`), with
`extra.previousAttempt`: a sentence after the task data that says what the
stopped call did and, when it had used tools, to search a dependency rather
than read it whole. The answer contract is unchanged. A second stop at the
limit blocks the unit with "Copilot <role> ran past its call limit on 2
attempts (N min, then 2N min on the retry; from workerCallBaseMinutes and the
files the call reads); this file is set aside for this run ...",
which names no file (the attempt record does), and the unit gets no last pass
in that run. A stop that comes as the run is interrupted is recorded as
interrupted ("Interrupted; ..."), without a retry. A translate run (not a
repair run) dispatches the pending units an earlier run left unfinished (a
state file whose status is not `done`) after the others, each group in
manifest order, except a unit that another pending unit waits on, which keeps
its place (`dispatchOrder` in `lib/pipeline.mjs`). The coordinator's attempt
record adds `workInputMode` (`frozen` or `tool-assisted`, implementer and
fixer), `callLimitMinutes` (when a limit applies) and, on success and failure,
`activity`: `turns` (the main agent's `assistant.turn_start` events), `tools`
(tool calls by name), `views` (up to five `{path, views, refused?}`, the
project files viewed most; `refused` counts view results with
`largeOutputAvoided`), `moreViews` and `outsideViews` when not zero,
`contextTokens` (the largest context once a tool result is in it:
`context_current_tokens`, the context before the result, plus its
`result_token_count`, or `result_token_count_estimate` for a large result,
when the CLI gives one), `contextLimit` and
`compactions` (null when the CLI wrote none). It holds counts and
project-relative paths only. A retry entry of a call stopped at its limit
adds `callLimit: true` and that attempt's `activity`. None of these fields is
part of a receipt: a unit finished by an earlier kit stays finished.

`status` (full and `--fast`) gives each call at work in a unit's
`activeRoles` its `startedAt` (when its current try started: the last retry's
`at`, else the attempt's `startedAt`), `elapsedMinutes` and, when set,
`callLimitMinutes`, and each unit `recorded` (it has a state file). Since
0.47.0 the markdown view lists only the units that have a state file and are
not done or that have a call at work, and counts the others ("Other units: N
done, M not started"); a report without `recorded` lists every unit.
`status --wait` returns when the run stops or starts, its run ID or the unit
count changes, the number of blocked units changes, the build loop moves to
another stage or round, a survey's run, finished scopes, active scopes or
state change, or the wait is over: not for each finished unit, worker call or
survey part.

Before every worker call (retries included) the runner appends `{id, role,
target, at}` to `migration/runs/<run>/cli-sessions.jsonl` and passes that `id` as
the CLI's `--session-id`; attempt and survey records also keep it as
`cliSessionId`. Only `sessions status | prune` use them (receipts never do), and `observedModel` (the CLI's `model.call_final_result`
for the main agent, null when absent or ambiguous), `cliUsage` (`premiumRequests`,
`totalApiDurationMs`, `sessionDurationMs` from the JSONL result) and, when the
reported model differs from the request, `modelWarning`; run summaries list
`observedModels` and the warning.

Validation records have an `executionId` and reference their predecessor's
execution ID. Gates reference the predecessor too. Starting a retry publishes
a non-success record before executing commands, marks downstream results invalid
and removes downstream approvals. Validation walks the predecessor chain, so
restoring one old successful JSON file cannot revive a stale chain. This is a
latest-result store, not a complete event journal.

Input context includes all explicit manifest sources regardless of traversal
exclusions, the review dependency map and every explicitly declared dependency,
conventional root build/dependency files, directly named repository
command input files and required `verificationInputs`, including scripts/configuration
under migration/. Known Node/Python/POSIX-shell inline programs before their
entrypoint are treated as data; compiler `-c` and Node syntax-check `-c` file
arguments remain inputs. Unknown tools' options are not assigned inline-code or
output semantics. Generated migration/state, results, gates, runs and run.lock
cannot be directly named in commands or declared as verificationInputs; move
those inputs outside runtime state. Transitive/custom inputs must be declared
by the project. Missing declared files fail closed. External tools,
environment variables and network state are not fingerprinted automatically.

A translation run checks its input context before and after every worker call.
Within one run those checks walk the inputs again each time but keep a file's
content hash while its identity, size, modification time and change time stay
those it was hashed with (a file changed less than 3 s before it was read is
read again until it settles), and check the manifest rows and the review
dependency map again only when their text changed (a file the map names under
`node_modules`, `__pycache__` or `.git`, which the walk does not enter, is
looked at every check). A change those do not show (a write through a memory
map or a handle still open, a FAT or exFAT file with its modification time put
back, a network share answering from its attribute cache or with a clock 3 s
or more behind) is found by the full check the run makes every ten minutes and
when a run that started work ends (after an interrupt or another failure
too), or when the text given to a worker differs from the run's first read of
that file ("Migration inputs changed before worker invocation"; an accepted
RULEBOOK amendment keeps its identity, as in the context). Once a run finds
its inputs changed, at any check, every unit it took a worker's answer for or
marked done since its last passing full check goes back to review (`blocked`
at stage `review`, without its reviews, arbitration or single-pass fix: "…;
its reviews are made again by the next run") even if the change is undone,
because a worker that reads files with its tools (the arbiter at any input
size; the implementer, fixer and reviewers only when their evidence is over
`maxReviewInputBytes`) may have seen it, and no unit is marked done after
that; a unit still at stage `implement` keeps its record and is implemented
again, and a unit whose record cannot be written back is named in the run's
errors. A check that cannot read an input that is there (a system error code
other than a missing file or a folder in its place) stops the run without
sending units back; the last check reads again, with pauses of 0.3, 1 and
3 s, and sends back those it still cannot confirm. An input a check cannot
find, and an error without a system error code, are changes. Such a change
undone before the next full check, and before a worker is given that file's
text, is not found. A run that ends without its last check (killed, a second
Ctrl+C, its terminal closed) keeps what its workers answered or finished
since its last full check. Gates, phase commands, status and the next run
always hash the files' content.

Optional `buildArtifactRoots` (default `[]`) declares repository-relative
directories containing generated objects, binaries and reports. Command paths
inside these directories are excluded from input fingerprints, whether or not
the files exist yet. The runner does not guess output paths from `-o` or other
tool-specific options. Declare the output directory before judge/approval when a
command names an output file directly. Without a declaration, creation of that
file can change the inferred input set and fail validation.

Artifact roots must be directories when they exist, and must not overlap source,
verification or translated-source roots, explicit verificationInputs, conventional
root build/dependency paths, or kit/Git metadata. Keep actual inputs outside these
roots. Artifact content/creation/removal is not fingerprinted for approvals;
commands must validate it themselves. Source-output fingerprints and protections
against genuine input changes during validation remain enforced.

Validation output fingerprints include both the output-root tree and every
explicit manifest target, even under traversal exclusions. Changing any mapped
output during build/smoke/parity makes the stage fail, even if its command exits 0.

The global run lock prevents simultaneous runners/validation stages. A lock
whose owner PID no longer exists on this host is recovered by the next command
under a short recovery claim. A lock from another host (shared folder) or a
reused PID still refuses; unlock checks the exact owner PID. A lock written
before 0.10.0 records no host and is judged by its PID on this host. Hosts
are told apart by hostname, so containers with a new hostname per run need
`unlock` for their own crashed lock. `unlock` covers run.lock, build-loop.lock
and their `.recover` claims.
Parallel workers operate on unique manifest outputs. The configured concurrency
caps active agent calls; reviews cannot silently double the cap. Fatal input or
scheduler failures stop new calls and cancel active adapters, but retain the lock
until every started worker settles and the failure summary is written.
`agentCalls` in summaries and `calls` in progress count actual adapter invocations,
including failed invocations; unused budget reservations do not count.
Since 0.48.0 a translate or repair run writes `migration/runs/RUN/progress.json`
when one of its numbers changes: `schemaVersion` 1, `runId`, `concurrency`,
`callsActive` (AI calls holding a slot), `callsWaiting` (calls waiting for one),
`unitsAtWork`, `unitsWaitingOnDependencies` (pending units whose dependency is
not done), `unitsReady` and `updatedAt`. A failed write never stops the run.
`status` (full and `--fast`) shows it as `runProgress` while the run's lock is
held and the record names that run; it is not part of `status --wait`'s key,
so a new count does not end a wait.

In auto mode (since 0.48.0) a translate run (production, not a repair) whose
translation approval is missing, out of date, for another purpose, of a scope
the manifest no longer has or in a file that is not JSON (`translationApprovalOnly`),
or names a batch auto mode approved, or a batch the person chose whose every
file is done, records the approval of every file left itself before it starts:
the same function as `approve translation` with the run's context and lock,
its checks included (phase 03, the reports, a current judge), and the gate
carries `auto: true` and `recordedBy: "translate"`. The run summary then has
`autoApproval` (why). A failed check stops the run with "Auto mode could not
record the translation approval itself: " and the check's own message; any
other failure of the gate (phase 03 out of date, a file another program holds)
stops it as before. A current approval of every file, or a batch the person
chose with a file still to do, is kept. A batch the person chose is one
approved outside auto mode (no `auto`) or with `--stop-at-end` (the gate's
`stopAtEnd: true`, only with `--batch` or `--targets`; refused without one, or
on another approval, as a command-line error before anything is written,
including the phase 03 record of `--complete-phase 03`; a batch approved in auto mode without it gets a NOTE on
stderr that auto mode goes on past its end). When its approval is
out of date or names a file the manifest no longer has (`personsStaleBatch`),
translate approves that batch again while a file of it is left: its files in
the manifest with each prerequisite of them that is no longer done (as the
scope check counts prerequisites: without a unit typecheck, of two files that
use each other only the second waits for the first), as
`targets` with `stopAtEnd: true`, so the run still stops at its end (a scope
the check refuses becomes every file left); with none left, status shows the
end of their batch, and the next run records every file left. While translate
is to record the approval, status shows no approval of a later stage (each
needs a current translation approval), and the guidance of a translation
approval that is out of date, for another purpose (the gate's own message
names its stage since 0.48.0) or of an invalid scope names translate with
nothing to decide (a RULEBOOK change keeps `rulebook accept`). A pilot never
records one: its runner approves its own translation.
With unit typecheck deferred, cycle membership is computed across the full
manifest even for single-target repair; incomplete prerequisites outside that
cycle still block the repair.

A failed cheap typecheck blocks the unit. Repair with a diagnostic slice after
checking dependencies. Build errors are not parsed generically across languages:
select the affected manifest targets for `repair`; then approve a fresh build.

## Validation commands

`build-loop --note TEXT [--through build|smoke|parity] [--max-rounds N] [--max-calls N]` is one host-confirmed
grant. Normal continuous execution has no implicit round/call/input budget;
explicit --max-rounds (1–50) / --max-calls (1–10000) choices still apply.
Only executionMode bounded enables the saved defaults (5 rounds, maxAgentCalls,
maxRunInputBytes and the stalled-count breaker). The grant is stored as `migration/gates/build-loop-<id>.json` with its note,
owner `pid`, `through` (default `build`), current `stage`, `agentCalls`, `promptBytes` and per-round
`{round, stage, buildExecutionId, success, errors, targets, unmapped}` (`stage` is the
last stage the round ran; `buildExecutionId` names that stage's run).
Each round records an ordinary build approval whose gate carries
`loop: {grantId, round}`, runs build and diagnoses the recorded output. When it is
clean and `through` is `smoke` or `parity`, it records and runs those stages the
same way, in order. The first failing stage's queue is repaired through `translate`
with the normal reviews, and the next round starts again from build. Normal
execution stops clean or on a real input/permission/validation failure or manual
cancellation. Explicit finite limits can return budget or round-limit; bounded
mode can also return stalled after three rounds without a falling error count.
Unlimited grants store maxRounds/maxCalls as null, displayed as infinity.
A build that could not run, a stale approval or an unmapped failure
is an error, not a round; so is a parity run whose original suite failed. Only build, smoke and parity approvals may carry `loop`; source-only refuses `--through parity`. A loop takes
`migration/build-loop.lock` before it saves its grant and holds it to the end, so a
second loop stops at start; a lock whose pid is gone is retaken. Until the grant
has `finishedAt`, and while its pid lives, every other process's runner lock is
refused and `status` reports `buildLoop`. In strict phase mode, translate and
build-loop also refuse to run when `migration/guardrails.json` is missing.

See [execution scopes](EXECUTION-SCOPES.md) for exact translation target grants,
single-lock repair queues and the explicit todo-lines-v1 count contract. New
marker receipts bind candidate hash, measured/claimed line count and counting
policy; both reviewers receive identical evidence. Existing configs remain
unmodified. designInputs adds complete fixed/protected design bodies for all
roles; it does not change the single-source/single-output manifest contract.

Repair admission publishes an immutable schemaVersion 1 repair-intent archive
and an atomic repair-intent-reference (id/checksum). It binds current context,
build execution, original queue hash, target/source ownership, candidate hashes
and full diagnostic bodies/hashes for every job. Before all jobs are reviewed,
old done receipts are invalid even if a job was never dispatched. Unit state and
both independent review attempts bind repairIntentId, repairIntentHash and
diagnosticHash. Resume never drops queued work or resets an admitted job's fix
round counter. Retain historical intent archives with the review evidence.
The internal done transition is reported/stored as validating until marker,
cheap typecheck and input/output checks finish. Only then is done published.

See [preparation audits](PREPARATION-AUDITS.md) for task/input-bound preparation
requests and merge/diff receipts. They are mechanical evidence, not proof of
model execution or human signoff. Early judge-preparation receipts omit future
maps/rules; formal judge later binds the complete migration context and records
reusedFrom when no command was rerun. See [pilot](PILOT.md) for disjoint purpose,
scope and grants; production completion/phase-03 controls remain in force.

`original`: exit 0 only when the full inherited suite passes on the original.
`mutation`: exit 0 only when the judge correctly rejects intentionally broken
implementations (it is a test of the judge, not a broken build expected to pass).
`build`, `smoke`, `parity`: exit 0 only on success. Parity prints scenario counts,
compares both implementations, and must cover the agreed public interface.
`typecheck`: optional argv with `{target}`, cheap and safe before the whole
translation exists. Leave it null when that assumption is false.

The runner does not infer scenario coverage from exit codes. The human reviews
the command definitions and their reported counts at gates. Every validation
record includes the command, output, exit code and input/output fingerprints.
Attempts are saved before execution. Failures preserve bounded stdout/stderr,
timestamps, exit/signal/error and the requested model when applicable. An explicitly selected bounded timeout
does not release the caller before POSIX process-group SIGKILL escalation;
Windows uses taskkill /T /F, but Windows execution remains unverified. Detached
processes that deliberately create a separate process group are outside this
termination mechanism; validation commands must not daemonize.

Hook output uses an explicit harness flag, never the input field naming style.
The Local form contains both top-level CLI decisions and nested VS Code decisions
because a Local hook template may also be read by CLI. The payload tests do not
replace a live test of the consumer's hook handling.

## VS Code orchestration and verification modes

See the canonical section in the [operating manual](OPERATING-MANUAL.md#vs-code-orchestration-and-verification-modes).

## Continuous execution and survey fragments

executionMode defaults to continuous even when the key is absent in a legacy
configuration. Saved 600-second, call, fix-round, input, credit and retry-count
limits do not interrupt normal work. CPU usage and a command's silence are
never kill conditions. Two checks stop one worker call, never the run: a call
that writes nothing for `workerSilenceSeconds` (since 0.44.0) and a call of
the translation loop still at work past its call limit (`workerCallBaseMinutes`,
`workerCallMinutes` until 0.47.0, since 0.47.0, Receipts above); each is tried
again. status --wait is a
reporting wait only. See
[all interruption conditions and source index](INTERRUPTION-POLICY.md).

runProcess spills output over its memory threshold to private files under
migration/runs/process-output. Result stdout/stderr then contain display tails;
stdoutFile/stderrFile (recorded relative to the migration root since 0.6.1),
stdoutBytes/stderrBytes and stdoutHash/stderrHash identify the complete output; diagnostic reads reject altered logs or non-runner paths.
The CLI JSONL and build diagnostic consumers iterate full logs, not the tails.
A write failure is real evidence loss and remains an error. A child that stops
reading its input before the end fails the runner's write of it (EPIPE, or EOF
on Windows): that does not fail the call, which ends with the child's own exit
status and output, and the result's stdinError names the write. The worker
adapter adds "before it had read its whole prompt" to a failed CLI's message
and does not use the answer of one that exited 0 (since 0.46.1).

Facts and contracts split oversized source bodies, including single long lines,
into source-numbered ranges. An inventory file that does not fit in one input
with the rulebook and one site is recorded as UNKNOWN for every site without
model calls (`mechanical: oversized-source`). A part receipt under <scope-id>.parts/<request-hash>.json
binds scopeInputHash and requestHash to validated items. The scope result records
parts and partReceipts and is published only after all parts/files/sites are
validated and the original inputs are unchanged. Rejected replies and validated
partial rows stay available for resume. Contracts concatenate anchored fragment
observations and retain unknown relationships. Inventory visits all fragments
for every site and retains UNKNOWN/TODO(port) for cross-fragment data flow.
The final shape (one contract per file, one inventory item per census site) and
independent phase audits/human gates are unchanged.

## Inventory review candidate

`preparation_cli.mjs inventory-preview --sites PATH --shards LIST [--out PATH]`
validates and renders the same complete inventory bytes as inventory-merge,
using one shared parser with `{notes, rows}` output. Only the candidate file is
written (default migration/inventory-review-candidate.tsv); formal inventory,
merge receipt and phase approvals are untouched. The result kind is
inventory-preview and includes out, outputHash, census/shard hashes and counts.
It is a draft, not a formal receipt or review attestation.

`inventory-merge --expected-hash SHA256` compares the recomputed full output to
that reviewed candidate hash before either formal write. A mismatch preserves
existing formal files. The merge receipt records reviewedCandidateHash when
provided; existing callers without the option retain their behavior.
Preview retains comments, deduplicates identical retries and rejects incomplete
or conflicting sites. Its output cannot overlap census/shards/survey records,
formal receipts or protected inputs, including hardlink aliases of inputs.
