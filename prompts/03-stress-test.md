# 03 — Stress-test the rules

Work in the order of the [one-page checklist](../docs/STRESS-TEST-CHECKLIST.md)
([English](../docs/STRESS-TEST-CHECKLIST.en.md)) and show it to the user.

Read [phase reports and user decisions](../docs/PHASE-HANDOFF.md).
End with its report; ask for the next decision only when needed.

Command guardrails: `phase start 03` refuses to start without `migration/guardrails.json`
(adapted to this target) or a recorded waiver. Installing it is the human's act, because
that is when they decide the referee price: propose the list from `guardrails show` in
chat, and only after their agreement run `guardrails install` with exactly those options;
the host asks them to confirm it. Never create, edit or relax the file any other way. If a guardrail
denies a command, that is the design working; report it instead of routing around it.
Run `doctor` and confirm `repository hooks load in Copilot CLI` is not failing.
If `commands can write outside the project and use loopback` fails (a local
sandbox), ask the person before comparison B and the pilot, with its guidance;
never change sandbox settings yourself.

Prerequisite: reviewed rulebook, map, inventory and judge. Produce
`migration/stress-test/report.md`; the user reviews it before translation.

Select 3–5 difficult files by risk and inventory coverage, with scored evidence.
In auto mode select 3, the fewest: nobody is asked about the count.
For preserve mode, run a dual translation experiment:

- A follows the rulebook exactly in a disposable workspace.
- B receives ONLY copied source files in a separate directory outside the repo
  and an instruction to port them idiomatically. No parent conversation, rulebook,
  inventory or migration skill is passed to B. Run B as a fresh `copilot -p` process
  in that directory with `--no-custom-instructions --disable-builtin-mcps`, only
  file tools in `--available-tools`, `--allow-tool write` and `--model` set to
  phaseModels.stressB. Get the exact command from
  `run_migration.mjs stress-b command --dir DIR` (DIR: that directory, absolute)
  and run the line for your shell as it is: the runner reads which file tools
  this model has from the CLI (no AI usage) and lists only those, with at least
  one that writes. Model families differ (gpt-6-luna on CLI 1.0.105 writes only
  through `apply_patch`). When the CLI cannot be asked here, the result says
  `verified: false` and lists the file tools of every known family. Only when
  the runner cannot be used at all, use the
  checklist's fallback command, which keeps `apply_patch` in the list.
  `--no-custom-instructions` alone still exposes user and plugin skill
  descriptions; leaving `skill` out of `--available-tools` keeps them out. Use the
  same terminal command in VS Code: a subagent of this chat inherits its context
  (Local subagents also inherit workspace instructions with the kit's block).
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
run the read-only `pilot plan --sources CSV --through STAGE` and ask for permission
once with its final file count (chosen files plus the files they use; in auto mode
a translation-only pilot without a unit typecheck takes the chosen files only) and its
`plain` sentence, then
`pilot prepare --expect-total TOTAL --target NEW_EXTERNAL_DIR --sources CSV --through STAGE --note TEXT`,
then `pilot run --root NEW_EXTERNAL_DIR` in a background terminal, never piped or
redirected, checked with `status --root NEW_EXTERNAL_DIR --wait 600` like every
long runner command. Obtain explicit authorization for that
scope; default boundary is translation. Production still requires reviewed 03.
Run independent A/B/pilot work concurrently when the host permits it, record
isolation limitations, archive findings and verify workspace disposal. Repeated
failure of the same rule stops for design review; a rule change needs a fresh
grant and new risk-weighted samples.

Collect proposed rule amendments; only apply them with the user's authorization
at the gate. Rerun against fresh risk-weighted files, not only the original ones.
Repeated changes to the same rule need a design decision, not another wording.
Report timings, known usage, rule adherence and unresolved questions. Never start
production fan-out based on your own favorable report. When the person has reviewed
the report and wants translation to start, record both with one confirmation:
`approve translation --complete-phase 03 --note TEXT` (add `--batch N` or
`--targets` for a bounded first scope). `phase complete 03` alone stays available.

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

In source-only mode, prototype against source-derived contracts and adversarial
target scenarios; do not require the original runtime. Clearly distinguish target
execution from inferred parity, report unverified assumptions, and keep disposable
receipts separate.
Before resolving difficult prototype or test-design questions, follow
[built-in Rubber Duck](../docs/RUBBER-DUCK.md); advice does not replace two reviews.
