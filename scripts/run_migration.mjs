#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lockRun, readLock, loadConfig, unsetModels, readManifest, contextHash, unitState, done, safePath, readJSON, verificationFiles, loadReviewDependencies, reviewSources, reviewDependencyPath } from '../lib/core.mjs';
import { strictPhases, phaseRecorded } from '../lib/phases.mjs';
import { validateWorkerProfile, assistedReviewerRoles } from '../lib/review.mjs';
import { runProcess } from '../lib/process.mjs';
import { approve, runStage, translate, runPilot, runJudgePreparation } from '../lib/pipeline.mjs';
import { preparePilot, planPilot } from '../lib/pilot.mjs';
import { createCopilotAdapter, requiredCopilotFlags, copilotEnv, copilotArgs, probeWorkerAgents, probeReviewerHook, probeModelTools, stressBTools, stressBCommand, fileReadTools, fileLimits, fileLimitMinimum } from './copilot_adapter.mjs';
import { runtimeLayout, pluginRoot } from '../lib/runtime.mjs';
import { migrationStatus, statusMarkdown, statusTodo, statusChecklist } from '../lib/status.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { commandProgress, progressLine } from '../lib/command-progress.mjs';
import { failureGuidance, guidanceMarkdown, failureGuidanceList, guidanceListMarkdown, doctorGuidance } from '../lib/guidance.mjs';
import { initSourceSpec, sourceSpecReadiness } from '../lib/source-spec.mjs';
import { runSurvey, mergeSurvey, surveyStatus, planSurvey } from '../lib/survey.mjs';
import { phaseCommand } from './phase_cli.mjs';
import { parseCommandLine, specs } from '../lib/cli.mjs';
import { diagnoseBuild } from './diagnostic_queue.mjs';
import { sessionsStatus, pruneSessions } from '../lib/sessions.mjs';
import { prepareWorkerHome } from '../lib/worker-home.mjs';
import { usageReport, usageMarkdown } from '../lib/usage.mjs';
import { rulebookChanges, acceptRulebook, rulebookMarkdown } from '../lib/rulebook.mjs';
import { buildLoop } from '../lib/build-loop.mjs';
import { readPreferences, setPreferences, preferencesReport } from '../lib/preferences.mjs';
import { autoModeOn } from '../lib/auto-mode.mjs';
import { readGuardrails, cliFolderTrust, guardrailsProposal, installGuardrails } from '../lib/guardrails.mjs';
import { listAvailableModels, modelsMarkdown, setRoleModels, readConfigIfPresent, currentAssignments } from '../lib/models.mjs';
import { initRunSettings, checkRunSettings, applyRunSettings, syncRunSettings, runSettingsFile, runSettingsState, setupEnd, phase00Started } from '../lib/run-settings.mjs';
import { ignoredLimits, processTimeout } from '../lib/execution-policy.mjs';
import { localSandboxProbe, sandboxCheck, sandboxQuestion, sandboxNext } from '../lib/sandbox.mjs';

export const usage = `Usage: node migration-kit/scripts/run_migration.mjs COMMAND [options]
  doctor [--check-cli] [--copilot /path/to/copilot]
  status [--format json|markdown|todo|checklist] [--wait SECONDS] [--fast]
                              --fast shows recorded progress without scanning source files; gates still revalidate
                              Read-only evidence; todo = host task-list items, checklist = chat progress.
                              --wait (1-1800) returns once a running runner makes progress, stops or the time is up
  guidance --message TEXT [--format json|markdown]
                              Explain a failure: cause, impact and choices with a recommendation
  models list [--format json|markdown]
                              The models, reasoning efforts and context tiers your Copilot account offers, and the current choice
  models set --assign ROLE=ID[:EFFORT][:long_context],...
                              Record every role's model, effort and context from one answer (all=ID first, then overrides)
  models set --role ROLE[,ROLE]|reviewers|all --model ID [--effort LEVEL|default] [--context default|long_context]
                              Record one choice; both forms are checked against that list before writing
  preferences [--language ja|en] [--original-runtime available|unavailable] [--phase-mode normal|relaxed|auto] [--specification available|unavailable]
                              Report language; whether the original can still run (guides recommendations)
  settings init [--source LANGUAGE] [--target LANGUAGE] [--source-roots CSV] | check | apply
                              migration/run-settings.json: write it (values only; explanations and your account's models
                              as choices go to migration/run-settings.help.md) with a guess
                              of the source language (init; --source/--target and --source-roots record the answers to its questions),
                              check every entry (check), or check and record it in config.json and preferences.json (apply)
  usage [--format json|markdown] [--run RUN_ID]
                             AI usage of the kit's own worker calls (tokens, AI units), in total, by role and model
  sessions status | prune [--run RUN_ID]
                             Report / delete the local Copilot CLI transcripts of the kit's own workers
  guardrails show | install [--add CSV] [--remove CSV] [--deny CSV] [--waiver NOTE] [--replace]
                             Propose / install migration/guardrails.json (install is a host-confirmed human gate)
  phase init | next | check ID | start ID | complete ID[,ID...] --note TEXT | waive ID --note TEXT
                              Ordered workflow; optional --tokens N --subagents N --model ID.
                              waive (relaxed mode only) proceeds past an unfinished phase with the person's reason
  survey plan|run|status|merge --kind facts|contracts|inventory [--max-files N] [--sites migration/SITES.tsv]
                              Split preparation reading into scopes for fresh tool-free workers; results are files
  survey run --kind inventory --sites migration/SITES.tsv --trial N
                              try N sites per source_construct first; reports the UNKNOWN share per construct, merges nothing
  source-spec init [--apply] | check
                              Source as the only specification: scaffold source-only preparation
  judge                       Runtime: original/mutation; source-only: validate preparation
  judge-prepare               Validate/reuse the judge at 00b before map/rules exist
  rulebook changes [--format json|markdown]
                              After phase 02: how the RULEBOOK differs from the reviewed version and which finished units it may touch
  rulebook accept --note TEXT --redo listed|all|none|PATH,PATH
                              Keep phases, approvals and finished units under the changed RULEBOOK and send back
                              only the chosen units (host-confirmed human gate)
  approve STAGE --note TEXT   Review/approve translation, build, smoke, parity, post-parity, handoff
                              translation may use --batch N or --targets PATH,PATH, and --complete-phase 03
                              to record the reviewed phase 03 in the same confirmation
  translate [--max-calls N]  Run/resume translation with Copilot CLI workers; --max-calls is this run's
                              explicit AI call budget, agreed with the person (normal default: continuous)
  stress-b command --dir DIR [--model ID]
                              Phase 03 comparison B: the exact isolated copilot -p command, with the model's own file tools
  pilot plan --sources src/a,src/b [--through STAGE]
                              Read-only: the files a pilot would cover (chosen + the files they use), to show before asking
  pilot prepare --target NEW_DIR --sources src/a,src/b --note TEXT [--through translation|build|smoke|parity] [--expect-total N]
  pilot run --root PILOT_DIR  Run only the explicitly authorized, isolated pilot
  repair --target PATH --evidence migration/PATH | repair --queue migration/QUEUE.json [--max-calls N]
  diagnose [--stage build|smoke|parity]
                             Parse the current failed run into a TSV and repair queue (default build)
  repair-round [--stage build|smoke|parity]
                             diagnose, then repair the queue; fresh build (and smoke/parity) runs still need approval
  build-loop --note TEXT [--through build|smoke|parity] [--max-rounds N] [--max-calls N]
                             One host-confirmed grant: build (then smoke, then parity with --through), diagnose,
                             repair with reviews and start again from build until clean; finite round/call
                             limits apply only when explicitly chosen or executionMode is bounded
  build | smoke | parity | handoff     Run one approved validation stage and stop
  unlock --pid PID           Remove a lock only after its owning process has stopped
Options: --root PATH (default cwd), --copilot PATH (default copilot)
Configuration: migration/config.json. No command commits or pushes changes.`;
// Comparison B runs outside the repository, in a directory holding only the
// copied source files, so no repository instruction or skill reaches it.
export async function stressB(root, config, { dir, model, command = 'copilot', signal } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('stress-b command needs --dir with an absolute path outside the repository');
  let stat; try { stat = fs.statSync(dir); } catch {}
  if (!stat?.isDirectory()) throw new Error(`stress-b command: ${dir} is not a directory; create it and copy only the selected source files into it first`);
  const inside = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(dir));
  if (!inside || (inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside))) throw new Error(`stress-b command: ${dir} is inside the repository; B must run in a directory outside it`);
  model ??= config.phaseModels?.stressB ?? config.models.implementer;
  if (typeof config.targetLanguage !== 'string' || !config.targetLanguage.trim()) throw new Error('stress-b command needs targetLanguage in migration/config.json');
  const found = await stressBTools(command, model, { signal, timeoutMs: processTimeout(config, 'commandTimeoutSeconds') });
  return { dir, model, tools: found.tools, verified: found.verified, ...(found.verified ? {} : { note: `The CLI's tools for ${model} could not be read here (${found.detail}); the command lists the file tools of every model family the kit knows.` }),
    ...stressBCommand({ command, model, dir, targetLanguage: config.targetLanguage, tools: found.tools }),
    next: 'Run the command for this shell (bash or powershell) in a terminal as it is, then check that B wrote its files. Do not run B as a subagent of this chat.' };
}
// Each tool-assisted reviewer's model must get a reading and a search tool
// under the kit's flags, and comparison B's model a writing tool. A CLI that
// makes no loopback request here leaves it unverified, never failed.
export async function modelToolChecks(root, config, layout, { command, signal, timeoutMs }) {
  const checks = [];
  for (const role of assistedReviewerRoles) {
    const base = role.replace(/-read$/, ''), model = config.models?.[base];
    if (typeof model !== 'string' || unsetModels(config).includes(base)) continue;
    const probe = await probeModelTools(command, copilotArgs(role, model, undefined, layout), { cwd: root, model, env: copilotEnv(role), signal, timeoutMs });
    // Unverified, never failed; a stalled probe means the next ones would stall too.
    if (!probe.ok && stalled({ message: probe.detail })) { checks.push({ check: `model tools: ${role}`, ok: true, status: 'not-verified', stalled: true, model, detail: doctorStallDetail(`model tools: ${role}`, timeoutMs), warning: doctorStallDetail(`model tools: ${role}`, timeoutMs) }); return checks; }
    if (!probe.ok) { checks.push({ check: `model tools: ${role}`, ok: true, status: 'not-verified', model, detail: probe.detail }); continue; }
    const missing = [['view'], ['grep', 'rg']].filter(any => !any.some(name => probe.tools.includes(name))).map(any => any.join('|'));
    checks.push({ check: `model tools: ${role}`, ok: missing.length === 0, model, tools: probe.tools.filter(name => fileReadTools.includes(name)), ...(missing.length ? { missing } : {}) });
  }
  const model = config.phaseModels?.stressB ?? config.models?.implementer;
  if (typeof model === 'string' && !unsetModels(config).includes('implementer')) {
    try {
      const found = await stressBTools(command, model, { signal, timeoutMs });
      checks.push({ check: 'model tools: comparison B', ok: true, model, tools: found.tools, ...(found.verified ? {} : { status: 'not-verified', ...(stalled({ message: found.detail }) ? { stalled: true, detail: doctorStallDetail('model tools: comparison B', timeoutMs), warning: doctorStallDetail('model tools: comparison B', timeoutMs) } : { detail: found.detail }) }) });
    } catch (e) { if (signal?.aborted) throw e; checks.push({ check: 'model tools: comparison B', ok: false, model, detail: e.message }); }
  }
  return checks;
}
// Doctor is a short readiness check, not migration work, so each process it
// starts has a deadline even in continuous mode: a CLI held by a proxy that
// never answers kept doctor --check-cli "still running" for over an hour
// (2026-10-30). A probe past it is reported with its stage and likely causes,
// and doctor finishes. An explicit bounded commandTimeoutSeconds can only
// shorten it (a long build deadline must not bring the endless wait back).
export const doctorProbeSeconds = 180;
export const doctorTimeout = config => Math.min(processTimeout(config, 'commandTimeoutSeconds') || Infinity, doctorProbeSeconds * 1000);
const stalled = e => /^Process timed out after /.test(e?.message ?? '');
export const doctorStallDetail = (stage, ms) => `Doctor check "${stage}" did not finish within ${Number((ms / 1000).toFixed(1))} s. The Copilot CLI got no answer in time: a proxy that does not respond (HTTPS_PROXY / HTTP_PROXY), a sign-in waiting for input, or a blocked network can hold it. Nothing was changed.`;
export async function doctor(root, config, { checkCLI = false, command = 'copilot', signal, sandboxProbe = localSandboxProbe, probeTimeoutMs } = {}) {
  if (signal?.aborted) throw new Error('Interrupted');
  const timeoutMs = probeTimeoutMs ?? doctorTimeout(config);
  const checks = [{ check: 'configuration', ok: true }];
  const ignored = ignoredLimits(config);
  checks.push({ check: 'execution limits', ok: true, executionMode: config.executionMode ?? 'continuous', ...(ignored.length ? { ignored,
    note: `Continuous mode does not enforce ${ignored.join(', ')}. Set "executionMode": "bounded" to enforce them, or delete them; per-command --max-calls / --max-rounds still apply.` } : {}) });
  const unset = unsetModels(config);
  checks.push(unset.length ? { check: 'worker models chosen', ok: false, missing: unset, note: 'Choose them with models list and models set; the other checks run without them.' } : { check: 'worker models chosen', ok: true });
  const layout = runtimeLayout(root, config);
  for (const role of ['orchestrator', 'implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer', 'surveyor', 'preparation-auditor', ...assistedReviewerRoles]) {
    const p = layout.agentPath(role), file = safePath(layout.root, p);
    checks.push({ check: p, ok: fs.existsSync(file) });
    if (role !== 'orchestrator' && fs.existsSync(file)) {
      try { validateWorkerProfile(root, role, config); checks.push({ check: `${role}: model and tools`, ok: true }); }
      catch (e) { checks.push({ check: `${role}: model and tools`, ok: false, detail: e.message }); }
    }
  }
  try { checks.push({ check: 'verification input files', ok: true, files: verificationFiles(root, config), note: 'Add transitive build scripts, nested dependency/config files and environment descriptions to verificationInputs. This list is not an automatic dependency graph.' }); }
  catch (e) { checks.push({ check: 'verification input files', ok: false, detail: e.message }); }
  try {
    const graph = loadReviewDependencies(root, config);
    const units = fs.existsSync(safePath(root, 'migration/manifest.tsv')) ? readManifest(root, config) : [];
    checks.push({ check: 'review dependency map', ok: true, units: units.map(u => ({ source: u.source, files: reviewSources(root, config, u.source, graph) })), note: 'Declared evidence scope; audit parser coverage and semantic dependencies in phase 01.' });
  } catch (e) {
    // Phase 01 creates and audits the declaration. Until phase 01 is recorded a
    // missing file is the normal state of a new project, not a failed check.
    let pending = false;
    try { pending = !fs.existsSync(safePath(root, reviewDependencyPath(config))) && strictPhases(root, config) && !phaseRecorded(root, '01'); } catch {}
    checks.push(pending ? { check: 'review dependency map', ok: true, status: 'pending', note: 'Created and audited in phase 01; not needed before then.' }
      : { check: 'review dependency map', ok: false, detail: e.message });
  }
  checks.push({ check: 'build artifact roots', ok: true, roots: config.buildArtifactRoots ?? [], note: 'Declare generated binaries, objects and reports here. Their file contents are excluded from command-input fingerprints; actual inputs must stay outside these roots.' });
  checks.push({ check: 'worker hook installed', ok: fs.existsSync(safePath(layout.root, layout.hookPath)) });
  // Copilot hooks fail open on timeout: a slow start silently disables the
  // guardrails. Run the exact command from the hook configuration twice: as a
  // worker (must deny a shell call) and as an interactive session (the slower
  // guardrail path, which reads migration/guardrails.json).
  {
    let entry = null, limit = null;
    try {
      const spec = JSON.parse(fs.readFileSync(safePath(layout.root, layout.hookPath), 'utf8')).hooks;
      entry = (spec.preToolUse ?? spec.PreToolUse)?.[0] ?? null;
      limit = entry?.timeoutSec ?? entry?.timeout ?? null;
    } catch {}
    const line = entry && (entry.bash ?? entry.command);
    const argv = typeof line === 'string' ? [...line.replaceAll('${PLUGIN_ROOT}', layout.root).matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]) : [];
    const probe = async (role, command) => {
      const started = Date.now();
      const r = await runProcess(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd: root,
        input: JSON.stringify({ toolName: 'bash', toolArgs: { command }, cwd: root }),
        signal, timeoutMs, env: { ...process.env, ...(role ? { MIGRATION_KIT_ROLE: role } : {}) } }).catch(e => {
          if (signal?.aborted) throw new Error('Interrupted');
          return { code: null, stdout: '', stderr: e.message };
        });
      let decision = null; try { decision = JSON.parse(r.stdout); } catch {}
      return { ms: Date.now() - started, code: r.code, decision };
    };
    const worker = argv.length ? await probe('implementer', 'true') : null;
    const parent = argv.length ? await probe(null, 'git status') : null;
    const slowest = Math.max(worker?.ms ?? 0, parent?.ms ?? 0);
    checks.push({ check: 'hook responds before its timeout', ok: Boolean(worker && parent) && worker.code === 0 && parent.code === 0 &&
        worker.decision?.permissionDecision === 'deny' && worker.decision?.hookSpecificOutput?.permissionDecision === 'deny' &&
        parent.decision !== null && (limit === null || slowest < limit * 500),
      command: line ?? null, durationMs: slowest, timeoutSec: limit,
      note: 'Runs the configured hook command. Copilot CLI and VS Code let a tool call through when a hook times out; keep the measured time well under half the configured timeout.' });
  }
  let guardrails = null, guardrailError;
  try { guardrails = readGuardrails(root); } catch (e) { guardrailError = e.message; }
  checks.push({ check: 'command guardrails', ok: !guardrailError,
    status: guardrailError ? 'invalid' : !guardrails ? 'not installed' : guardrails.denyCommands.length ? 'installed' : guardrails.waiver ? 'waived' : 'empty',
    ...(guardrailError ? { detail: guardrailError } : {}), note: 'Phases 03/04 require migration/guardrails.json, copied by the human from templates/guardrails.json (or a recorded waiver).' });
  if (!layout.plugin) {
    // Repository hooks (worker backstop and guardrails) load only in a trusted folder.
    const trust = cliFolderTrust(root);
    // The hook also asks before approvals and denies guardrails edits, so an
    // untrusted folder disables protections even before guardrails exist.
    checks.push({ check: 'repository hooks load in Copilot CLI', ok: trust !== 'untrusted', status: trust,
      note: 'Interactive Copilot CLI sessions ignore .github/hooks in untrusted folders, silently disabling the guardrails, the approval confirmations and the guardrails-file protection. Start copilot interactively in this repository once and trust the folder. Runner-started tool-assisted reviewers always load the repository hooks (GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true), so they stay out of other workers\' records either way; other workers follow folder trust and rely on their CLI tool flags.' });
  }
  // A local sandbox blocks phase 03 (work outside the repository) and the
  // loopback reviewer-hook check below; say so here instead of at phase 03.
  const sandbox = await sandboxProbe();
  if (signal?.aborted) throw new Error('Interrupted');
  checks.push(sandboxCheck(sandbox));
  if (checkCLI) {
    let stage = 'Copilot CLI --version';
    try {
      // Same environment as workers: a launcher may pick a different build otherwise.
      let home = null, homeError;
      try { home = prepareWorkerHome(root, config); } catch (e) { homeError = e.message; }
      checks.push({ check: 'worker Copilot CLI home', ok: true, status: home ? 'separate' : homeError ? 'shared: the worker home could not be prepared' : 'shared',
        ...(home ? { path: home } : {}), ...(homeError ? { warning: `Workers will use the person's Copilot CLI home: ${homeError}` } : {}),
        note: 'Workers run in a Copilot CLI home of their own (workerCopilotHome), with the person\'s settings and sign-in but not their session records. A local sandbox must let workers write there as well as to ~/.copilot.' });
      const env = copilotEnv('reviewer-rules', home);
      const version = await runProcess(command, ['--version'], { cwd: root, env, signal, timeoutMs });
      checks.push({ check: 'Copilot executable', ok: version.code === 0, detail: version.stdout.trim() });
      stage = 'Copilot CLI --help';
      const help = await runProcess(command, ['--help'], { cwd: root, env, signal, timeoutMs });
      const text = help.stdout + help.stderr;
      const advertised = new Set(text.match(/(?<![\w-])--?[A-Za-z][A-Za-z0-9-]*/g) ?? []);
      const missing = requiredCopilotFlags(layout, config).filter(flag => !advertised.has(flag));
      checks.push({ check: 'required flags', ok: help.code === 0 && missing.length === 0, missing });
      stage = 'worker agents resolve';
      const agents = await probeWorkerAgents(command, [], { cwd: root, layout, signal, timeoutMs, home });
      checks.push({ check: 'worker agents resolve', ...agents });
      let hookStalled = false;
      if (agents.ok) {
        stage = 'tool-assisted reviewer hook loads in prompt mode';
        const hook = await probeReviewerHook(command, [], { cwd: root, layout, signal, timeoutMs });
        hookStalled = !hook.ok && stalled({ message: hook.detail });
        if (hookStalled) Object.assign(hook, { stalled: true, detail: doctorStallDetail(stage, timeoutMs) });
        // Refused loopback fails this check for the sandbox's reason, not the CLI's.
        const loopback = !hook.ok && sandbox.blocked.some(b => b.access === 'loopback');
        checks.push({ check: 'tool-assisted reviewer hook loads in prompt mode', ...hook,
          ...(loopback ? { cause: 'local-sandbox', detail: `Loopback is blocked in this session (see "${sandboxCheck(sandbox).check}"), so this check cannot run; it says nothing about the CLI. ${hook.detail ?? ''}`.trim() } : {}),
          note: 'Live check with a loopback model provider: no account, network or AI usage. It proves the hook keeps tool-assisted reviewers out of migration/runs.' });
      }
      // The model-tool probes use the same loopback provider: a stalled hook probe means they would stall too.
      if (agents.ok && !hookStalled) checks.push(...await modelToolChecks(root, config, layout, { command, signal, timeoutMs }));
    } catch (e) {
      if (signal?.aborted) throw new Error('Interrupted');
      // A stalled CLI would stall the later probes too: report the stage and stop here.
      checks.push(stalled(e) ? { check: 'Copilot CLI answers', ok: false, stalled: true, stage, detail: doctorStallDetail(stage, timeoutMs) }
        : { check: 'Copilot executable', ok: false, detail: e.message });
    }
    // Not a CLI call: it runs even after a stalled CLI probe.
    checks.push({ check: 'file descriptor limit', ...await fileLimits({ signal, timeoutMs }), minimum: fileLimitMinimum,
      note: 'Each CLI process raises its soft open-file limit to the hard limit by itself. A hard limit below the minimum is a warning: workers may hit EMFILE "Too many open files", which stops the run with guidance.' });
  }
  const staticValid = checks.every(x => x.ok !== false);
  // Passing checks can still carry a warning the person should hear.
  const warnings = checks.filter(x => typeof x.warning === 'string').map(x => `${x.check}: ${x.warning}`);
  return { ok: staticValid, staticValid, executionReady: 'not-verified', checks, ...(warnings.length ? { warnings } : {}), workerBackend: 'copilot-cli', requestedModels: config.models, requestedEfforts: config.reasoningEfforts ?? {}, requestedContextTiers: config.contextTiers ?? {}, requestedPhaseModels: config.phaseModels ?? {},
    note: 'Help checks do not authenticate, verify model availability, exercise hooks, or make AI calls. Run the live smoke procedure before production use.' };
}
// A long translate or build-loop runs in a background terminal. Each status
// poll by the parent agent is a model turn over its whole conversation, so the
// runner waits here instead and answers once something changed.
const progressKey = report => JSON.stringify([report.ok, report.running, report.lock?.runId, report.done, report.total,
  report.units?.filter(u => u.status === 'blocked').length, report.buildLoop && [report.buildLoop.stage, report.buildLoop.rounds, report.buildLoop.agentCalls],
  report.survey && [report.survey.runId, report.survey.done, report.survey.activeScopes, report.survey.agentCalls, report.survey.parts, report.survey.state]]);
export async function waitForProgress(root, seconds, { intervalMs = 5000, fast = false } = {}) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error('--wait must be a number of seconds from 1 to 1800');
  const deadline = Date.now() + seconds * 1000;
  const read = fast ? statusSnapshot : migrationStatus;
  let report = read(root);
  const start = progressKey(report);
  while ((report.running || report.buildLoop) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    report = read(root);
    if (progressKey(report) !== start) break;
  }
  return report;
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseCommandLine(argv, specs.run_migration), cmd = args._[0];
  // Agents probe `COMMAND --help` before acting; answer with the usage, never run the command.
  if (!cmd || cmd === 'help' || args.help) { console.log(usage); return; }
  const root = fs.realpathSync(path.resolve(args.root ?? '.'));
  if (cmd === 'unlock') {
    // Run and build-loop locks, and the recovery claim of either, are cleared
    // the same way when their owner (reused PID or another host) blocks them.
    const files = ['migration/run.lock', 'migration/build-loop.lock'].flatMap(p => { const f = safePath(root, p); return [f, `${f}.recover`]; });
    const pid = Number(args.pid), target = files.find(f => readLock(f)?.pid === pid);
    if (!Number.isInteger(pid) || pid < 1 || !target) {
      if (files.every(f => readLock(f) === undefined)) { console.log('No migration lock to remove'); return; }
      throw new Error('Specify the exact lock owner PID');
    }
    const lock = readLock(target);
    // A PID from another host (shared folder) says nothing about this host's
    // processes; the person confirmed that run stopped by naming its PID.
    let alive = !lock.host || lock.host === os.hostname();
    if (alive) try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
    if (alive) throw new Error('Lock owner is still running; refusing to unlock');
    // Remove it only if no other command took it in the meantime.
    if (JSON.stringify(readLock(target)) === JSON.stringify(lock)) fs.rmSync(target, { force: true });
    console.log(`Removed stale ${target.endsWith('.recover') ? 'lock recovery claim' : 'lock'}: migration/${path.basename(target)}`); return;
  }
  if (cmd === 'preferences') {
    const setting = args.language || args['original-runtime'] || args['phase-mode'] || args.specification;
    // In effect, not just chosen: a hand-edited auto (no record) chosen properly
    // now is a new choice and hands over.
    const wasAuto = setting ? autoModeOn(root) : false;
    const result = setting ? setPreferences(root, { language: args.language, originalRuntime: args['original-runtime'], phaseMode: args['phase-mode'], specification: args.specification }) : preferencesReport(root);
    if (setting) {
      const report = {};
      const synced = syncRunSettings(root, { keys: [...(args.language ? ['reportLanguage'] : []), ...(args['original-runtime'] ? ['originalRuntime'] : []), ...(args['phase-mode'] ? ['phaseMode'] : [])], report });
      if (synced) result.runSettings = `${synced} updated to match`;
      if (report.verificationMode) result.verificationMode = 'The original does not run, so verificationMode in the run settings file is now source-only (runtime verification runs the original). Tell the person.';
      if (report.verificationModeKept) result.verificationMode = 'The original runs, but verificationMode in the run settings file is source-only. Ask the person whether to verify by running the original (runtime); on yes, set verificationMode to runtime in the file and run settings apply.';
      // Auto chosen after setup was applied but before phase 00: the handoff
      // to autopilot comes now, since no later apply would show it.
      if (args['phase-mode'] === 'auto' && !wasAuto && !phase00Started(root)) {
        let config = null;
        try { config = loadConfig(root, { requireModels: false }); } catch {}
        if (config && runSettingsState(root, config)?.state === 'applied') Object.assign(result, setupEnd(root, config));
      }
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  let language = 'en';
  try { language = readPreferences(root).userLanguage ?? 'en'; } catch {}
  if (cmd === 'models') {
    // The person picks; the list is their account's, read live from the CLI.
    if (!['list', 'set'].includes(args._[1])) throw new Error('Use models list [--format json|markdown] | models set --assign ROLE=ID[:EFFORT][:long_context],... | models set --role ROLE --model ID [--effort LEVEL|default] [--context default|long_context]');
    if (args.format !== undefined && !['json', 'markdown'].includes(args.format)) throw new Error('models list format must be json or markdown');
    const models = await listAvailableModels({ command: args.copilot ?? 'copilot', cwd: root });
    if (args._[1] === 'set') {
      if (!readConfigIfPresent(root)) throw new Error('migration/config.json is missing: initialize the project (install.mjs) before recording model choices');
      const release = lockRun(root, 'models-set');
      try {
        const result = setRoleModels(root, models, { role: args.role, model: args.model, effort: args.effort, context: args.context, assign: args.assign });
        const synced = syncRunSettings(root, { roles: result.updated });
        console.log(JSON.stringify(synced ? { ...result, runSettings: `${synced} updated to match` } : result, null, 2));
      } finally { release(); }
      return;
    }
    const config = readConfigIfPresent(root);
    console.log(args.format === 'markdown' ? modelsMarkdown(models, config, language)
      : JSON.stringify({ models, ...(config ? { assignments: currentAssignments(config) } : {}) }, null, 2));
    return;
  }
  if (cmd === 'settings') {
    // One file instead of one question per setting; every entry is checked
    // before anything is written, and every problem is reported at once.
    const action = args._[1];
    if (!readConfigIfPresent(root)) throw new Error('migration/config.json is missing: initialize the project (install.mjs) before run settings');
    // A file that cannot be read still gets written (init) or checked (the
    // other fields); the model entries then report why.
    let models;
    try { models = await listAvailableModels({ command: args.copilot ?? 'copilot', cwd: root }); } catch (e) { models = e.message; }
    if (action === 'init') { console.log(JSON.stringify(initRunSettings(root, models, { source: args.source, target: args.target, sourceRoots: args['source-roots'] }), null, 2)); return; }
    if (action === 'check') {
      const file = safePath(root, runSettingsFile);
      if (!fs.existsSync(file)) throw new Error(`${runSettingsFile} is missing: run settings init first`);
      let settings;
      try { settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { throw new Error(`${runSettingsFile} is not valid JSON: ${e.message}`); }
      const { errors } = checkRunSettings(root, settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}, models);
      if (errors.length) process.exitCode = 1;
      console.log(JSON.stringify({ ok: !errors.length, file: runSettingsFile, errors }, null, 2));
      return;
    }
    if (action !== 'apply') throw new Error('Use settings init | check | apply');
    const release = lockRun(root, 'settings-apply');
    try {
      const result = applyRunSettings(root, models);
      if (!result.applied) process.exitCode = 1;
      // Asked during setup (on each apply while it fails), before phase 00 and
      // the autopilot handoff.
      if (result.applied && !phase00Started(root)) {
        const probe = await localSandboxProbe();
        if (!probe.ok) Object.assign(result, { sandbox: sandboxCheck(probe), sandboxQuestion: sandboxQuestion(probe, readPreferences(root).userLanguage === 'ja' ? 'ja' : 'en'),
          next: result.next ? `${sandboxNext} Then: ${result.next}` : sandboxNext });
      }
      console.log(JSON.stringify(result, null, 2));
    } finally { release(); }
    return;
  }
  if (cmd === 'status') {
    if (args.format && !['json', 'markdown', 'todo', 'checklist'].includes(args.format)) throw new Error('status format must be json, markdown, todo or checklist');
    const report = args.wait === undefined ? (args.fast ? statusSnapshot(root) : migrationStatus(root)) : await waitForProgress(root, Number(args.wait), { fast: args.fast });
    if (!report.ok) process.exitCode = 1;
    // Problems that need the person's decision: blocked units and unreadable state.
    const problems = !report.ok ? [{ targets: [report.blockers[0]?.path].filter(Boolean), guidance: failureGuidance(report.blockers[0]?.reason ?? 'status failed', { root, language }) }]
      : report.units.some(u => u.status === 'blocked' && u.reason) ? failureGuidanceList(`Translation stopped: ${report.units.filter(u => u.status === 'blocked' && u.reason).map(u => `${u.target}: ${u.reason}`).join('; ')}`, { root, language }) : [];
    const actions = problems.length ? `\n\n${guidanceListMarkdown(problems, language)}` : '';
    console.log(args.format === 'markdown' ? `${statusChecklist(report, language)}\n\n${statusMarkdown(report, language)}${actions}`
      : args.format === 'checklist' ? statusChecklist(report, language)
      : args.format === 'todo' ? JSON.stringify(statusTodo(report, language), null, 2) : JSON.stringify(report, null, 2));
    return;
  }
  if (cmd === 'usage') {
    if (args.format && !['json', 'markdown'].includes(args.format)) throw new Error('usage format must be json or markdown');
    const report = usageReport(root, { runId: args.run });
    console.log(args.format === 'markdown' ? usageMarkdown(report, language) : JSON.stringify(report, null, 2));
    return;
  }
  if (cmd === 'rulebook') {
    // changes is read-only; accept is a human gate (the hook asks the person).
    if (args.format && !['json', 'markdown'].includes(args.format)) throw new Error('rulebook format must be json or markdown');
    const config = loadConfig(root);
    const result = args._[1] === 'changes' ? rulebookChanges(root, config)
      : args._[1] === 'accept' ? acceptRulebook(root, config, { note: args.note, redo: args.redo })
      : (() => { throw new Error('Use rulebook changes [--format json|markdown] | accept --note TEXT --redo listed|all|none|PATH,PATH'); })();
    console.log(args.format === 'markdown' ? rulebookMarkdown(result) : JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === 'guidance') {
    if (typeof args.message !== 'string' || !args.message.trim()) throw new Error('guidance requires --message TEXT (the error to explain)');
    const g = failureGuidance(args.message, { root, language, explain: true });
    console.log(args.format === 'json' ? JSON.stringify(g, null, 2) : guidanceMarkdown(g, language));
    return;
  }
  const config = loadConfig(root, { requireModels: cmd !== 'doctor' }), controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    let result;
    if (cmd === 'stress-b') {
      if (args._[1] !== 'command') throw new Error('Use stress-b command --dir DIR [--model ID]');
      result = await stressB(root, config, { dir: args.dir, model: args.model, command: args.copilot, signal: controller.signal });
    }
    else if (cmd === 'pilot' && args._[1] === 'plan') result = planPilot(root, config, { sources: args.sources?.split(','), through: args.through });
    else if (cmd === 'pilot' && args._[1] === 'prepare') result = preparePilot(root, config, { target: args.target, sources: args.sources?.split(','), through: args.through, note: args.note, expectTotal: args['expect-total'] });
    else if (cmd === 'pilot' && args._[1] === 'run') {
      result = await runPilot(root, config, createCopilotAdapter({ command: args.copilot }), { signal: controller.signal, onProgress: event => console.error(progressLine(event)) });
    }
    else if (cmd === 'diagnose') result = diagnoseBuild(root, config, { stage: args.stage });
    else if (cmd === 'repair-round') {
      const diagnosis = diagnoseBuild(root, config, { stage: args.stage });
      if (diagnosis.clean) result = { ...diagnosis, next: `${diagnosis.stage} is clean; review it and approve the next stage.` };
      else {
        const repair = await translate(root, config, createCopilotAdapter({ command: args.copilot }), {
          signal: controller.signal, repairQueue: diagnosis.queue,
          onProgress: event => console.error(progressLine(event)) });
        result = { diagnosis, repair, next: `Review the repaired outputs and the round counts in ${diagnosis.rounds}, then approve and run build${diagnosis.stage === 'build' ? '' : `, smoke${diagnosis.stage === 'parity' ? ' and parity' : ''}`} for the next round.` };
      }
    }
    else if (cmd === 'source-spec' && args._[1] === 'init') {
      const release = lockRun(root, 'source-spec-init');
      try {
        result = initSourceSpec(root, config, { apply: args.apply });
        // The switch writes verificationMode to config.json; the run settings
        // file follows, so a later settings apply does not write runtime back.
        if (result.applied && result.changes.some(c => c.path === 'migration/config.json')) {
          const synced = syncRunSettings(root, { keys: ['verificationMode'] });
          if (synced) result.runSettings = `${synced} updated to match`;
          // Switched during setup: phase 00 comes first, and auto mode stops here for autopilot.
          if (!phase00Started(root)) {
            result.next = 'The source-as-spec profile is set as part of setup. Phase 00 comes first; the drafts listed in readiness are phase 00b-02 work.';
            // Setup ends here only once the run settings are applied; before
            // that, setup goes on and settings apply ends it.
            if (runSettingsState(root, config)?.state === 'applied') Object.assign(result, setupEnd(root, config));
            else result.next = 'The source-as-spec profile is set as part of setup, which is not finished: run settings init and follow its next (settings apply ends setup). Phase 00 comes after it.';
          }
        }
      } finally { release(); }
    }
    else if (cmd === 'source-spec' && args._[1] === 'check') result = sourceSpecReadiness(root, config);
    else if (cmd === 'source-spec') throw new Error('Use source-spec init [--apply] | check');
    else if (cmd === 'survey') {
      // Delegated preparation surveys: scopes go to fresh tool-free surveyor workers.
      const kind = args.kind, options = { maxFiles: args['max-files'] === undefined ? undefined : Number(args['max-files']), sitesFile: args.sites,
        ...(args.trial !== undefined ? { trial: Number(args.trial) } : {}) };
      const action = args._[1];
      if (action === 'plan') result = planSurvey(root, config, kind, options);
      else if (action === 'status') result = surveyStatus(root, config, kind, options);
      // The inventory merge takes the run lock itself; a second lock here
      // made every inventory merge fail on its own lock.
      else if (action === 'merge') { const release = kind === 'inventory' ? () => {} : lockRun(root, 'survey-merge'); try { result = mergeSurvey(root, config, kind, options); } finally { release(); } }
      else if (action === 'run') {
        result = await runSurvey(root, config, kind, createCopilotAdapter({ command: args.copilot }), { signal: controller.signal, ...options,
          onProgress: event => console.error(progressLine(event)) });
      } else throw new Error('Use survey plan|run|status|merge --kind facts|contracts|inventory [--max-files N] [--sites migration/PATH.tsv]');
    }
    else if (cmd === 'judge-prepare') result = await runJudgePreparation(root, config, { signal: controller.signal });
    else if (cmd === 'phase') result = phaseCommand(root,config,args._[1],args._[2],args);
    else if (cmd === 'build-loop') {
      // One host-confirmed grant for build (→ smoke → parity) → diagnose → reviewed repairs → rebuild rounds.
      const maxRounds = args['max-rounds'] === undefined ? undefined : Number(args['max-rounds']);
      const maxCalls = args['max-calls'] === undefined ? undefined : Number(args['max-calls']);
      result = await buildLoop(root, config, createCopilotAdapter({ command: args.copilot }), { maxRounds, maxCalls, through: args.through ?? 'build', note: args.note, signal: controller.signal,
        onProgress: event => console.error(progressLine(event)) });
    }
    else if (cmd === 'sessions') {
      if (args._[1] === 'status') result = sessionsStatus(root, { run: args.run });
      else if (args._[1] === 'prune') result = pruneSessions(root, { run: args.run });
      else throw new Error('Use sessions status | prune [--run RUN_ID]');
    }
    else if (cmd === 'guardrails') {
      if (args._[1] === 'show') result = guardrailsProposal(root, pluginRoot, config);
      else if (args._[1] === 'install') {
        // A human gate: the hook makes the host ask the person to confirm this command.
        const release = lockRun(root, 'guardrails-install');
        try { result = installGuardrails(root, pluginRoot, { deny: args.deny, add: args.add, remove: args.remove, waiver: args.waiver, replace: args.replace }); } finally { release(); }
      } else throw new Error('Use guardrails show | install [--add CSV] [--remove CSV] [--deny CSV] [--waiver NOTE] [--replace]');
    }
    else if (cmd === 'doctor') {
      result = await doctor(root, config, { checkCLI: args['check-cli'], command: args.copilot, signal: controller.signal });
      if (!result.ok) {
        process.exitCode = 1;
        // Failed checks are results, not exceptions: explain them the same way.
        const list = doctorGuidance(result, { root, language });
        if (list.length) console.error(guidanceListMarkdown(list, language));
      }
    }
    else if (cmd === 'approve') {
      const scope = { batch: args.batch, targets: args.targets?.split(',') };
      if (args['complete-phase'] === undefined) result = approve(root, config, args._[1], args.note, scope);
      else {
        // The 03 review and the translation approval are one human decision: record both under one confirmation.
        if (args._[1] !== 'translation' || args['complete-phase'] !== '03') throw new Error('--complete-phase applies only as approve translation --complete-phase 03');
        const phase = phaseCommand(root, config, 'complete', '03', { note: args.note });
        result = { phase, approval: approve(root, config, 'translation', args.note, scope) };
      }
    }
    else if (['judge', 'build', 'smoke', 'parity', 'handoff'].includes(cmd)) result = await runStage(root, config, cmd, { signal: controller.signal });
    else if (['translate', 'repair'].includes(cmd)) {
      if (cmd === 'repair' && !args.target && !args.queue) throw new Error('repair requires --target or --queue');
      result = await translate(root, config, createCopilotAdapter({ command: args.copilot }), {
        signal: controller.signal, onlyTarget: cmd === 'repair' ? args.target : undefined, repairQueue: cmd === 'repair' ? args.queue : undefined, evidence: args.evidence,
        maxCalls: args['max-calls'] === undefined ? undefined : Number(args['max-calls']),
        onProgress: event => console.error(progressLine(event)) });
    } else throw new Error(`Unknown command ${cmd}\n${usage}`);
    console.log(JSON.stringify(result, null, 2));
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  // Every command that hashes inputs or waits on workers says it is alive, so a
  // host does not take a long synchronous check for a hung process.
  const announced = ['status', 'survey', 'models', 'settings', 'doctor', 'translate', 'repair', 'repair-round', 'build-loop', 'pilot', 'judge-prepare', 'judge', 'build', 'smoke', 'parity', 'handoff'].includes(argv[0]) || (argv[0] === 'phase' && argv[1] === 'next');
  const progress = !argv.includes('--help') && (announced || ['phase', 'approve', 'diagnose', 'source-spec'].includes(argv[0]));
  (progress ? commandProgress(argv.slice(0, argv[0] === 'phase' ? 2 : 1).join(' '), () => main(), { announce: announced }) : main()).catch(e => {
    console.error(`ERROR: ${e.message}`);
    // Every failure ends with its cause and the user's choices (docs/PHASE-HANDOFF.md).
    try {
      // Read --root alone: a command-line error must still get its guidance.
      const argv = process.argv.slice(2), at = argv.indexOf('--root');
      const root = fs.realpathSync(path.resolve(at >= 0 && argv[at + 1] ? argv[at + 1] : '.'));
      let language = 'en';
      try { language = readPreferences(root).userLanguage ?? 'en'; } catch {}
      console.error(`\n${guidanceListMarkdown(failureGuidanceList(e, { root, language }), language)}`);
    } catch {}
    process.exitCode = 1;
  });
}
