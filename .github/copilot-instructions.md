# Code migration

For language migration tasks, read the [operating manual](../docs/OPERATING-MANUAL.md)
and use the matching [phase prompt](../prompts/00-feasibility.md).
Keep the old implementation runnable. Never change the rulebook or judge inside
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
