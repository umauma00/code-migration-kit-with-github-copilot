# 03 — Stress-test the rules

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Prerequisite: reviewed rulebook, map, inventory and judge. Produce
`migration/stress-test/report.md`; the user reviews it before translation.

Select 3–5 difficult files by risk and inventory coverage, with scored evidence.
For preserve mode, run a dual translation experiment:

- A follows the rulebook exactly in a disposable workspace.
- B receives ONLY copied source files in a separate directory outside the repo
  and an instruction to port them idiomatically. No parent conversation, rulebook,
  inventory or migration skill is passed to B. Use a fresh CLI session and
  `--no-custom-instructions`; verify that personal customization does not leak.
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

Collect proposed rule amendments; only apply them with the user's authorization
at the gate. Rerun against fresh risk-weighted files, not only the original ones.
Repeated changes to the same rule need a design decision, not another wording.
Report timings, known usage, rule adherence and unresolved questions. Never start
production fan-out based on your own favorable report.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->
