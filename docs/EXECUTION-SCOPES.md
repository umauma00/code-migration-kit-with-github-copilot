# Execution scopes and repair queues

The six major stages are map/rules (01/02), stress (03), translation (04), compile
(05), start (05b) and behavioral equivalence (05c). 00/conditional 00b are
preparation; 06 is cleanup/handoff. Ten internal IDs remain for evidence and
resumption. Source-only acknowledges unverified 05c and cannot satisfy equivalence.

At each major-stage boundary the parent returns concrete artifacts and stops for
human direction. Internal work authorization cannot start an unapproved major
stage. This release retains strict fresh approval after repaired outputs before
each build; it does not add a build daemon or silently broaden an earlier grant.

## Translation batches

After actual user review and direction, select a unit count or explicit targets:

```bash
node migration-kit/scripts/run_migration.mjs approve translation --batch 20 \
  --note "User approves these dependency-ready units only"
node migration-kit/scripts/run_migration.mjs translate
# After reviewing this batch and obtaining the next instruction:
node migration-kit/scripts/run_migration.mjs approve translation --batch 20 --note "Next reviewed scope"
```

`--targets ported/a.js,ported/b.js` chooses exact manifest targets instead.
They must include unfinished prerequisites. A batch selects pending units in
dependency-ready order; actual selected targets are saved in the approval.
Without either option, the existing whole-manifest approval behavior remains.
Inputs, reports and judge are bound as before. A run stops when its approved
scope completes; resuming that same exhausted scope does not start another batch.
Status directs the parent to review and request the next batch. Build requires
all manifest units to have current independent reviews.

A batch count is files/units, not maxAgentCalls. All implementation, review,
arbitration and fix calls share concurrency; saved call/fix-round budgets apply
only in executionMode bounded. Normal execution is continuous. Explicit
--max-calls/--max-rounds choices are still respected.
Bounded calls can stop a batch early; resume only its authorized scope with valid
receipts. Re-approval does not discard already reviewed units.

## Compile diagnostic queues

A language-specific adapter or reviewed extraction produces a TSV from one
current build attempt. The common header is file, module, code, message separated
by tabs. File is an exact manifest target. `run_migration.mjs diagnose` produces it
from the current failed build with the bundled parsers (Python, Java/Maven,
JavaScript/Node/ESLint/tsc, shell/ShellCheck, rustc, generic FILE:LINE:COL), and
`repair-round` also runs the repair queue. Lines that map to no manifest target
are reported, not guessed. Each round is logged in `migration/build-rounds.tsv`.

```bash
node migration-kit/scripts/diagnostic_queue.mjs --diagnostics migration/build-diagnostics.tsv
# If the current translation approval covered only the final batch, obtain
# explicit approval for the repair targets before proceeding:
node migration-kit/scripts/run_migration.mjs approve translation \
  --targets ported/a.js,ported/b.js --note "User authorizes repair of these reviewed targets"
node migration-kit/scripts/run_migration.mjs repair --queue migration/repair-queue.json
node migration-kit/scripts/run_migration.mjs approve build --note "User reviews repaired outputs and authorizes a fresh build"
node migration-kit/scripts/run_migration.mjs build
```

One coordinator retains the global lock, freezes each diagnostic slice and repairs
unique targets through the existing two-review/confirmation/fix/re-review loop.
Diagnostics are evidence for reviewers, not permission to bypass arbitration.
Independent slices overlap under the same global AI cap; dependent queue entries
wait for their predecessor's fresh reviewed result. Changed inputs, candidate
hashes, evidence, build execution or output tree make an old queue invalid.
Each queue binds one build round. Before any worker starts, the coordinator
archives ALL jobs and exact diagnostics in migration/state/repairs/ID.json, then
atomically publishes migration/state/repair.json as its reference. Every queued
target now requires reviews bound to that intent, including jobs not yet started.
A crash before per-unit state is written cannot restore a previous done receipt.
The archive and review bindings remain completion evidence; retain them.

After interruption, `translate` resumes every unfinished admitted job inside the
current approval, retaining completed reviews and fixed diagnostics. Status reports
pendingRepairs; build and later gates reject unfinished repair evidence. A new
approval cannot drop unfinished targets. The original queue remains stale after
its build is invalidated; do not disable that check to resume. A single-target
repair may resume an unfinished admitted target using its exact frozen diagnostic.
Finish the pending intent before starting another queue or a different diagnostic.
Finish fresh reviews before approving a new build/queue. Do not replay the stale
queue against changed candidates or an invalidated build.
One whole build runs after the joined repairs, following fresh human approval.
Smoke/parity and their approvals from the old build cannot remain valid.

The queue repairs individual manifest outputs. It does not make coupled SCC or
multi-file module publication atomic. For file cycles without typecheck, the
existing scheduler removes only internal ordering and keeps external prerequisites;
with unit typecheck it rejects those cycles. Resolve shared output ownership or
use a separately designed module adapter instead of disabling the lock.

## Measured deferred-marker counts

New configuration templates choose markerPolicy `todo-lines-v1`; existing configs
without it retain their reviewed convention. Agree this policy in RULEBOOK before
opting in. It counts literal lines containing TODO(port), including strings and
comments, like grep -c rather than syntax parsing. Two markers on one line count
as one. Exactly one PORT STATUS line must be the final nonempty line, ending in
`PORT STATUS: confidence=high|medium|low todos=N` using the target's comment syntax.

The coordinator gives both reviewers identical measured candidate-bound evidence.
After successful independent review it rejects mismatched/missing counts instead
of silently correcting the file. The completion receipt binds measured count and
candidate hash; changed evidence is not done. Repair only a confirmed count
finding, then re-review. This optional Node hard check is a new strengthening of
upstream's mechanical counting procedure, not a claim that upstream shipped such
a hard gate. It does not judge whether the deferred implementation is acceptable.
