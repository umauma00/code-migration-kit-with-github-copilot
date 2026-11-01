# Work that is never cut short, and the conditions that still stop it

[日本語](INTERRUPTION-POLICY.md) | English

Normal execution is `executionMode: "continuous"`, including existing projects
without the key. Saved values such as `timeoutSeconds: 600` or `maxAgentCalls:
100` are not enforced. CPU use, silence, elapsed time, call counts, fix rounds,
accumulated input and log volume never end work on their own. Transient
service or network failures are retried after a wait, and a running process is
waited for.

Finite limits apply only when the person chooses `executionMode: "bounded"` or
passes `--max-calls N` / `--max-rounds N`. An agent must never add a finite
limit on its own. `concurrency` and the per-input model capacity still apply:
they split and queue work, they do not cancel it.

## Conditions removed or handled without stopping

| Condition | Normal-run handling | Implementation |
|---|---|---|
| CPU at 100%, low CPU, no output | Never terminated or restarted. No CPU-based exit exists; parent instructions forbid it | every harness skill, orchestrator, phase handoff |
| 600 s per worker, build or comparison | No automatic termination; saved positive values are ignored in continuous mode; `timeoutMs: 0` creates no timer | `execution-policy.mjs`, `process.mjs`, `copilot_adapter.mjs`, `pipeline.mjs` |
| 20/30/60 s model list, version check | No implicit deadline | `models.mjs`, CLI and adapter diagnostics |
| Each doctor probe | A short readiness check, not migration work: 180 s per probe process even in continuous mode (an explicit bounded `commandTimeoutSeconds` can only shorten it), then doctor names the check that did not finish and the usual causes (a proxy that does not answer, a sign-in waiting for input, a blocked network) and ends; a non-answering proxy kept it "still running" for over an hour (2026-10-30). No later CLI probe starts. Explicit cancellation still reaches every probe. Probes that use the loopback model provider add 127.0.0.1 and localhost to `NO_PROXY` for their own child only | `doctor` in `run_migration.mjs`, `copilot_adapter.mjs` |
| Child stdout+stderr over 16 MiB | Not terminated; the full output goes to a log file and only the tail stays in memory | `process.mjs`, `copilot_adapter.mjs`, `diagnostics.mjs`, `diagnostic_queue.mjs` |
| Survey file set or census over the input limit | Split into fitting requests; scope IDs and results are kept | `survey-parts.mjs` |
| One survey source body over the input limit | Facts and contracts split it by line range (or character position for a huge line, never breaking Unicode pairs). Inventory records every site of a file that does not fit in one input with the RULEBOOK and one site as UNKNOWN/TODO(port) without model calls and lists it under `unsurveyedOversizedFiles` (one 20k-line, 1,000-site file took 148 calls that were merged into the same UNKNOWN) | `survey-parts.mjs`, `survey.mjs` |
| Phase 01 dependency audit (2 x 20 files, stop after three rounds) | With a bundled or fixture-tested mapper, one auditor checks about ten files from `dependency-targets`; misses are fixed and the same files compared again. What stays unresolved goes into report.md, not a stop (hand-written graphs also report after three rounds instead of stopping) | `preparation.mjs`, `PREPARATION-AUDITS.md`, the 01 prompt |
| 64 KiB default input limit | New installs default to 1 MiB (1048576 bytes), so fewer files fragment at all. Existing configs keep their value, because it is part of the config fingerprint | `templates/migration-config.json` |
| Manual interruption or outage mid-file | Validated fragments are saved with input hashes and reused on resume | `.parts/` records in `survey.mjs` |
| Slow periodic checks; `status` or `phase next` killed for silence | The liveness notice comes from its own thread every 15 s (checks are synchronous, so the old timer never fired until they ended), for every command including phase, approve, diagnose and source-spec. Manifest checks resolve each protected path once: about 5.5 s down to 2.2 s for 2,000 files | `command-progress.mjs`, `command-progress-heartbeat.mjs`, `core.mjs`, `run_migration.mjs` |
| `run.lock` left by a crashed run | If the owner PID no longer exists on this host, the next command removes the lock and continues (the build-loop lock too), under a short recovery claim and only if the lock did not change. Only a lock from another host (shared folder) or a PID reused by an unrelated process still stops; confirm that run stopped, then `unlock --pid`. A lock written before 0.10.0 records no host and is judged by its PID on this host. Hosts are told apart by hostname: a container that gets a new hostname per run sees its own crashed lock as foreign and needs `unlock`, and containers sharing a hostname but not a PID namespace must not share one migration folder. | `lockRun` in `core.mjs` |
| "timed out" from the service or network | Retried as a transient failure. Only the kit's own explicit (bounded) deadline is final | `failures.mjs` |
| A network error (ETIMEDOUT, ECONNRESET, ECONNREFUSED, EAI_AGAIN, socket hang up, fetch failed) followed by the CLI's sign-in help ("To authenticate, you can use...", "run the '/login' command") | Retried as a transient failure instead of stopping the run as a sign-in problem: usually the CLI only could not reach GitHub to check. Since the CLI may still be signed out, like the stall it is retried at most 5 times per call, also in continuous mode. The guidance is `cli-network` (rerun, check the proxy and the sign-in), never `copilot login`. An explicit statement ("not signed in", "authentication required", 401, Bad credentials, `session.error authentication`) is still a sign-in problem, and the other run-stopping causes (missing agents, credits, the open-file limit...) still stop the run next to a network error | `failures.mjs`, `guidance.mjs` |
| The Copilot CLI's own event wait ("Session host did not acknowledge 'assistant.reasoning' delivery within …", or on Windows "session event delivery failed: session host did not complete the assistant.reasoning event within 120s", reported as 120 s; or "the event poll loop may be wedged") | Retried as a transient failure instead of blocking the unit and every unit that depends on it, up to 5 stall retries per call (per surveyed part, including its one correction), counted apart from other transient retries (bounded mode's `transientRetries` still caps all retries; each retry is a model call). A call that still stalls blocks only that unit and its dependants. No setting that lengthens the wait was found in CLI 1.0.105 or the kit | `failures.mjs`, `pipeline.mjs`, `survey.mjs`, `guidance.mjs` |
| The Copilot CLI's own lock wait ("The shared writer lock timed out.", "MCP installation storage is busy", "Another process is changing MCP configuration") | Retried as a transient failure in the same CLI home (it is never a reason to move workers to another home), like the event wait up to 5 times per call (bounded mode's `transientRetries` still caps all retries). A call that still waits blocks only that unit and its dependants; the guidance (`cli-lock`) first suggests the other worker home (`workerCopilotHome`) | `failures.mjs`, `pipeline.mjs`, `survey.mjs`, `guidance.mjs` |
| One translation answer that misses its form (text around the JSON or the wrong shape, an answer that ended with an empty message or a tool call, arbitration references, a PORT STATUS trailer in the wrong place or with the wrong count, a single-pass fix that changed nothing) | Not a stop. The same role is asked once more, told what was wrong; a fixer is told to record what this file cannot fix as a `TODO(port): <reference>: <what is needed>` line, and findings left unfixed are reported in the summary's `selfRepairs.flagged` and a warning. A wrong trailer left on a written file goes to the fixer as a confirmed finding, and the fixed file is reviewed (twice per run at most; not counted as fix rounds). Units still blocked (except by a trailer) get one more pass before the run ends (not after a tripped breaker, a used-up call budget, a systemic failure or an interruption). The run summary's `selfRepairs` counts them | `pipeline.mjs`, `markers.mjs`, `copilot_adapter.mjs` |
| Survey citations or omissions still invalid after the one correction | Not a stop. Those rows finish as UNKNOWN/TODO(port) marked `uncited`; evidence names the original file range and the rejected-answer record, never the worker's citation. Facts drop only the invalid items. Report the count in the review package | `survey.mjs` |
| 100 calls, 2 fix rounds, input budgets, AI Credits cap | Not stop conditions in continuous mode; usage is recorded, `--max-ai-credits` is not passed, and doctor/`ignoredLimits` show limits that are not enforced | `execution-policy.mjs`, `run_migration.mjs` |
| Two transient retries by default | Retried with up to 60 s between attempts, without a count limit (except the CLI's internal event stall and lock wait and network errors with sign-in help: 5 each call); sign-in and credit failures are classified first, except sign-in help after a network error (below) | `pipeline.mjs`, `survey.mjs`, `failures.mjs` |
| Three consecutive unit failures | Independent units continue; only the failed unit and its dependants stay unfinished | `pipeline.mjs` |
| build-loop rounds, call budget, errors not decreasing | Continues until clean. Three rounds without fewer errors are recorded as `stalled` and status suggests a rulebook fix (upstream rule 6) | `build-loop.mjs`, `status.mjs` |
| `status --wait 600` returning | Returns a report only; nothing is signalled to stop | `run_migration.mjs` |

## Conditions that still stop

These are not time or load cutoffs: continuing could not save a correct result.

| Kind | Examples |
|---|---|
| The person's action | SIGINT / SIGTERM / AbortSignal |
| Limits the person chose | bounded mode, explicit `--max-calls` / `--max-rounds` |
| Permission and phase scope | missing or stale approval, unfinished earlier phase, outside the approved batch or pilot |
| Input/output safety | writing over sources, protected paths, traversal, symlinks, duplicate targets, guardrail violations |
| Inputs changed during a run | source, rules, config, judge or repair intent changed |
| Concurrency and record integrity | a run/build-loop lock whose owner is alive or that comes from another host (an ownerless lock on this host is removed automatically), broken ledgers or hashes |
| Cannot start, sign-in, credits | missing CLI or runtime, unknown agent or model, expired sign-in, 403, service quota or billing limits |
| Broken streams | corrupt JSONL or terminal events from the CLI itself, session errors (classified as above) |
| Preparation audit request over the input limit | `audit_inputs.mjs freeze` refuses instead of truncating; freeze again with fewer files per batch (or raise `maxReviewInputBytes`) |
| Required data that truly cannot be processed | binary files (NUL bytes that are not UTF-16), unreadable files, or required metadata (rulebook, one census site) larger than the model capacity on its own |
| Translation and test failures | non-zero typecheck, original, mutation, build, smoke or parity; fixable failures go to reviewed repair inside build-loop |
| No owner for a fix | a compiler diagnostic that maps to no manifest target, a failing original test, a defect in the judge itself |
| Real environment faults | ENOSPC, EACCES, EMFILE, EIO, spawn failure, OOM kill, external termination |
| Hooks cannot guarantee permissions | missing or invalid hooks, the host's 30 s hook limit (not a worker time limit) |
| Invalid helper input | unknown options, empty manifest, broken TSV or config |

Limits inside external services, the OS, VS Code or a project's own commands
cannot be lifted by the kit. A host wait API returning is not a process exit:
keep the run ID and wait. When an external stop happens, name its source and
exit code and resume from saved results.

The [source index](interruption-sources.json) and the regeneration and test
commands are described in the [Japanese page](INTERRUPTION-POLICY.md#再現可能な全ソース索引と検証).
