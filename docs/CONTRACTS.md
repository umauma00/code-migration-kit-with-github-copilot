# Worker and state contracts

Every model reply must be one JSON object (a single fenced JSON block is also
accepted). The local validator checks required values independently of SDK
schema enforcement. Unknown/invalid results never become completed units.

Ordinary CLI workers use --output-format json. stdout is a JSONL event stream,
not presentation text. The adapter selects the final main-agent assistant.message
content (no tool requests), excluding agentId/legacy parentToolCallId child
messages, and requires a successful terminal result. Malformed JSONL, session
errors, aborts, unfinished tool requests and events after result fail closed.
Informational/unknown event types may be ignored; they never supply a reply.
Implementer, fixer and arbiter profiles use the concrete CLI tools view,grep,glob.
The read/search aliases are not accepted for these workers because the reference
CLI loses search tools with those aliases. VS Code launches the same CLI workers.

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

`pass` requires an empty findings array. `changes` requires findings. IDs must
be unique inside a review. Reviewers cite source/rule evidence and work in
fresh contexts. Both receive identical frozen JSON containing the current source
and its declared transitive dependencies, one candidate, full RULEBOOK, scoped
inventory and the optional diagnostic. The dependencies artifact uses schemaVersion
1 and a dependencies object mapping project-relative source paths to direct
dependency arrays. [] is an explicit audited declaration. All reachable nodes
must be declared, exist under sourceRoots and satisfy the path/text checks.
Dependency cycles are included once. Inventory requires a first column named file;
rows match the source closure exactly. Header/global # notes remain. Malformed
rows and unsupported headers are rejected even outside the selected scope.
Include semantic evidence references as dependencies when auditing the map.
Reviewer profiles
have `tools: []`; they cannot read/search the repository. Their input hash is
recorded with each review. No reviewer outcome is supplied to the other reviewer.
Oversized input, NUL-containing files and invalid UTF-8 block the unit instead
of silently omitting or replacing evidence. Files must be UTF-8 text; the runner
does not guess encodings. Static input is checked at its serialized JSON size
before implementer/fixer calls; the final candidate is checked after generation.

## Arbitration

```json
{"schemaVersion":1,"kind":"arbitration","target":"ported/example.mjs","decisions":[{"finding":"reviewer-semantics:F1","confirmed":true,"reason":"The input -1 demonstrates the mismatch"}]}
```

Every finding is decided exactly once. Only confirmed findings reach the fixer.
The fixed output goes through both independent reviews again.

## Receipts

`migration/state/units/<unit-id>.json` contains stage, status, input context,
output hash and references/hashes for model evidence in `migration/runs/`.
Statuses can be pending, implement, review, arbitrate, fix, done or blocked.
The `stage` is retained on failure for resumption. A changed output or context
invalidates the receipt; an existing nonempty file is reviewed again.

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

The global run lock prevents simultaneous runners/validation stages. A crash
leaves the lock in place; unlock checks that the exact owner PID has stopped.
Parallel workers operate on unique manifest outputs. The configured concurrency
caps active agent calls; reviews cannot silently double the cap.

A failed cheap typecheck blocks the unit. Repair with a diagnostic slice after
checking dependencies. Build errors are not parsed generically across languages:
select the affected manifest targets for `repair`; then approve a fresh build.

## Validation commands

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
timestamps, exit/signal/error and the requested model when applicable. A timeout
does not release the caller before POSIX process-group SIGKILL escalation;
Windows uses taskkill /T /F, but Windows execution remains unverified. Detached
processes that deliberately create a separate process group are outside this
termination mechanism; validation commands must not daemonize.

Hook output uses an explicit harness flag, never the input field naming style.
The Local form contains both top-level CLI decisions and nested VS Code decisions
because a Local hook template may also be read by CLI. The payload tests do not
replace a live test of the consumer's hook handling.
