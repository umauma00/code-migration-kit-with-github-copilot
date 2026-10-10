# Code migration

For language migration tasks, read the [operating manual](../docs/OPERATING-MANUAL.md)
and use the matching [phase prompt](../prompts/00-feasibility.md).
Keep the old implementation runnable. Never change the rulebook or judge inside
translation/fix loops. Stop at phase gates. Use the runner for translation;
workers return JSON and only the coordinator writes manifest targets.
A file is complete only with a current, reviewed completion receipt.
For maintenance in the distribution source, run `npm test` and `npm run demo`.
The installed runtime package provides `npm run check` inside `migration-kit/`.
