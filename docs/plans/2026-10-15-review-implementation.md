# Review 1/2 implementation, 2026-10-15

Base: feat/github-copilot-migration-kit at
81b4aad2d93547afc6e6ee25b752e3f70f5ffb3c. GPT-6 Astra independently checked the
integrated review before implementation. Upstream stays pinned to
cf91c9d5068d9aaf95a36164169f08c3e636c909. Git history identifies the published
revision of this implementation and its follow-up fixes.

| Unit | Review IDs | Implemented change | Acceptance evidence / limit |
|---|---|---|---|
| P01 | I-02 | Five plugin profiles' ten documentation paths | Plugin and installed-copy path test |
| P02 | I-01/I-14 | Explicit isolated pilot grant and shared pipeline | Strict pre-03 trial through parity, stale/revoked/cancelled grants, no production done |
| P03 | I-09/I-13/I-15 | Static doctor vs unknown host capabilities; requested/observed models separated | Doctor regression; no host metadata bridge claimed |
| P04 | I-03 | Early comparator receipt independent of maps/rules; explicit later reuse | Real fixture original/mutation commands, stale judge revocation |
| P05–07 | I-04–06/I-13 | Exact audit prompts, tool-free prep profile, frozen task/result bindings, two-way map diff/sample, deterministic census/shard merge | Mechanical/fixed-response regressions; actual independent AI audits still host work |
| P08 | I-12 | Optional target-package graph input/audit; fixed design body | Clean file DAG producing package cycle; design changes invalidate done |
| P09 | I-07 | Six macro stages, exact translation batch scopes and status | Batch stop/resume and full-manifest downstream refusal; fresh build approval retained |
| P10 | I-08 | One-lock diagnostic queue, unique-target parallel repair | Independent slices overlap within cap, stale queue/build rejected, fresh build after join |
| P11 foundation | I-11 | Architecture template and protected designInputs bodies | Standard translate still rejects redesign; module runner remains future implementation |
| P12 | I-15 | Current-scope/pilot status, honest model/cost documentation | Runtime/source-only outcomes remain distinct; parent/advice costs not invented |
| P13 | Review-2 J01 | Explicit marker policy, measured evidence and new optional Node check | Deliberate missed mismatch cannot become done; legacy conventions preserved |

The code retains fixed original/RULEBOOK/inventory/judge protection, coordinator
writes, two mutually blind translation reviewers, confirmed-finding fixes and
fresh review, global lock/caps, interruption/resumption and stale native submission
checks. Fixture reviews and pass responses are not authenticated AI quality or
human signoff. Upstream comparator reviewers use disjoint assertion batches;
inventory reviewers use the same batch. The marker hard gate is a new optional
enhancement; upstream's TODO count procedure was not a Node-enforced gate.

## Remaining implementation units and host verification

Astra follow-up review found three defects in the initial uncommitted change:
F1 undispatched queue jobs lost on resume; F2 fixed inventory receipt overwrote a
configured design input; F3 bare --copilot examples lacked a required value.
The follow-up implementation durably admits all jobs before dispatch, binds both
reviews to the immutable intent, blocks old completion/downstream approval, checks
fixed receipt destinations before writing, and corrects both command examples.
The inventory prompt now explicitly treats disjoint sampling as supplementary to
the required two reviews of the same batch (C1). Dedicated regressions cover
dependent, independent and pre-dispatch Stop, old receipt restoration, archive
tampering, protected-input aliases and actual copied-script CLI argument parsing.

| Unit | Dependencies | Recommended implementation | Acceptance / pending environment |
|---|---|---|---|
| Native bridge I-09/10 | Actual documented host metadata/events | Formal host adapter binding task/tool-call/child to requested selector, resolved ID, display/vendor and observed execution model; capability preflight, handles, completion events and dual cancel | Live VS Code/Copilot, auth and installed schema required. A short A, long B and A-dependent C must submit A/start C before B where supported; fallback and late Stop results rejected. Local group-wait limits reported. |
| Module adapter I-11/12 | Reviewed architecture, exclusive owners | Minimal subsystem manifest with finite outputs, staging, whole-generation reviews, journaled publication/recovery; no bakeoff | Multi-source/multi-output stop cannot produce partial done/shared writers; external parity. No universal language adapter promised. |
| Build round grant option I-07/08 | Queue, approval-design review | If wanted, bounded compile-only round authorization tied to scope/build snapshot; never starts smoke/parity | Strict fresh-approval policy already works and remains the default; no new automatic round policy implemented. |
| Live preparation I-04–06/14 | Explicit models and independent host dispatch | Deliberately weak assertions, missed/invented edges, rule-row contradictions and instruction leakage challenges | No Copilot/VS Code executable or authenticated host in this environment; run actual workers with frozen requests and archive evidence. |

No official-main observation proves the installed host's behavior. Documented
host schemas/metadata must be checked before adapter work; guessing task arguments
or accepting self-reported model strings is insufficient. Doctor intentionally
leaves native execution readiness unknown and exits nonzero; a protocol dry run
alone cannot establish capabilities. See NATIVE-WORKERS.md for the live checklist.

Validation after the Astra fixes: `npm test` passed 170/170, with zero failures/skips/cancellations;
`npm run demo` completed 3 reviewed units, build, smoke and 12 parity scenarios.
Node v24.19.0 / Python 3.12.14 on Linux. Nineteen initial and seven Astra follow-up
regression cases cover the changes above; live setup also uses strict/default count policy without a
synthetic phase-03 report or approval. Worker replies are fixed test responses;
Node/Python fixture commands execute for real. No authenticated Copilot, VS Code
UI, large migration or redesign result is claimed. See [testing](../TESTING.md).
