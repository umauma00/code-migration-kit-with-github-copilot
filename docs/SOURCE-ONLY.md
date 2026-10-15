# Source-only verification

The [isolated pilot](PILOT.md) can run translation/build/smoke using this mode,
but cannot authorize parity or issue production handoff. The early
`judge-prepare` path validates the source-derived plan without executing original
or mutation commands. Inference remains distinct from measured equivalence.

Runtime verification remains the default. For a new project initialize with
`--verification-mode source-only`; existing config is retained even when this
option is supplied. For an existing project, explicitly set
`verificationMode: "source-only"` in migration/config.json at a phase boundary.
Changing the mode invalidates prior receipts and approvals through the context hash.
Models, concurrency, call limits and fix limits remain unchanged.

00 assesses feasibility and scope. 00b prepares source-derived public contracts,
inputs/outputs/errors, test scenarios, inferred expectations and unknowns. Copy
[the plan example](../templates/judge-plan.source-only.json) to
migration/judge-plan.json and replace every placeholder. Its required fields are:

- schemaVersion 1 and verificationMode source-only; a nonempty method.
- Nonempty sources: existing nonempty files under sourceRoots.
- Nonempty scenarios: each has an existing nonempty path under verificationRoots
  or verificationInputs, a concrete contract, and expectationBasis source-inferred.
- Nonempty unverified: explicit limitations and behavioral uncertainties.

Paths are repository-relative, without symlinks. Outputs, build artifacts and
runner-generated state/results/gates/runs cannot supply this evidence. The plan
and every referenced file are hashed. Empty reports or arrays are not preparation.
Do not describe inferred expectations as observed original results.

After 01/02 have provided RULEBOOK, inventory, manifest and audited dependencies,
run `node migration-kit/scripts/run_migration.mjs judge`. It validates preparation
without launching original/mutation. The receipt says preparation validated and
equivalence unverified. No executable original/mutation/parity is required in this
mode; this does not waive feasibility, prototype, explicit translation approval,
independent frozen two-reviewer receipts, build or smoke.

03 uses source-derived adversarial cases in disposable target workspaces. Report
actual target checks separately from source inferences and unavailable original
checks. Native pilots use the same native backend, requested models and isolation
contract as production; do not force Copilot CLI onto a native project.

Approve translation, translate, approve/run build, then approve/run smoke using
the normal gates. 05c is **unverified / not run in this mode**. Attempts to approve
or run parity are rejected; no passed parity receipt is created.

For 06, prepare migration/handoff.md containing reviewed output coverage,
build/smoke receipts, source-derived contracts, unresolved assumptions, explicit
behavioral equivalence unverified, and steps needed for later runtime parity.
Have the user review the concrete report and current smoke results, then run:

```sh
node migration-kit/scripts/run_migration.mjs approve handoff --note "Reviewed current smoke, source assumptions and handoff limitations"
node migration-kit/scripts/run_migration.mjs handoff
```

The handoff receipt is separate from parity and post-parity. Its final outcome is
**Source-based migration complete; behavioral equivalence unverified**
（ソース基準の移植完了・動作同等性未検証）. The report is hash-checked by
approval and receipt. Output edits, upstream reruns and input changes invalidate
this path. Correct outputs via the existing repair/review flow and repeat the
required downstream approvals/checks. Runtime projects still require parity.
