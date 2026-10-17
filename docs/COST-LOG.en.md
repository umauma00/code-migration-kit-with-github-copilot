# Usage records in the upstream main format

[日本語](COST-LOG.md) | English

The requested model and the actual model are kept apart. A native submission's hostReportedModel is input from the parent and is not counted as a measurement on its own; it stays unknown until a formal adapter observes it. Pilot AI calls are recorded as 03, production repair as 05 and normal translation as 04. judge-prepare and reuse by the formal judge are separate execution rows, but reuse counts no new AI calls.

The same `migration/cost-log.tsv` as upstream main is written, with these six columns:

```text
step	timestamp	wall_clock_min	tokens	subagents	model
```

For 00–03 and runtime 06, the time from phase start to phase complete is recorded. Without a start record, the duration is unknown. Pass only measured host values, at completion.

```sh
node migration-kit/scripts/run_migration.mjs phase complete 01 --note "Reviewed the dependency mapping and its audit" --tokens 12345 --subagents 2 --model ACTUAL_MODEL_ID
```

Omit options whose values are unknown. Confirm the model from actual host execution information; never copy the configured value or a worker's own claim as the actual model. Never estimate costs or token counts.

The runner records each judge, translate/repair, build, smoke, parity and handoff run automatically. Failures and interruptions are recorded too, once collection and the run summary are saved. 04's subagents is the number of adapter calls actually made, excluding reservations cancelled before the call. If usage of even one call is unknown, the total tokens is unknown. When the CLI cannot provide the actual model or usage, they are unknown.

Automatic time and usage cover activity inside the runner; they are not the total bill, which also includes the parent conversation and Rubber Duck. Verification commands that call no AI record tokens=0, subagents=0, model=none. The formal judge is recorded additionally as 00b validation activity. Several rows are separate runs or retries, not counts of completed phases.

Existing upstream rows in the TSV are kept. Event IDs are tracked in migration/phases/cost-index.json so re-exporting the same completion record does not duplicate rows. A deleted TSV or one interrupted mid-write can be re-exported from the index. If a managed row is edited by hand, the mismatch is reported and the run stops. New rows appended by hand are kept.
