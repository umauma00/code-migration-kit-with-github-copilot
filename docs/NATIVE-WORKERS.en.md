# Running workers as VS Code subagents (experimental)

[日本語](NATIVE-WORKERS.md) | English

> **Runs inside VS Code only, with the executed model unverified.** `nativeModelVerification` has two values:
>
> | Setting | Condition for submitting | On VS Code |
> |---|---|---|
> | `requested-unverified` (default for new native installs) | The requested model was passed to the per-call model parameter | Completes; records say "executed model unverified" |
> | `host-metadata` (when omitted in existing configs) | The executed model was confirmed from host execution metadata | Cannot complete, because VS Code returns no such metadata (experimental) |
>
> When the Copilot CLI is available, the CLI worker backend (`copilot-cli`, the default) is recommended.

`workerBackend: "native"` makes the parent agent of the current VS Code session start subagents; the Copilot CLI is not started. The Node runner issues jobs, validates results, writes files and handles independent review, arbitration and fixing, approvals, completion records and resumption.

| Where | workerBackend | nativeHarness | Installation |
|---|---|---|---|
| VS Code Local | `native` | `vscode-local` | Repository copy |
| VS Code Copilot (Agent Host) | `native` | `copilot` | Plugin or copy |
| Copilot CLI | `copilot-cli` (default) | not needed | Plugin or copy |

This is not automatic dispatch by a VS Code extension: the parent agent services the connection by following the shared skill. Starting only the runner calls no AI; it waits for submissions. Local and Copilot differ in the delegation tool and how the model is chosen. See also the [official VS Code subagent documentation](https://code.visualstudio.com/docs/agents/run/subagents).

## Initialization and settings

`doctor` reports static configuration and profile validity as `staticValid`, and native execution capability as `executionReady: "unknown"`. There is not yet a formal adapter that ties together executed-model information, launch handles, completion notifications and child cancellation. With `host-metadata`, native doctor exits with code 1 and never reports execution as verified; with `requested-unverified` it succeeds when the static checks pass and reports `executionReady: "models-unverified"`. A string match in Node does not prove host metadata is genuine. Do not copy the requested model, or a worker's own claim, into the record as if it were observed. `observedModel` in cost and usage records stays null/unknown without a formal source.

| Capability | CLI adapter | VS Code Copilot native | VS Code Local native |
|---|---|---|---|
| Launch | Independent CLI subprocess | Parent delegates after checking the public host schema | Parent delegates after checking the public host schema |
| Parallelism | Node scheduler within the shared cap | Node issues in parallel; host dispatch unverified | Node issues in parallel; same-turn calls and group waits depend on the host |
| Collecting in completion order | Collected from settled promises | Handle/event bridge not implemented | Blocking tool calls and the parent's group-wait limits need checking |
| Executed model | Not known from the normal JSON response | Bridge between task and real metadata not implemented | Public main's toolMetadata is separate from the parent-facing body; live retrieval path unverified |
| Stop | Runner stops the CLI process group | Parent stops both the runner and children; child API needs checking | Parent stops both the runner and children; child API needs checking |

Distinguish observations of public main from the installed version. Before starting, confirm the requested model/profile/tools, how real metadata is obtained, the task/child mapping, independent context, parallel collection and Stop responsibility; if any cannot be confirmed, report it as unsupported. Never guess arguments missing from the public schema and claim they were applied. On a real host, use a short job A, a long job B and a job C depending on A, and check whether A can be submitted and C started before B ends, whether a substituted model is detected, whether children stop after timeout/Stop, and whether stale results are rejected after resumption.

Repository-copy example for Local. After previewing, add `--apply` following the project initialization instructions.

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target /path/to/project --harness vscode-local --worker-backend native --model MODEL_ID
```

For a VS Code Copilot plugin installation:

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target /path/to/project --layout plugin --worker-backend native --native-harness copilot --model MODEL_ID
```

For an existing project, set the following in `migration/config.json` (an excerpt of the added fields). The installer never changes existing configuration. After switching backends, redo judge and the translation approval.

```json
{
  "workerBackend": "native",
  "nativeHarness": "vscode-local"
}
```

Set `models` to model names/IDs the host can select, per role; nothing is substituted automatically. Keep `concurrency` at or below the host's concurrency limit; it is a shared cap that includes reviewers. `timeoutSeconds` also includes the wait from issuing a task to its submission.

After updating the kit, restart the chat to load the new profiles. Repository copies name them `migration-native-ROLE`, plugins `code-migration-plugin-native-ROLE`. All five roles keep `tools: []`; the CLI profiles remain separate. Plugin native reserves both the fully qualified ID and the unqualified name, and doctor and the pre-launch check stop if a different agent in the project, an ancestor or personal settings uses the same name or file-derived ID.

Native `doctor` does not start the CLI and checks the dedicated profiles, even with `--check-cli`. Profile resolution on the host, model availability and actual tool restrictions are not guaranteed by checks run from Node.

### VS Code prerequisites

Confirm these in VS Code before the first native run (`doctor` lists them under `native host requirements`; Node cannot read VS Code settings):

- VS Code 1.117 or later. From that release `runSubagent` accepts a per-call model; the model is chosen in this order: the per-call model, the profile's `model` frontmatter, then the parent conversation's model. The kit always uses the per-call model, so its profiles carry no `model`.
- `chat.customAgentInSubagent.enabled` is on. Without it the dedicated native profiles cannot run as subagents.
- The requested models are allowed for subagents on this account; some models are not.
- The worker profiles have `user-invocable: false`, so they stay out of the agent picker. The CLI worker profiles also have `disable-model-invocation: true`, so a parent never calls them as subagents; the native profiles stay callable because the parent dispatches them.

### Selecting and confirming the model

On Local, use `runSubagent`'s model argument; on Copilot, use the per-call model argument of the delegation tool the host exposes. Writing a model name into the prompt is no substitute. On a host without per-call selection, report the job as failed. Per-call selection is documented in [VS Code Local's selection order](https://code.visualstudio.com/docs/agents/run/subagents#select-the-model-for-a-subagent) and [the Copilot runtime's selection order](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#custom-agent-frontmatter-fields). Project-specific models do not need to be baked into the shared plugin profiles.

With `requested-unverified`, pass the requested model to the per-call model parameter and give the same requested model to `submit --model`. If the host does not accept or rejects that model, use `fail`. A host fallback to another model cannot be detected, so `modelVerification` in attempt records, `modelVerification` and `warnings` in the run summary, status and doctor all say unverified, and reports state "executed model unverified". The rest of this section is the `host-metadata` procedure.

The Copilot runtime may fall back to another model when the requested one cannot be used, so successfully requesting it is not enough. Before submitting, confirm the model actually used from the execution metadata the host returns. If it differs from the request, cannot be confirmed, or the naming correspondence is unclear, use `fail`. Pass the confirmed model to `submit --model`; never copy the request's `model` or treat the model's own answer as proof. Because Node cannot independently verify the host's claim, `observedModel` in receipts stays null.

## Parent agent procedure

For plugin installations, replace `migration-kit/` below with the plugin's absolute path resolved from the loaded skill. The working directory is the target repository.

1. Confirm the dedicated native profiles, tool-free execution, configured models and concurrency limit. If any is unavailable, report why; never switch to the CLI silently.
2. After translation approval, start `translate` (or `repair --target ... --evidence ...` for repairs) with the terminal's continuing-run feature and keep the terminal/PID. Do not block the parent waiting for the runner to finish.
3. `claim` as many pending tasks from `list` as there are free slots.
4. Pass the `prompt` unchanged to the dedicated subagent named by the claim's `agent` (fully qualified ID) or `agentName` (for hosts that select by name), setting `model` through the host's actual model argument. Do not request the parent conversation, and do not add other reviews, logs or explanations.
5. Submit the returned JSON without summarizing or editing it, using the task ID and claimToken from the claim. Confirm the model used from host execution metadata as described above. The parent never fabricates a pass or writes the target file directly.
6. Submit failures such as an unavailable model or an invalid response with `fail`. The parent never stands in for a worker; if a fix is needed, the runner issues a new task.
7. Repeat until the runner exits. An empty list can mean checks or the next task are in progress. Check the exit code, summary and `status`, and report reviewed done/total. Do not continue to build or later stages without separate approval.

```bash
# Run continuously in a terminal; do not block the parent waiting for it
node migration-kit/scripts/run_migration.mjs translate

# The parent repeats these in separate tool calls
node migration-kit/scripts/native_workers.mjs list
node migration-kit/scripts/native_workers.mjs claim --task TASK_ID

# Save the received JSON unchanged into the task's own file and submit it
node migration-kit/scripts/native_workers.mjs submit --task TASK_ID --claim CLAIM_TOKEN --model HOST_MODEL_ID --file migration/runs/RUN_ID/native/JOB_ID/answer.json

# Report a launch failure or similar
node migration-kit/scripts/native_workers.mjs fail --task TASK_ID --claim CLAIM_TOKEN --error "Requested model is unavailable"
```

`--file -` submits from standard input. To keep backquotes, `$()` and similar in code away from shell interpretation, save the JSON with the host's file-editing tool or pass it on standard input. `answer.json` is the parent's transfer data; workers get no permission to edit it.

## Contract and resumption

- A task is bound to the run ID, role, target, input hash, candidate hash and run lock. Claims are exclusive and a task is submitted once. Results with the wrong target or model, expired or from an old run, or with invalid JSON are rejected. `accepted: true` means accepted, not a completion receipt.
- Both reviewers get the same frozen input; implementation, arbitration and fixing also get the audited dependency closure. Unlike CLI workers they cannot search further. Missing material is fixed outside the phase in the dependency declaration or rules, then re-validated and re-approved. An oversized input stops without truncation (there is no switch to tool-assisted review as on the CLI backend).
- Stop with cancel/Ctrl+C in the runner's terminal. Node cannot kill host subagents, so the parent stops them too. Never reuse a late result for a new task after resumption. Workers have no tools, so they cannot edit directly.
- Resume by re-running `translate`. New task IDs are issued and only valid receipts are reused; partial output gets its missing reviews. After a crash, remove the lock with the existing `unlock --pid` only after confirming that the owning process has exited. `list` shows only tasks of the run ID in the run lock. Corrupt old requests, or old tasks left unclosed by a crash, do not block resumption; corruption of a current unfinished request is an error.
- Native does not guarantee isolation equivalent to the CLI's `--no-custom-instructions`. Receipts record `instructionIsolation: "host-managed"` and the backend. Root instructions, GitHub instructions, skills and the like are tracked, but host settings, ancestors and personal instructions are not detected automatically. Register additional in-project instructions in `verificationInputs`, and re-validate when host settings change. A separate context is not the same as zero implicit instructions.
- `hostReportedModel` is the parent's claim. Measured model, tokens and credits are null.
- Do not start native from Dynamic Workflows. Native uses the current host session; the CLI backend uses the existing CLI adapter.

## Verification scope

[native-workers.test.mjs](../tests/native-workers.test.mjs) verifies parallelism, frozen review input, arbitration and fixing, interruption and resumption, rejection of stale submissions, input changes, model mismatches and stdin transfer. Responses are prepared, but build/smoke/parity really run on the fixture's Python/Node. Model delegation, profile resolution and tool restrictions in a real VS Code need separate live verification.

Before a real project, check on a small fixture that all five roles are selected, the model is set, tools are empty, both reviewers get the frozen input, cancel/resume works, and no unapproved next phase starts.

## VS Code orchestration and verification modes

See the canonical section in the [operating manual](OPERATING-MANUAL.md#vs-code-orchestration-and-verification-modes).

## Dispatch, cancellation and resumption

Start the runner in a continuing terminal. Keep servicing list/claim/delegate/submit
from the top-level parent rather than awaiting terminal completion. All two-reviewer
and implementation/fix/arbiter calls use the existing global concurrency cap.
Available unit slots refill without waiting for an entire wave. Audited transitive
manifest dependencies finish before dependent units start; non-manifest dependencies
are fixed source. Cycles without unit typecheck consume fixed source as a group;
cycles with unit typecheck fail with paths and a grouping/defer-check remedy.

Use existing cancellation only. VS Code Stop does not guarantee continuing terminals
or subagents have stopped. If runner activity continues, send Ctrl+C to its terminal
and stop host children too. Check status/processes before rerunning translate.
Never unlock a live runner. Resume via translate; valid completed receipts and the
one successful independent review are reused, stale native submissions rejected.
No pause/resume/timebox or batch-stop command is introduced.
