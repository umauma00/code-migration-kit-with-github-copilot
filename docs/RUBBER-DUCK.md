# Built-in Rubber Duck

The user-facing parent may invoke only the actual read-only Rubber Duck capability
exposed by the current Copilot harness. Discover and use the host's real tool and
schema; do not assume private APIs, internal SQL, a particular tool name or host
configuration changes. Availability depends on host tools and complementary model
availability. A custom worker with a similar name is not Rubber Duck. If unavailable,
record not performed and why; continue authorized work without inventing a review.

Use at milestones: before settling the migration/comparison plan, for a difficult
prototype/change, after test design, or on recurring failures. Supply scope,
proposed approach, source-derived evidence and unresolved questions. Do not add
per-file calls or unbounded loops. Keep all AI calls including Rubber Duck within
config.concurrency: defer milestone advice to a phase boundary with no active native runner or host
workers. During native fan-out the parent keeps servicing jobs; never stop dispatch
to wait for a continually refilled queue to drain just to request advice. After
runner completion, inspect the milestone findings before the next approved stage. Do not change configured models
or limits to obtain this capability.

Save a record in migration/reviews/rubber-duck-<milestone>.md using
[the advisory template](../templates/rubber-duck-review.md). Each finding needs ID,
severity, evidence, adopt/reject/defer, reason, fix target and reverification
result/reference. The parent owns these decisions and implements adopted changes
through existing flows. Output findings become a selected diagnostic file for
`repair --target ... --evidence migration/...`, followed by independent reviews
and invalidated downstream checks. Source/RULEBOOK/judge changes require fresh
judge and translation approval. Save actual verification references, or pending.

This advisory record never approves a gate or completes a unit. Never include its
results in either unrelated frozen independent reviewer input. If its source or
scenario evidence informs the judge, place that evidence in tracked plan/input
files rather than relying on the advisory record as validation.

References: [VS Code harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses#_get-a-second-opinion-with-rubber-duck),
[Copilot Rubber Duck](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/rubber-duck).
