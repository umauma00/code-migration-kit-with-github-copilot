# Migration architecture contract

Use this as an explicitly reviewed design document for redesign. Register its
actual path in config.designInputs so every tool-free reviewer receives the full
body and it is hashed/protected. A link in RULEBOOK is insufficient. The standard
file runner still rejects redesign; this document does not enable a module runner.

## Scope and behavior

- Public API/CLI/wire contracts to preserve; source and scenario evidence.
- Explicit permitted behavior changes, authorized owner and acceptance cases.
- Nonfunctional constraints: performance, deployment, durability and security.

## Modules and ownership

| New subsystem | Source functions/features | Public contract | State/data owner | Output owner |
|---|---|---|---|---|
| [name] | [complete mapping] | [inputs/results/errors] | [single owner] | [exclusive target paths] |

Account for every old feature. State dependency directions and prohibit or justify
cycles. Name shared type/helper owners and their versioned contracts. One output
has one writer; no subsystem silently writes another subsystem's shared files.

## Integration and evidence

Record target package mapping, initialization order, state migration, error and
numeric/Unicode semantics, build/smoke/parity scenarios, unknowns and stop criteria.
Independent design auditors cite contract contradictions and concrete failing
examples. Redesign uses disposable subsystem trials and external parity instead
of a file A/B bakeoff. Record the limits of a small trial versus a full migration.

## Module execution design (required before implementation)

Define source-set to output-set manifest, prerequisite graph, fixed review inputs,
bounded multi-output responses, stage location and a publication journal. Review
all outputs as one candidate bound to the design/snapshot. Publish only a fully
reviewed generation, with recovery/rollback on stop; mark the subsystem done only
after all outputs match the receipt. Shared files must have an exclusive owner.
The current runner supplies none of these module-publication guarantees.
