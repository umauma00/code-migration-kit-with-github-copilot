# Code migration

For language migration tasks, read the [operating manual](../docs/OPERATING-MANUAL.md)
and use the matching [phase prompt](../prompts/00-feasibility.md).
Verification mode is explicit: runtime (default) keeps the old implementation
runnable and requires original/mutation/parity validation. Source-only uses
source-derived contracts and explicit unknowns without running the original;
reviewed build/smoke lead to handoff with equivalence unverified. Never change the rulebook or judge inside
translation/fix loops. Stop at phase gates. Use the runner for translation;
workers return JSON and only the coordinator writes manifest targets.
A file is complete only with a current, reviewed completion receipt.
In the main conversation, follow [phase reports and user decisions](../docs/PHASE-HANDOFF.md):
show artifacts, review points and the next instruction; use the available question
tool for missing decisions. Respect answers already given and never treat an
unanswered question as approval. Automated workers keep their JSON-only output.
The parent tracks all ten phases in the host TODO list under the same contract,
including approval waits and failures; use a chat checklist if unavailable.
Reconcile progress from current evidence on resumption, never from TODO checks alone.
For maintenance in the distribution source, run `npm test` and `npm run demo`.
The installed runtime package provides `npm run check` inside `migration-kit/`.

The top-level user-facing parent retains phase/TODO/question ownership; do not
delegate the full orchestration to a child. Follow [phase handoff](../docs/PHASE-HANDOFF.md),
[source-only verification](../docs/SOURCE-ONLY.md) and [built-in Rubber Duck](../docs/RUBBER-DUCK.md).

Before phase work, follow [ordered workflow](../docs/ORDERED-WORKFLOW.md): initialize phase records and ask the runner for the first incomplete phase. File existence and TODO checks do not waive prerequisite reviews. [Cost logs](../docs/COST-LOG.md) use measured values or unknown.
