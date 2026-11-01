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
`sourceEncoding` (for example `"shift_jis"`) in `migration/config.json` to
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
hashes. A fixer that returns the reviewed candidate unchanged is asked once more
to change the file or record what this file cannot fix as a
`TODO(port): <reference>: <what is needed>` line; unchanged again, it fails the
unit without using up a fix round. A fix that changes nothing but the kit's
flags (TODO(port) comments and the PORT STATUS trailer; any other edit,
comments and spacing included, is a change) is asked once to fix or name each
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
lines containing `TODO(port)`. The implementer's and the fixer's files are
checked before they are written, with one correction. A wrong trailer on a
written file becomes the confirmed finding `marker:M1` for the fixer, and the
fixed file is reviewed: a file about to be reviewed (a worker's, an earlier
run's, a resumed unit's) goes to the fixer first, a single-pass fix when the
unit would complete. A trailer fix is not a fix round (`maxFixRounds` neither
stops nor counts it) and keeps its stage `fix` with no reviews when resumed;
after two in one run the unit is blocked with the reason. An invalid `markerEvidence`
carries `problem` (what is wrong, with line numbers); a valid one keeps its six
fields, so existing receipts still match.

A worker answer that is not one JSON object or has the wrong shape, one that
ended without a final message ("Copilot JSONL is incomplete"), and an
arbitration with miswritten references, is asked once more with a `correction`
saying what was wrong. Units still blocked by such a slip, or by an unchanged
single-pass fix, get one more pass before a translate run ends (not a repair
run, and not after a tripped circuit breaker, a used-up call budget, a
systemic failure or an interruption), resuming where they stopped; the circuit breaker counts that pass
afresh, and a unit the pass never restarts keeps its error. The run summary
counts these in `selfRepairs` (`corrections`, the arbiter's reference re-ask
included, `markerFixes`, `repass`, `flagged`).

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
limits do not interrupt normal work. CPU usage and silence are never kill
conditions. status --wait is a reporting wait only. See
[all interruption conditions and source index](INTERRUPTION-POLICY.md).

runProcess spills output over its memory threshold to private files under
migration/runs/process-output. Result stdout/stderr then contain display tails;
stdoutFile/stderrFile (recorded relative to the migration root since 0.6.1),
stdoutBytes/stderrBytes and stdoutHash/stderrHash identify the complete output; diagnostic reads reject altered logs or non-runner paths.
The CLI JSONL and build diagnostic consumers iterate full logs, not the tails.
A write failure is real evidence loss and remains an error.

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
