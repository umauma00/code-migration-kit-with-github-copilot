# Usage records in the upstream main format

[日本語](COST-LOG.md) | English

The requested model and the actual model are kept apart. Only the model the CLI reports (`model.call_final_result`) counts as actual; configured values and a worker's own claim never do. Pilot AI calls are recorded as 03, production repair as 05 and normal translation as 04. judge-prepare and reuse by the formal judge are separate execution rows, but reuse counts no new AI calls.

The same `migration/cost-log.tsv` as upstream main is written, with these six columns:

```text
step	timestamp	wall_clock_min	tokens	subagents	model
```

For 00–03 and runtime 06, the time from phase start to phase complete is recorded. Without a start record, the duration is unknown. Pass only measured host values, at completion.

```sh
node migration-kit/scripts/run_migration.mjs phase complete 01 --note "Reviewed the dependency mapping and its audit" --tokens 12345 --subagents 2 --model ACTUAL_MODEL_ID
```

Omit options whose values are unknown. Confirm the model from actual host execution information; never copy the configured value or a worker's own claim as the actual model. Never estimate costs or token counts.

The runner records each judge, translate/repair, build, smoke, parity and handoff run automatically. Failures and interruptions are recorded too, once collection and the run summary are saved. 04's subagents is the number of adapter calls actually made, excluding reservations cancelled before the call. If usage of even one call is unknown, the total tokens is unknown. With the CLI backend the model column records the model the CLI reports in its JSONL `model.call_final_result` events (only when every call reported one; a model different from the request is a run warning). When the CLI does not provide the model, and for tokens, which it does not report, the value is unknown.

Automatic time and usage cover activity inside the runner; they are not the total bill, which also includes the parent conversation and Rubber Duck. Verification commands that call no AI record tokens=0, subagents=0, model=none. The formal judge is recorded additionally as 00b validation activity. Several rows are separate runs or retries, not counts of completed phases.

Existing upstream rows in the TSV are kept. Event IDs are tracked in migration/phases/cost-index.json so re-exporting the same completion record does not duplicate rows. A deleted TSV or one interrupted mid-write can be re-exported from the index. If a managed row is edited by hand, the mismatch is reported and the run stops. New rows appended by hand are kept.

`usageEstimate` in the run summary `migration/runs/RUN_ID/summary.json` holds the measured bytes sent to and received from workers and tokens estimated as bytes ÷ 4. It is not AI Credits billing data and never goes into cost-log.tsv. CLI workers record the CLI's own usage per call with `--usage-output-file` (input, output and cache tokens, AI units), summed as `measuredUsage` in the run summary. When every call of a run was measured, cost-log.tsv records input plus output tokens as `tokens`. Survey run reports (`migration/surveys/KIND/runs/RUN_ID.json`) carry `measuredUsage` the same way, and fill `tokens` only when every call was measured.

## Kit-wide usage

Every translation, repair, survey and preparation audit worker call, successful or not, adds one line to `migration/runs/usage/calls.jsonl` (role, target, model and the CLI's usage; a call the CLI wrote no usage for stays as unmeasured).

```bash
node migration-kit/scripts/run_migration.mjs usage --format markdown
node migration-kit/scripts/run_migration.mjs usage --run RUN_ID
```

It shows input, output and cache tokens and AI units (AIU: the CLI's nano AIU / 1e9) in total, by role and by model. It only reads, so nothing asks to confirm. With unmeasured calls the total is a lower bound.

Not included: the chat with the orchestrator (the parent session; run `/usage` in that Copilot CLI session), calls before 0.22.0, and other roots such as pilots (pass `--root`). The CLI does not report the AI Credits amount; check GitHub billing for the charge.
