#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, readManifest, contextHash, unitState, done, safePath, readJSON, parseArgs, verificationFiles, loadReviewDependencies, reviewSources } from '../lib/core.mjs';
import { validateWorkerProfile, validateNativeProfile, assistedReviewerRoles } from '../lib/review.mjs';
import { runProcess } from '../lib/process.mjs';
import { approve, runStage, translate, runPilot, runJudgePreparation } from '../lib/pipeline.mjs';
import { preparePilot } from '../lib/pilot.mjs';
import { createCopilotAdapter, requiredCopilotFlags, copilotEnv, probeWorkerAgents } from './copilot_adapter.mjs';
import { runtimeLayout } from '../lib/runtime.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { createNativeAdapter } from '../lib/native-workers.mjs';
import { phaseCommand } from './phase_cli.mjs';
import { diagnoseBuild } from './diagnostic_queue.mjs';
import { readGuardrails, cliFolderTrust } from '../lib/guardrails.mjs';

export const usage = `Usage: node migration-kit/scripts/run_migration.mjs COMMAND [options]
  doctor [--check-cli] [--copilot /path/to/copilot]
  status [--format json|markdown]  Read-only preparation and execution evidence
  phase init | next | check ID | start ID | complete ID --note TEXT
                              Ordered workflow; optional --tokens N --subagents N --model ID
  judge                       Runtime: original/mutation; source-only: validate preparation
  judge-prepare               Validate/reuse the judge at 00b before map/rules exist
  approve STAGE --note TEXT   Review/approve translation, build, smoke, parity, post-parity, handoff
                              translation may use --batch N or --targets PATH,PATH
  translate                  Run/resume using config.workerBackend (copilot-cli or native)
  pilot prepare --target NEW_DIR --sources src/a,src/b --note TEXT [--through translation|build|smoke|parity]
  pilot run --root PILOT_DIR  Run only the explicitly authorized, isolated pilot
  repair --target PATH --evidence migration/PATH | repair --queue migration/QUEUE.json
  diagnose                   Parse the current failed build into a TSV and repair queue
  repair-round               diagnose, then repair the queue; a fresh build still needs approval
  build | smoke | parity | handoff     Run one approved validation stage and stop
  unlock --pid PID           Remove a lock only after its owning process has stopped
Options: --root PATH (default cwd), --copilot PATH (default copilot)
Configuration: migration/config.json. No command commits or pushes changes.`;
export async function doctor(root, config, { checkCLI = false, command = 'copilot' } = {}) {
  const checks = [{ check: 'configuration', ok: true }];
  const layout = runtimeLayout(root, config);
  const native = config.workerBackend === 'native';
  for (const role of ['orchestrator', 'implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer', ...(native ? [] : assistedReviewerRoles)]) {
    const p = native && role !== 'orchestrator' ? layout.nativeAgentPath(role) : layout.agentPath(role), file = safePath(layout.root, p);
    checks.push({ check: p, ok: fs.existsSync(file) });
    if (role !== 'orchestrator' && fs.existsSync(file)) {
      try { (native ? validateNativeProfile : validateWorkerProfile)(root, role, config); checks.push({ check: `${role}: model and tools`, ok: true }); }
      catch (e) { checks.push({ check: `${role}: model and tools`, ok: false, detail: e.message }); }
    }
  }
  try { checks.push({ check: 'verification input files', ok: true, files: verificationFiles(root, config), note: 'Add transitive build scripts, nested dependency/config files and environment descriptions to verificationInputs. This list is not an automatic dependency graph.' }); }
  catch (e) { checks.push({ check: 'verification input files', ok: false, detail: e.message }); }
  try {
    const graph = loadReviewDependencies(root, config);
    const units = fs.existsSync(safePath(root, 'migration/manifest.tsv')) ? readManifest(root, config) : [];
    checks.push({ check: 'review dependency map', ok: true, units: units.map(u => ({ source: u.source, files: reviewSources(root, config, u.source, graph) })), note: 'Declared evidence scope; audit parser coverage and semantic dependencies in phase 01.' });
  } catch (e) { checks.push({ check: 'review dependency map', ok: false, detail: e.message }); }
  checks.push({ check: 'build artifact roots', ok: true, roots: config.buildArtifactRoots ?? [], note: 'Declare generated binaries, objects and reports here. Their file contents are excluded from command-input fingerprints; actual inputs must stay outside these roots.' });
  if (!native) checks.push({ check: 'worker hook installed', ok: fs.existsSync(safePath(layout.root, layout.hookPath)) });
  let guardrails = null, guardrailError;
  try { guardrails = readGuardrails(root); } catch (e) { guardrailError = e.message; }
  checks.push({ check: 'command guardrails', ok: !guardrailError,
    status: guardrailError ? 'invalid' : !guardrails ? 'not installed' : guardrails.denyCommands.length ? 'installed' : guardrails.waiver ? 'waived' : 'empty',
    ...(guardrailError ? { detail: guardrailError } : {}), note: 'Phases 03/04 require migration/guardrails.json, copied by the human from templates/guardrails.json (or a recorded waiver).' });
  if (!native && !layout.plugin) {
    // Repository hooks (worker backstop and guardrails) load only in a trusted folder.
    const trust = cliFolderTrust(root);
    checks.push({ check: 'repository hooks load in Copilot CLI', ok: !(trust === 'untrusted' && guardrails?.denyCommands.length), status: trust,
      note: 'Copilot CLI ignores .github/hooks in untrusted folders, silently disabling the guardrails. Start copilot interactively in this repository once and trust the folder.' });
  }
  if (native) checks.push({ check: 'native host capabilities', ok: null, status: 'unknown', experimental: true, harness: config.nativeHarness,
    capabilities: Object.fromEntries(['modelSelection', 'modelExecutionEvidence', 'toolRestrictions', 'instructionIsolation', 'parallelDispatch', 'completionEvents', 'childCancellation'].map(name => [name, 'unknown'])),
    note: 'EXPERIMENTAL: VS Code does not return the executed subagent model to the parent, so jobs cannot be submitted under the native contract; use the copilot-cli backend for real migrations. Static profiles do not verify this host. Before native execution, verify per-call model selection, execution-bound model metadata, tools, dispatch and cancellation on the installed host. Do not echo requested models or silently fall back to CLI.' });
  if (checkCLI && !native) {
    try {
      // Same environment as workers: a launcher may pick a different build otherwise.
      const env = copilotEnv('reviewer-rules');
      const version = await runProcess(command, ['--version'], { cwd: root, timeoutMs: 20000, env });
      const help = await runProcess(command, ['--help'], { cwd: root, timeoutMs: 20000, env });
      const text = help.stdout + help.stderr;
      checks.push({ check: 'Copilot executable', ok: version.code === 0, detail: version.stdout.trim() });
      const advertised = new Set(text.match(/(?<![\w-])--?[A-Za-z][A-Za-z0-9-]*/g) ?? []);
      const missing = requiredCopilotFlags(layout).filter(flag => !advertised.has(flag));
      checks.push({ check: 'required flags', ok: help.code === 0 && missing.length === 0, missing });
      const agents = await probeWorkerAgents(command, [], { cwd: root, layout });
      checks.push({ check: 'worker agents resolve', ...agents });
    } catch (e) { checks.push({ check: 'Copilot executable', ok: false, detail: e.message }); }
  }
  const staticValid = checks.every(x => x.ok !== false);
  return { ok: staticValid && !native, staticValid, executionReady: native ? 'unknown' : 'not-verified', checks, workerBackend: config.workerBackend ?? 'copilot-cli', requestedModels: config.models, requestedPhaseModels: config.phaseModels ?? {},
    note: 'Help checks do not authenticate, verify model availability, exercise hooks, or make AI calls. Run the live smoke procedure before production use.' };
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), cmd = args._[0];
  if (!cmd || cmd === 'help') { console.log(usage); return; }
  const root = fs.realpathSync(path.resolve(args.root ?? '.'));
  if (cmd === 'unlock') {
    const file = safePath(root, 'migration/run.lock'), lock = readJSON(file), pid = Number(args.pid);
    if (!Number.isInteger(pid) || pid < 1 || lock.pid !== pid) throw new Error('Specify the exact lock owner PID');
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
    if (alive) throw new Error('Lock owner is still running; refusing to unlock');
    fs.unlinkSync(file); console.log('Removed stale migration lock'); return;
  }
  if (cmd === 'status') {
    if (args.format && !['json', 'markdown'].includes(args.format)) throw new Error('status format must be json or markdown');
    const report = migrationStatus(root);
    if (!report.ok) process.exitCode = 1;
    console.log(args.format === 'markdown' ? statusMarkdown(report) : JSON.stringify(report, null, 2));
    return;
  }
  const config = loadConfig(root), controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    let result;
    if (cmd === 'pilot' && args._[1] === 'prepare') result = preparePilot(root, config, { target: args.target, sources: args.sources?.split(','), through: args.through, note: args.note });
    else if (cmd === 'pilot' && args._[1] === 'run') {
      if (config.workerBackend === 'native' && args.copilot) throw new Error('--copilot cannot be used with a native pilot');
      result = await runPilot(root, config, config.workerBackend === 'native' ? createNativeAdapter() : createCopilotAdapter({ command: args.copilot }), { signal: controller.signal, onProgress: event => console.error(`${event.unit}: ${event.stage}`) });
    }
    else if (cmd === 'diagnose') result = diagnoseBuild(root, config);
    else if (cmd === 'repair-round') {
      const diagnosis = diagnoseBuild(root, config);
      if (diagnosis.clean) result = { ...diagnosis, next: 'Build is clean; review it and approve smoke.' };
      else {
        const native = config.workerBackend === 'native';
        if (native && args.copilot) throw new Error('--copilot cannot be used with workerBackend: native');
        const repair = await translate(root, config, native ? createNativeAdapter() : createCopilotAdapter({ command: args.copilot }), {
          signal: controller.signal, repairQueue: diagnosis.queue,
          onProgress: event => console.error(`${event.unit}: ${event.stage} (agent calls ${event.calls})`) });
        result = { diagnosis, repair, next: 'Review the repaired outputs and the round counts in migration/build-rounds.tsv, then approve build and run build for the next round.' };
      }
    }
    else if (cmd === 'judge-prepare') result = await runJudgePreparation(root, config, { signal: controller.signal });
    else if (cmd === 'phase') result = phaseCommand(root,config,args._[1],args._[2],args);
    else if (cmd === 'doctor') { result = await doctor(root, config, { checkCLI: args['check-cli'], command: args.copilot }); if (!result.ok) process.exitCode = 1; }
    else if (cmd === 'approve') result = approve(root, config, args._[1], args.note, { batch: args.batch, targets: args.targets?.split(',') });
    else if (['judge', 'build', 'smoke', 'parity', 'handoff'].includes(cmd)) result = await runStage(root, config, cmd, { signal: controller.signal });
    else if (['translate', 'repair'].includes(cmd)) {
      if (cmd === 'repair' && !args.target && !args.queue) throw new Error('repair requires --target or --queue');
      const native = config.workerBackend === 'native';
      if (native && args.copilot) throw new Error('--copilot cannot be used with workerBackend: native');
      if (native) console.error('Native workers: keep this runner active; use native_workers.mjs list/claim/submit from the host session. No Copilot CLI is launched.');
      result = await translate(root, config, native ? createNativeAdapter() : createCopilotAdapter({ command: args.copilot }), {
        signal: controller.signal, onlyTarget: cmd === 'repair' ? args.target : undefined, repairQueue: cmd === 'repair' ? args.queue : undefined, evidence: args.evidence,
        onProgress: event => console.error(`${event.unit}: ${event.stage} (agent calls ${event.calls})`) });
    } else throw new Error(`Unknown command ${cmd}\n${usage}`);
    console.log(JSON.stringify(result, null, 2));
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
}
