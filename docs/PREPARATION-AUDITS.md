# Preparation audit contracts

These contracts restore upstream preparation checks. The scripts below freeze
evidence and perform mechanical checks; they do not execute AI, authenticate
human approval, attest a host model, or declare an independent audit complete.
The parent coordinates fresh workers within an explicit call/concurrency budget,
confirms findings against source, fixes only confirmed problems, then obtains
fresh independent review. Never share one reviewer's findings with the other.

## Comparator (00b)

Reuse adequate public-surface tests; do not rebuild an existing judge just to
complete 00b. Record reuse, coverage, narrow normalization and limitations.
Run `run_migration.mjs judge-prepare` after reviewed 00, before maps/rules exist.
It records original success and intentional mutation detection in
`migration/results/judge-preparation.json`. After 01/02, formal `judge` binds
current migration inputs and may explicitly reuse this unchanged preparation
execution. A source/judge/command/input/runtime change invalidates reuse. A new
early execution invalidates the old formal judge and downstream chain.
Source-only records plan validation with no original/mutation execution.

When assertions are ported, give two independent hostile auditors disjoint
assertion batches, with the original assertions, new harness, fixtures, exact
normalization/tolerance rules and expected public contract. Each compares old
and new assertions for removed fields, relaxed tolerances, truthy replacements,
ignored errors and ordering/Unicode/numeric changes. Report the original/new
assertion, weakening example and proposed fix. Confirm, repair and re-audit with
fresh contexts until no confirmed issue remains; stop if coverage or proof is
missing. Mutation testing complements this comparison and cannot replace it.

## Dependency map (01)

First extract five files (all available if fewer), inspect parser output and show
the trial to the human before full generation. Name unsupported syntax, unresolved
imports, generated/vendor exclusions and the scanner's supported language forms.
Do not infer an unsupported edge as fact or silently omit its declaration.

### With a bundled or fixture-tested deterministic mapper (default)

The graph comes from a deterministic parser, so re-deriving 2 x 20 sampled files
over up to three rounds mostly repeats the parser's own output. Instead:

1. Mechanical checks: the five-file trial, every `unresolved.tsv` row and every
   exclusion warning reviewed (see [dependency mappers](DEPENDENCY-MAPPERS.md)),
   and a declaration for every file reachable from the manifest (missing ones fail).
   The selection also lists unresolved rows it could not map to a declared file.
2. `preparation_cli.mjs dependency-targets` picks about ten files: those the
   parser flagged in `unresolved.tsv` (most rows first), then the largest files.
3. Freeze those files as one request (`audit_inputs.mjs freeze --type
   dependencies --files LIST`, then `run`). The auditor lists every direct edge
   as a finding with source-line evidence. Write those edges to an observed-edge
   TSV and run `dependency-diff --files LIST --audit migration/observed-edges.tsv`
   on the same files. The selection stays within `maxReviewInputBytes`; files left
   out for size are listed (`skippedForInputSize`): lower `--size` or raise the
   limit only if you want them too. Binary files are left out
   too (`skippedNotUtf8Text`); legacy encodings are read decoded. A named `--unresolved` file
   must exist; rows it cannot place are listed under `unmatchedUnresolvedFiles`.
4. Confirm each difference against source. Fix the mapper copy or add the
   declaration, regenerate the whole map/order/manifest/review declaration, and
   run `dependency-diff` on the same files again. There are no further sampling
   rounds and no stop after a number of rounds: a dependency still unresolved is
   listed in `depmap/report.md` for the user review.

```bash
node migration-kit/scripts/preparation_cli.mjs dependency-targets --depmap-root src
node migration-kit/scripts/preparation_cli.mjs dependency-diff \
  --files src/a.py,src/b.py --audit migration/observed-edges.tsv
```

`--depmap-root` is the mapper's `--root`; with a single source root it defaults
to that root.

### With a hand-written graph or an unproven adapter

Two independent workers each audit 20 distinct files using random plus adversarial
sampling; batches must not overlap. For small repositories use all available
files split between workers and record actual coverage. `dependency-samples
--seed ROUND_ID` deterministically selects from declared files and records the
seed, population, requested and actual sample sizes. Add explicit exclusion and
unsupported-syntax challenges: samples of the declared graph alone cannot find
files missing from that graph. Re-read source to produce independent observed
edges with evidence, then run `dependency-diff`:

```bash
node migration-kit/scripts/preparation_cli.mjs dependency-samples --seed round-1
node migration-kit/scripts/preparation_cli.mjs dependency-diff \
  --files src/a.py,src/b.py --audit migration/observed-edges.tsv
```

Observed-edge TSV has header `from<TAB>to<TAB>evidence`. The diff reports missed
and invented edges separately; reported differences still need confirmation.
Fix the scanner, regenerate the entire map/order/manifest/review declaration,
then sample freshly with a new seed. Do not patch just edges.tsv. Sampling ends
after a clean round or after three rounds; then list what remains unresolved in
`depmap/report.md` and finish phase 01 with it, without a further round. Retain seed,
sample, extraction version, diffs, confirmed fixes and regeneration evidence.

Use a source-to-target-package map when packages have been designed:

```json
{"schemaVersion":1,"packages":{"src/a.py":"api","src/b.py":"core"}}
```

Set `packageMap` to its input path under migration/ and run `preparation_cli.mjs
package-cycles`. It checks file and target-package graphs separately and reports
a concrete cycle if one exists. Phase 01 binds this input and report when
configured. It does not fix package cycles or implement an atomic SCC runner.

## Inventory (02)

Show the first 20 rows (all available if smaller) to the human before fan-out.
Category classifiers own separate shards under migration/inventory-shards/;
the parent alone merges inventory.tsv. Every classifier batch receives two
independent reviews of the SAME batch, with source and RULEBOOK. Reviewers never
write shared inventory or see each other's results. Confirm disagreements before
any rule change; rule amendments require human authorization.

Maintain a mechanical census with header `file<TAB>symbol<TAB>source_construct`.
The unique merge key is that exact tuple; do not identify a site by row number.
Shard header is `file<TAB>symbol<TAB>source_construct<TAB>classification<TAB>
target_translation<TAB>evidence<TAB>status` (one line). Completed status is
confirmed or unknown. An unresolved site uses classification UNKNOWN, a
deterministic conservative representation with TODO(port), and an explicit open
question in its evidence. Never treat UNKNOWN as an invented language decision.

```bash
node migration-kit/scripts/preparation_cli.mjs inventory-merge \
  --sites migration/inventory-sites.tsv \
  --shards migration/inventory-shards/numeric.tsv,migration/inventory-shards/errors.tsv
```

Workers publish complete shard files atomically; retry only their own shard.
Merge rejects malformed/partial rows, missing census sites and conflicting
answers without changing the old inventory. Identical retries deduplicate and
sorting is deterministic. The merge receipt proves mechanical coverage, not
semantic correctness or independent review. Finally run a joint RULEBOOK/inventory
audit; each contradiction cites rule, row key, source evidence and a concrete
wrong translation example. Reconcile and re-audit before completing 02.

To review a combined candidate before publishing, use the built-in preview with
the existing shards. It uses the SAME TSV parser, comment handling, validation
and deterministic renderer as the formal merge. Do not add a project-local
parseTsv/writeReviewCandidate implementation or resurvey completed scopes.

```bash
node migration-kit/scripts/preparation_cli.mjs inventory-preview \
  --sites migration/inventory-sites.tsv \
  --shards migration/inventory-shards/numeric.tsv,migration/inventory-shards/errors.tsv
```

The JSON reports `out` (default migration/inventory-review-candidate.tsv),
`outputHash`, site/unknown counts and the input shard hashes. Preview checks full
census coverage, conflicts, row shape and UNKNOWN requirements BEFORE writing;
it never changes inventory.tsv or inventory-merge.json and grants no phase.
Notes are retained and identical retried rows deduplicate. Optional `--out` must
not overwrite inputs, shard/survey records, protected files or aliases.

After reviewing, pass that exact outputHash (replace OUTPUT_HASH below) to
`inventory-merge`. A changed output is rejected before either formal file is
written; regenerate the preview from existing shards when corrections are needed.

```bash
node migration-kit/scripts/preparation_cli.mjs inventory-merge \
  --sites migration/inventory-sites.tsv \
  --shards migration/inventory-shards/numeric.tsv,migration/inventory-shards/errors.tsv \
  --expected-hash OUTPUT_HASH
```

Hash equality proves byte equality with the reviewed candidate; the ordinary
independent audits, source evidence and human gates still determine correctness.
If a preparation/report helper raises TypeError or SyntaxError, inspect its
actual return value and caller, fix only the coordinator-owned helper, run its
syntax/mechanical checks and resume candidate generation. This is technical
recovery within the authorized phase, not a choice between fixing the helper
and dropping validation. Preserve all validated shards and official receipts.
Never change a shared parser's return shape without checking all callers; a row
array has no notes field, while the kit's internal table parser returns
`{ notes: [], rows: [] }` even when no comments exist.

migration/inventory-merge.json is reserved generated evidence; do not register
it as designInputs, verificationInputs or reviewDependencyMap. Configuration
validation and the merge writer reject input/receipt collisions, including file
aliases, before changing inventory or the protected input.

## Frozen audit requests and models

An audit runs on phaseModels.judgeAudit, dependencyAudit, inventoryAudit or
designAudit when the person set it, otherwise on the model they chose for
reviewer-semantics (an auditor's closest role); the request records the model
it froze. Other plan keys are rulebook, stressA, stressB and stressInspector. No
model ID normalization or availability claim is performed.

```bash
node migration-kit/scripts/audit_inputs.mjs freeze --type inventory \
  --files migration/RULEBOOK.md,migration/inventory-shards/numeric.tsv,src/a.py
node migration-kit/scripts/audit_inputs.mjs submit \
  --directory migration/audits/REQUEST_ID --response migration/auditor-answer.json
```

Run the request with `node migration-kit/scripts/audit_inputs.mjs run --directory
migration/audits/REQUEST_ID`: a fresh Copilot CLI process on migration-preparation-auditor
(or the plugin equivalent) with no tools and `--model` set to the requested
phaseModels entry; the result records the model the CLI reported, the CLI
version, session ID and usage. `audit_inputs.mjs run-pending` does the same for
every request directory without result.json, config.concurrency at a time, and
exits non-zero if any request failed; rerun it to retry only the remaining ones.

A request whose inputs, configuration or auditor profile changed fails with
"inputs changed" and can never be submitted. Freeze a replacement, then retire
the old one so it stops counting as pending:

```bash
node migration-kit/scripts/audit_inputs.mjs retire --directory migration/audits/OLD \
  --superseded-by migration/audits/NEW --reason "auditor profile changed"
```

Retirement writes retired.json (reason, replacement directory and task) next to
the untouched request; run, submit and run-pending skip it. A submitted request
cannot be retired. Retire only requests you have replaced or deliberately
dropped; a request that failed for a transient reason stays pending.

Do not dispatch the auditor through the host's task/agent tool: the profile sets
disable-model-invocation, a tool-free auditor cannot open a path, a model that
retypes a large body breaks the task/input hash binding, and host subagents
cannot guarantee the model (the CLI task tool overrides it only on an explicit
user request; VS Code Local refuses a model above the parent's cost tier). If
`run` fails, report its error as a failed step; do not substitute a subagent.
A response obtained another way can still be checked with `submit`. Two requests can share the same frozen input
but always have distinct task IDs. Do not forward prior findings, parent history
or a link instead of file bodies. The JSON contract binds task/input hash and
requires pass with no findings or changes with evidence-bearing findings.
Requests exceeding maxReviewInputBytes stop instead of truncating. Submission
rejects changed source, judge, config or selected documents, wrong task/hash and
duplicate submissions. Requested model remains separate from observedModel:null;
only a real host adapter can establish execution model/isolation. Include both
request/result paths and hashes in the phase report before human review. These
tools do not automatically enforce the number or independence of manual audits.
The preparation profile must retain tools: [] and no model override; changed
profile metadata invalidates pending requests. Exact UTF-8 body hashes are
checked against the current files as well as the returned task/input binding.
