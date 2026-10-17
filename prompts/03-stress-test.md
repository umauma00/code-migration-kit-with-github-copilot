# 03 — Stress-test the rules

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Command guardrails: `phase start 03` refuses to start until the human has copied
`templates/guardrails.json` to `migration/guardrails.json` (adapted to this target) or
recorded a waiver there. Never create, edit or relax that file yourself: installing it is
the human's act, because that is when they decide the referee price. If a guardrail
denies a command, that is the design working; report it instead of routing around it.
Run `doctor` and confirm `repository hooks load in Copilot CLI` is not failing.

Prerequisite: reviewed rulebook, map, inventory and judge. Produce
`migration/stress-test/report.md`; the user reviews it before translation.

Select 3–5 difficult files by risk and inventory coverage, with scored evidence.
For preserve mode, run a dual translation experiment:

- A follows the rulebook exactly in a disposable workspace.
- B receives ONLY copied source files in a separate directory outside the repo
  and an instruction to port them idiomatically. No parent conversation, rulebook,
  inventory or migration skill is passed to B. Use a fresh isolated session: CLI projects use `--no-custom-instructions`;
  native projects use host-native isolated tool-free dispatch with the requested
  model verified in host metadata. Verify personal customization does not leak.
  The kit does not pretend that a second worktree alone provides this isolation.
- A separate inspector formats both outputs and classifies differences:
  rulebook right, native right, both defensible or both wrong. Cite evidence.

For redesign mode, do not run this bakeoff: use adversarial design review and
small disposable subsystem trials. The file runner does not implement a generic
module redesign adapter.

Then run a pilot through the SAME installed Copilot worker profiles and runtime
used in production, using a disposable target repo with its own explicit pilot
approval. Check rule adherence, read-only tools, JSON output, models and repair
behavior. Do not mix disposable receipts with production receipts.

Use the formal [pilot grant](../docs/PILOT.md): after current 00–02 and judge,
`pilot prepare --target NEW_EXTERNAL_DIR --sources CSV --through STAGE --note TEXT`,
then `pilot run --root NEW_EXTERNAL_DIR`. Obtain explicit authorization for that
scope; default boundary is translation. Production still requires reviewed 03.
Run independent A/B/pilot work concurrently when the host permits it, record
isolation limitations, archive findings and verify workspace disposal. Repeated
failure of the same rule stops for design review; a rule change needs a fresh
grant and new risk-weighted samples.

Collect proposed rule amendments; only apply them with the user's authorization
at the gate. Rerun against fresh risk-weighted files, not only the original ones.
Repeated changes to the same rule need a design decision, not another wording.
Report timings, known usage, rule adherence and unresolved questions. Never start
production fan-out based on your own favorable report.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

In source-only mode, prototype against source-derived contracts and adversarial
target scenarios; do not require the original runtime. Clearly distinguish target
execution from inferred parity, report unverified assumptions, and keep disposable
receipts separate. Use the configured native backend for native pilots.
Before resolving difficult prototype or test-design questions, follow
[built-in Rubber Duck](../docs/RUBBER-DUCK.md); advice does not replace two reviews.
