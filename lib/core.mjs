// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readUtf8 } from './text.mjs';
import { runtimeLayout } from './runtime.mjs';
import { markerEvidence } from './markers.mjs';

export const roles = ['implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer'];
// Preparation surveys are high-volume like implementation: they ride the
// implementer model unless phaseModels.survey names one explicitly.
export const workerModel = (config, role) => role === 'surveyor' ? (config.phaseModels?.survey ?? config.models.implementer) : config.models[role];
// Reasoning effort per worker, chosen by the person from their model list
// (lib/models.mjs). Surveyors default to the implementer's, like their model.
export const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const effortRoles = [...roles, 'surveyor'];
export const workerEffort = (config, role) => config.reasoningEfforts?.[role] ?? (role === 'surveyor' ? config.reasoningEfforts?.implementer : undefined);
export function validateEfforts(config) {
  if (config.reasoningEfforts === undefined) return;
  const value = config.reasoningEfforts;
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('reasoningEfforts must map worker roles to effort levels');
  for (const [role, level] of Object.entries(value)) {
    if (!effortRoles.includes(role)) throw new Error(`reasoningEfforts.${role} is not a worker role (${effortRoles.join(', ')})`);
    if (!effortLevels.includes(level)) throw new Error(`reasoningEfforts.${role} must be one of ${effortLevels.join(', ')}`);
  }
}
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const stamp = () => new Date().toISOString();
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function relativeName(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f]/.test(value) ||
      path.posix.isAbsolute(value) || value.split('/').some(x => !x || x === '.' || x === '..')) {
    throw new Error(`Expected a normalized repository-relative path: ${JSON.stringify(value)}`);
  }
  return value;
}
export function safePath(root, name) {
  relativeName(name);
  let current = fs.realpathSync(root);
  const parts = name.split('/');
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    if (fs.existsSync(current) ? fs.lstatSync(current).isSymbolicLink() : isLink(current)) {
      throw new Error(`Symlinks are not supported in migration paths: ${name}`);
    }
    if (i < parts.length - 1 && fs.existsSync(current) && !fs.statSync(current).isDirectory()) {
      throw new Error(`Parent is not a directory: ${name}`);
    }
  }
  return current;
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { if(e.code === 'ENOENT') return false; throw e; } }
export const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`);
const metadataRoots = ['.git', '.github', '.claude', '.copilot', 'migration', 'migration-kit'];
const outputProtectedPaths = config => [...metadataRoots, ...config.sourceRoots, ...config.verificationRoots, ...(config.verificationInputs ?? []), ...(config.designInputs ?? [])];
function pathLocation(file) {
  const ancestors = [];
  for (let current = file;; current = path.dirname(current)) {
    if (fs.existsSync(current)) ancestors.push({ file: current, real: fs.realpathSync(current), stat: fs.statSync(current, { bigint: true }) });
    if (path.dirname(current) === current) break;
  }
  const parent = ancestors[0];
  // Resolve the existing parent even when the eventual output does not exist.
  return { resolved: path.resolve(parent.real, path.relative(parent.file, file)),
    stat: parent.file === file ? parent.stat : null, ancestors };
}
const sameFile = (a, b) => a && b && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
function pathsOverlap(root, left, right) {
  if (inside(left, right) || inside(right, left)) return true;
  const a = pathLocation(safePath(root, left)), b = pathLocation(safePath(root, right));
  const within = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);
  // realpath may preserve an alias's spelling, so compare file identities too.
  return within(a.resolved, b.resolved) || within(b.resolved, a.resolved) ||
    b.ancestors.some(parent => sameFile(a.stat, parent.stat)) || a.ancestors.some(parent => sameFile(b.stat, parent.stat));
}
export function assertOutputPath(root, config, target, source) {
  const full = safePath(root, target);
  if (!config.outputRoots.some(dir => inside(target, dir))) throw new Error(`Target outside outputRoots: ${target}`);
  for (const protectedPath of [...outputProtectedPaths(config), ...(source ? [source] : [])]) {
    if (pathsOverlap(root, target, protectedPath)) throw new Error(`Output target overlaps protected path: ${target} (${protectedPath})`);
  }
  return full;
}
// Report producers cannot turn an --out option into an input/receipt writer.
export function assertReportPath(root, config, target) {
  if (!target.startsWith('migration/')) throw new Error('Reports must be under migration/');
  const protectedPaths = [...config.sourceRoots, ...config.outputRoots, ...config.verificationRoots, ...verificationFiles(root, config),
    reviewDependencyPath(config), ...(config.packageMap ? [config.packageMap] : []),
    'migration/config.json', 'migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv',
    'migration/feasibility.md', 'migration/judge-report.md', 'migration/gap-report.md', 'migration/depmap/report.md', 'migration/stress-test/report.md',
    'migration/judge-plan.json', 'migration/pilot.json', 'migration/pilots', 'migration/audits', ...generatedMigrationState];
  for (const input of protectedPaths) if (pathsOverlap(root, target, input)) throw new Error(`Report output overlaps protected input or receipt: ${target}`);
  return safePath(root, target);
}
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function writeJSON(file, object) { atomicWrite(file, `${JSON.stringify(object, null, 2)}\n`); }
export function fileHash(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? hash(fs.readFileSync(file)) : null;
}
export function filesUnder(root, directory) {
  const out = [];
  const visit = name => {
    const full = safePath(root, name);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isFile()) { out.push(name); return; }
    if (!stat.isDirectory()) throw new Error(`Unsupported path: ${name}`);
    for (const entry of fs.readdirSync(full).sort()) {
      if (['.git', 'node_modules', '__pycache__'].includes(entry)) continue;
      visit(`${name}/${entry}`);
    }
  };
  visit(directory);
  return out;
}
export function treeHash(root, directories) {
  return hash(JSON.stringify([...new Set(directories.flatMap(d => filesUnder(root, d)))].sort()
    .map(p => [p, fileHash(safePath(root, p))])));
}
// Convenience defaults, not a dependency resolver. Declare project-specific
// transitive build inputs in verificationInputs as well.
const buildFile = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-(lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|deno\.(jsonc?|lock)|tsconfig(?:\.[^.]+)*\.json|pyproject\.toml|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|setup\.(py|cfg)|tox\.ini|Cargo\.(toml|lock)|go\.(mod|sum)|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|gradle\.properties|gradlew(?:\.bat)?|Makefile|makefile|CMakeLists\.txt|global\.json|NuGet\.config|Directory\.(Build\.(props|targets)|Packages\.props)|.*\.(sln|csproj|fsproj)|\.nvmrc|\.node-version|\.python-version|\.tool-versions)$/;
const generatedMigrationState = ['migration/state', 'migration/results', 'migration/gates', 'migration/runs', 'migration/run.lock', 'migration/phases', 'migration/cost-log.tsv'];
const generatedPreparationReceipts = ['migration/inventory-merge.json'];
function inlineProgramArguments(argv) {
  const executable = path.posix.basename(argv[0].replaceAll('\\', '/')).replace(/\.exe$/i, '').toLowerCase();
  const node = /^(node|nodejs)$/.test(executable), python = /^(python|pypy)(\d+(\.\d+)*)?$/.test(executable);
  const shell = /^(sh|bash|dash|zsh|ksh)$/.test(executable);
  const options = node ? ['-e', '--eval', '-p', '--print'] : python || shell ? ['-c'] : [];
  // Only interpreter options before its entrypoint have inline-program meaning.
  // File options such as cc/node's -c are not treated as inline programs.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' || !arg.startsWith('-')) break;
    if (options.includes(arg) || (shell && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))) return new Set([i + 1]);
    if (node && ['--eval', '--print'].some(option => arg.startsWith(`${option}=`))) return new Set([i]);
    if ((node && ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions'].includes(arg)) ||
        (python && ['-W', '-X'].includes(arg))) i++;
  }
  return new Set();
}
export function verificationFiles(root, config) {
  const inputs = new Set();
  for (const name of [...(config.verificationInputs ?? []), ...(config.designInputs ?? [])]) {
    const full = safePath(root, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`verificationInputs file missing: ${name}`);
    inputs.add(name);
  }
  for (const name of fs.readdirSync(root)) {
    if (buildFile.test(name) && fs.statSync(safePath(root, name)).isFile()) inputs.add(name);
  }
  for (const argv of Object.values(config.commands ?? {})) {
    if (!argv) continue;
    const inlinePrograms = inlineProgramArguments(argv);
    for (const [index, raw] of argv.entries()) {
      if (inlinePrograms.has(index)) continue;
      let value = raw;
      if (value.includes('{target}')) continue;
      if (value.startsWith('--') && value.includes('=')) value = value.slice(value.indexOf('=') + 1);
      if (value.startsWith('-')) continue;
      const name = path.relative(root, path.resolve(root, value)).split(path.sep).join('/');
      if (!name || name.startsWith('../') || config.outputRoots.some(r => inside(name, r))) continue;
      if (inside(name, '.git')) continue;
      // State/results are rewritten by the runner. Treating them as command
      // inputs would either miss changes or make validation invalidate itself.
      if ([...generatedMigrationState, ...generatedPreparationReceipts].some(r => inside(name, r))) throw new Error(`Configured command path overlaps generated migration state: ${name}; move command scripts and inputs outside runtime state directories`);
      // Generated binaries, reports and objects are declared by the project. An
      // unknown tool's -o/--output option is not assumed to mean an output path.
      if ((config.buildArtifactRoots ?? []).some(r => inside(name, r))) continue;
      try { relativeName(name); } catch { continue; }
      let full;
      try { full = safePath(root, name); } catch (e) { if (e.code === 'ENAMETOOLONG') continue; throw e; }
      if (fs.existsSync(full) && fs.statSync(full).isFile()) inputs.add(name);
    }
  }
  return [...inputs].sort();
}
// Upstream fans a whole batch out at once; the coordinator may instead hold a
// dependent unit until its translated dependencies have reviewed receipts.
// auto (new installs): wait only when a per-unit typecheck needs those targets.
// Unset keeps the earlier behavior of always waiting.
export function waitsForDependencies(config) {
  const order = config.dependencyOrder ?? 'reviewed';
  return order === 'reviewed' || (order === 'auto' && Boolean(config.commands?.typecheck));
}
// rereview (default): a fixed output is reviewed again until no confirmed
// finding remains. single-pass (upstream): implement, two reviews, arbitration,
// one fix of the confirmed findings, then the build/test referees take over.
export const fixPolicy = config => config.fixPolicy ?? 'rereview';
// Workers always run as Copilot CLI processes, from VS Code chat as well as from
// the CLI. The VS Code subagent ("native") backend was removed in 0.3.0.
const removedNativeKeys = ['nativeHarness', 'nativeModelVerification', 'nativeInput'];
export function loadConfig(root) {
  const config = readJSON(safePath(root, 'migration/config.json'));
  runtimeLayout(root, config);
  if (config.verificationMode !== undefined && !['runtime', 'source-only'].includes(config.verificationMode)) throw new Error('verificationMode must be runtime or source-only');
  if (config.phasePolicy !== undefined && !['strict', 'legacy'].includes(config.phasePolicy)) throw new Error('phasePolicy must be strict or legacy');
  if (config.preparationProfile !== undefined && !['standard', 'source-as-spec'].includes(config.preparationProfile)) throw new Error('preparationProfile must be standard or source-as-spec');
  if (config.preparationProfile === 'source-as-spec' && config.verificationMode !== 'source-only') throw new Error('preparationProfile source-as-spec requires verificationMode source-only');
  if (config.markerPolicy !== undefined && config.markerPolicy !== 'todo-lines-v1') throw new Error('markerPolicy must be todo-lines-v1, or omitted for an existing project convention');
  if (config.executionPurpose !== undefined && !['production', 'pilot'].includes(config.executionPurpose)) throw new Error('executionPurpose must be production or pilot');
  if (config.phaseModels !== undefined) {
    const names = ['rulebook', 'judgeAudit', 'dependencyAudit', 'inventoryAudit', 'stressA', 'stressB', 'stressInspector', 'designAudit', 'survey'];
    if (!config.phaseModels || Array.isArray(config.phaseModels) || typeof config.phaseModels !== 'object' || Object.entries(config.phaseModels).some(([role, model]) => !names.includes(role) || typeof model !== 'string' || !model.trim() || /SELECT_MODEL|[<>]/.test(model))) throw new Error('phaseModels must explicitly map supported preparation roles to available host model selectors');
  }
  if (config.packageMap !== undefined && (typeof config.packageMap !== 'string' || !config.packageMap.startsWith('migration/') || config.packageMap.startsWith('migration/depmap/package-cycles.json'))) throw new Error('packageMap must name a source-to-target-package input under migration/');
  if (config.packageMap) safePath(root, config.packageMap);
  if (config.packageMap && [...generatedMigrationState, 'migration/audits', 'migration/pilots', 'migration/pilot.json',
    'migration/diagnostics', 'migration/repair-queue.json', 'migration/inventory-merge.json'].some(r => pathsOverlap(root, config.packageMap, r))) throw new Error('packageMap must be a fixed input outside generated receipts and reports');
  if (config.schemaVersion !== 1) throw new Error('Unsupported config schemaVersion');
  if ((config.workerBackend !== undefined && config.workerBackend !== 'copilot-cli') || removedNativeKeys.some(k => Object.hasOwn(config, k))) throw new Error(`The VS Code subagent (native) worker backend was removed: workers always run as Copilot CLI processes, also from VS Code chat. In migration/config.json set "workerBackend": "copilot-cli" and delete ${removedNativeKeys.join(', ')}; the changed configuration needs a fresh judge and translation approval`);
  if (config.dependencyOrder !== undefined && !['auto', 'reviewed', 'none'].includes(config.dependencyOrder)) throw new Error('dependencyOrder must be auto, reviewed or none');
  if (config.dependencyOrder === 'none' && config.commands?.typecheck) throw new Error('dependencyOrder none cannot be combined with a per-unit typecheck, which needs translated dependencies; use auto or reviewed');
  if (config.fixPolicy !== undefined && !['rereview', 'single-pass'].includes(config.fixPolicy)) throw new Error('fixPolicy must be rereview or single-pass');
  if (config.reviewFocus !== undefined && !['shared', 'specialized'].includes(config.reviewFocus)) throw new Error('reviewFocus must be shared or specialized');
  for (const field of ['sourceLanguage', 'targetLanguage']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`${field} is required`);
  }
  if (!['preserve', 'redesign'].includes(config.mode)) throw new Error('mode must be preserve or redesign');
  for (const key of ['sourceRoots', 'outputRoots', 'verificationRoots']) {
    if (!Array.isArray(config[key]) || !config[key].length) throw new Error(`${key} must be a nonempty array`);
    config[key].forEach(p => safePath(root, p));
  }
  for (const dir of config.sourceRoots) {
    if (metadataRoots.some(r => pathsOverlap(root, dir, r))) throw new Error(`Source root overlaps migration metadata: ${dir}`);
  }
  if (config.verificationInputs !== undefined && !Array.isArray(config.verificationInputs)) throw new Error('verificationInputs must be an array of file paths');
  if (config.designInputs !== undefined && !Array.isArray(config.designInputs)) throw new Error('designInputs must be an array of complete design-document paths');
  for (const name of [...(config.verificationInputs ?? []), ...(config.designInputs ?? [])]) {
    safePath(root, name);
    if (['.git', ...generatedMigrationState, ...generatedPreparationReceipts, ...config.outputRoots].some(r => pathsOverlap(root, name, r))) throw new Error(`verificationInputs/designInputs overlaps outputs or runtime state: ${name}`);
  }
  if (config.maxReviewInputBytes !== undefined && (!Number.isInteger(config.maxReviewInputBytes) || config.maxReviewInputBytes < 1024 || config.maxReviewInputBytes > 4 * 1024 * 1024)) throw new Error('maxReviewInputBytes must be between 1024 and 4194304');
  const dependencyPath = reviewDependencyPath(config);
  safePath(root, dependencyPath);
  if (!inside(dependencyPath, 'migration') || [...generatedMigrationState, ...generatedPreparationReceipts].some(r => pathsOverlap(root, dependencyPath, r))) throw new Error('reviewDependencyMap must be a file under migration outside generated runtime state');
  for (const out of config.outputRoots) {
    for (const reserved of outputProtectedPaths(config)) {
      if (pathsOverlap(root, out, reserved)) throw new Error(`Output root overlaps protected path: ${out}`);
    }
  }
  if (config.buildArtifactRoots !== undefined && !Array.isArray(config.buildArtifactRoots)) throw new Error('buildArtifactRoots must be an array of directory paths');
  for (const dir of config.buildArtifactRoots ?? []) {
    relativeName(dir);
    const protectedPaths = [...metadataRoots,
      ...config.sourceRoots, ...config.outputRoots, ...config.verificationRoots, ...(config.verificationInputs ?? []), ...(config.designInputs ?? [])];
    // Report protected descendants before resolving a parent that may be a file.
    if (buildFile.test(dir.split('/')[0]) || protectedPaths.some(p => inside(dir, p) || inside(p, dir)) ||
        protectedPaths.some(p => pathsOverlap(root, dir, p))) throw new Error(`buildArtifactRoots overlaps protected input/output or metadata: ${dir}`);
    const full = safePath(root, dir);
    if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) throw new Error(`buildArtifactRoots must name directories: ${dir}`);
  }
  for (const [key, min, max] of [['concurrency', 1, 64], ['maxFixRounds', 0, 10], ['maxAgentCalls', 1, 10000], ['timeoutSeconds', 1, 86400], ['commandTimeoutSeconds', 1, 86400]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  // Optional resilience settings for parallel runs (defaults: 2 retries from 5 s, stop after 3 failures in a row).
  for (const [key, min, max] of [['transientRetries', 0, 10], ['transientRetryDelayMs', 0, 600000], ['maxConsecutiveFailures', 1, 1000]]) {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)) throw new Error(`Invalid ${key}`);
  }
  // AI Credits are metered on tokens and usage stops when credits run out, so a
  // run can also stop at a measurable prompt-size budget (bytes sent to workers).
  if (config.maxRunInputBytes !== undefined && (!Number.isInteger(config.maxRunInputBytes) || config.maxRunInputBytes < 1024)) throw new Error('maxRunInputBytes must be an integer of at least 1024');
  // Passed to every worker as --max-ai-credits, a per-call cap the CLI checks.
  // The CLI refuses to start below 30 ("Use at least 30 AI credits", 1.0.98).
  if (config.maxAiCreditsPerCall !== undefined && !(typeof config.maxAiCreditsPerCall === 'number' && Number.isFinite(config.maxAiCreditsPerCall) && config.maxAiCreditsPerCall >= 30)) throw new Error('maxAiCreditsPerCall must be a number of at least 30 (the Copilot CLI minimum for --max-ai-credits)');
  for (const r of roles) {
    if (typeof config.models?.[r] !== 'string' || !config.models[r].trim() || /SELECT_MODEL|[<>]/.test(config.models[r])) {
      throw new Error(`Set an available model ID for models.${r}`);
    }
  }
  validateEfforts(config);
  for (const [key, command] of Object.entries(config.commands ?? {})) {
    if (command !== null && (!Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string' || x.includes('\0')) || !command[0])) {
      throw new Error(`commands.${key} must be null or an argv array`);
    }
  }
  return config;
}
export function readManifest(root, config, manifest = 'migration/manifest.tsv') {
  const lines = fs.readFileSync(safePath(root, manifest), 'utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (lines.shift() !== 'source\ttarget') throw new Error('Manifest header must be source<TAB>target');
  const sources = new Set(), targets = new Set();
  const units = lines.filter(Boolean).map(line => {
    const parts = line.split('\t');
    if (parts.length !== 2) throw new Error(`Malformed manifest row: ${line}`);
    const [source, target] = parts;
    for (const p of parts) safePath(root, p);
    if (!config.sourceRoots.some(r => inside(source, r))) throw new Error(`Source outside sourceRoots: ${source}`);
    if (!fs.existsSync(safePath(root, source)) || !fs.statSync(safePath(root, source)).isFile()) throw new Error(`Missing source: ${source}`);
    assertOutputPath(root, config, target, source);
    if (sources.has(source.toLowerCase()) || targets.has(target.toLowerCase())) throw new Error(`Duplicate manifest mapping: ${line}`);
    sources.add(source.toLowerCase()); targets.add(target.toLowerCase());
    return { source, target, id: hash(`${source}\0${target}`).slice(0, 24) };
  });
  for (const target of targets) {
    const parts = target.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (targets.has(parts.join('/'))) throw new Error('Manifest target is also a parent of another target');
    }
  }
  return units;
}
export const reviewDependencyPath = config => config.reviewDependencyMap ?? 'migration/review-dependencies.json';
export function loadReviewDependencies(root, config) {
  const name = reviewDependencyPath(config), file = safePath(root, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Required review dependency map missing: ${name}; generate and audit it in phase 01`);
  const map = JSON.parse(readUtf8(file, name));
  const graph = map?.dependencies;
  if (map?.schemaVersion !== 1 || !graph || Array.isArray(graph) || typeof graph !== 'object') throw new Error('Review dependency map requires schemaVersion: 1 and dependencies object');
  const check = p => {
    const full = safePath(root, p);
    if (!config.sourceRoots.some(r => inside(p, r))) throw new Error(`Review dependency outside sourceRoots: ${p}`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`Review dependency file missing: ${p}`);
  };
  for (const [source, deps] of Object.entries(graph)) {
    check(source);
    if (!Array.isArray(deps) || new Set(deps).size !== deps.length) throw new Error(`Review dependencies must be a unique array: ${source}`);
    deps.forEach(check);
  }
  return graph;
}
export function reviewSources(root, config, source, graph = loadReviewDependencies(root, config)) {
  const seen = new Set(), queue = [source];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    if (!Object.hasOwn(graph, name)) throw new Error(`Review dependency declaration missing: ${name}; explicitly declare [] for audited independent files`);
    seen.add(name); queue.push(...graph[name]);
  }
  return [...seen].sort();
}
// Source-as-spec keeps its source-derived contracts beside the plan; they are
// hashed through the plan like any other scenario file.
export const sourceSpecRoot = 'migration/source-spec';
export const specPlaceholder = 'TODO(spec)';
export function sourceOnlyPlan(root, config) {
  const name = 'migration/judge-plan.json';
  const plan = readJSON(safePath(root, name));
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (plan.schemaVersion !== 1 || plan.verificationMode !== 'source-only' || !text(plan.method) ||
      !Array.isArray(plan.sources) || !plan.sources.length || !Array.isArray(plan.scenarios) || !plan.scenarios.length ||
      !Array.isArray(plan.unverified) || !plan.unverified.length || !plan.unverified.every(text)) {
    throw new Error('Source-only judge plan requires schemaVersion 1, verificationMode source-only, method, nonempty sources, scenarios and unverified limitations');
  }
  const check = (p, roots, kind) => {
    const full = safePath(root, p);
    if (!roots.some(r => inside(p, r)) || [...config.outputRoots, ...generatedMigrationState, ...(config.buildArtifactRoots ?? []), '.git'].some(r => inside(p, r))) throw new Error(`Invalid ${kind} input path: ${p}`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || fs.statSync(full).size === 0) throw new Error(`Missing or empty ${kind} input: ${p}`);
    return p;
  };
  const files = new Set([name]);
  for (const p of plan.sources) files.add(check(p, config.sourceRoots, 'source'));
  for (const scenario of plan.scenarios) {
    if (!scenario || !text(scenario.contract) || scenario.expectationBasis !== 'source-inferred') throw new Error('Source-only scenarios require contract and expectationBasis: source-inferred; do not claim observed original behavior');
    files.add(check(scenario.path, [...config.verificationRoots, ...(config.verificationInputs ?? []), ...(config.preparationProfile === 'source-as-spec' ? [sourceSpecRoot] : [])], 'scenario'));
  }
  return { plan, files: [...files].sort().map(p => [p, fileHash(safePath(root, p))]) };
}
// Run limits and timeouts decide how a run proceeds, not what a reviewed
// output means: changing them between runs (lower concurrency after rate
// limits, a larger call budget) must not revoke reviewed work or gates.
export const operationalConfigKeys = ['concurrency', 'maxAgentCalls', 'maxFixRounds', 'timeoutSeconds', 'commandTimeoutSeconds',
  'transientRetries', 'transientRetryDelayMs', 'maxConsecutiveFailures', 'maxRunInputBytes', 'maxAiCreditsPerCall'];
export const semanticConfig = config => Object.fromEntries(Object.entries(config).filter(([key]) => !operationalConfigKeys.includes(key)));
export function contextHash(root, config) {
  const layout = runtimeLayout(root, config);
  for (const p of ['migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv']) {
    if (!fileHash(safePath(root, p))) throw new Error(`Required artifact missing: ${p}`);
  }
  for (const dir of [...config.sourceRoots, ...config.verificationRoots]) {
    if (!fs.existsSync(safePath(root, dir))) throw new Error(`Input root missing: ${dir}`);
  }
  const graph = loadReviewDependencies(root, config);
  readManifest(root, config).forEach(u => reviewSources(root, config, u.source, graph));
  // The file on disk too: an edit during a run must be seen even though the
  // runner holds the configuration it loaded at the start.
  return hash(JSON.stringify({ config: semanticConfig(config), configFile: semanticConfig(readJSON(safePath(root, 'migration/config.json'))),
    ...(config.verificationMode === 'source-only' ? { sourceOnlyPlan: sourceOnlyPlan(root, config).files } : {}), source: treeHash(root, config.sourceRoots), judge: treeHash(root, config.verificationRoots),
    ...(config.packageMap ? { packageMap: readJSON(safePath(root, config.packageMap)) } : {}),
    reviewDependencies: { map: fileHash(safePath(root, reviewDependencyPath(config))), files: Object.keys(graph).sort().map(p => [p, fileHash(safePath(root, p))]) },
    manifestSources: readManifest(root, config).map(u => [u.source, fileHash(safePath(root, u.source))]),
    verificationInputs: verificationFiles(root, config).map(p => [p, fileHash(safePath(root, p))]),
    artifacts: ['migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv'].map(p => fileHash(safePath(root, p))),
    // Only what reaches workers: runner code, worker profiles and hooks. Workers
    // run with --no-custom-instructions and no skill tool, so documents, phase
    // prompts, skills and Copilot instructions guide the parent, not reviewed outputs.
    runtime: layout.plugin
      ? { plugin: treeHash(layout.root, ['plugin.json', 'package.json', 'com.github.copilot', 'lib', 'scripts', 'templates']),
        project: treeHash(root, ['.github/agents', '.claude/agents', '.github/hooks']) }
      : treeHash(root, ['.github/agents', '.github/hooks', '.github/extensions', 'migration-kit/lib', 'migration-kit/scripts']) }));
}
export const statePath = (root, unit) => safePath(root, `migration/state/units/${unit.id}.json`);
export function unitState(root, unit) {
  const file = statePath(root, unit);
  try { return fs.existsSync(file) ? readJSON(file) : null; }
  catch (e) { if (e instanceof SyntaxError) return null; throw e; }
}
export const repairIntentPath = (root, id) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid repair intent ID');
  return safePath(root, `migration/state/repairs/${id}.json`);
};
export function readRepairReceipt(root, id, checksum) {
  const file = repairIntentPath(root, id);
  if (!checksum || fileHash(file) !== checksum) throw new Error('Repair intent receipt missing or changed; restore its bound evidence before resuming');
  const r = readJSON(file);
  if (r.schemaVersion !== 1 || r.kind !== 'repair-intent' || r.id !== id || typeof r.contextHash !== 'string' ||
      !Array.isArray(r.jobs) || !r.jobs.length || new Set(r.jobs.map(j => j.target)).size !== r.jobs.length ||
      r.jobs.some(j => typeof j.diagnostic !== 'string' || !j.diagnostic.trim() || j.diagnostic.length > 16000 ||
        j.diagnosticHash !== hash(j.diagnostic) || !/^[a-f0-9]{24}$/.test(j.unitId))) throw new Error('Invalid repair intent receipt');
  for (const job of r.jobs) { relativeName(job.target); relativeName(job.source); }
  return { ...r, checksum };
}
export function readRepairIntent(root, context) {
  const file = safePath(root, 'migration/state/repair.json');
  if (!fs.existsSync(file)) return null;
  const ref = readJSON(file);
  if (ref.schemaVersion !== 1 || ref.kind !== 'repair-intent-reference') throw new Error('Invalid active repair reference');
  const r = readRepairReceipt(root, ref.id, ref.checksum);
  return r.contextHash === context ? r : null;
}
export function done(root, unit, context) {
  const state = unitState(root, unit), output = safePath(root, unit.target);
  if (!(state?.status === 'done' && state.contextHash === context && state.target === unit.target &&
    fs.existsSync(output) && fs.statSync(output).isFile() && fs.statSync(output).size > 0 &&
    state.outputHash === fileHash(output) && state.reviewInputHash && state.reviews?.length === 2 && state.reviewEvidence?.length === 2 &&
    state.reviewEvidence.every(e => fileHash(safePath(root, e.path)) === e.hash) &&
    (!state.arbitration || fileHash(safePath(root, state.arbitration.path)) === state.arbitration.hash))) return false;
  try {
    const activeRepair = readRepairIntent(root, context);
    if (activeRepair?.jobs.some(j => j.target === unit.target) && state.repairIntentId !== activeRepair.id) return false;
    let repair = null;
    if (state.repairIntentId) {
      const receipt = readRepairReceipt(root, state.repairIntentId, state.repairIntentHash);
      repair = receipt.jobs.find(j => j.target === unit.target && j.source === unit.source && j.unitId === unit.id);
      if (receipt.contextHash !== context || !repair || state.diagnostic !== repair.diagnostic || state.repairDiagnosticHash !== repair.diagnosticHash) return false;
    }
    if (state.markerPolicy) {
      const evidence = markerEvidence({ markerPolicy: state.markerPolicy }, fs.readFileSync(output, 'utf8'));
      if (!evidence.valid || Object.entries(evidence).some(([key, value]) => state.markerEvidence?.[key] !== value)) return false;
    }
    const findings = [];
    for (const [i, role] of ['reviewer-semantics', 'reviewer-rules'].entries()) {
      if (state.reviews[i] !== state.reviewEvidence[i].path) return false;
      const record = readJSON(safePath(root, state.reviews[i])), result = record.result;
      if (repair && (record.repairIntentId !== state.repairIntentId || record.repairIntentHash !== state.repairIntentHash || record.diagnosticHash !== repair.diagnosticHash)) return false;
      if (record.role !== role || record.reviewInputHash !== state.reviewInputHash || result?.kind !== 'review' || result.target !== unit.target ||
          !Array.isArray(result.findings) || (result.verdict === 'pass') !== (result.findings.length === 0)) return false;
      findings.push(...result.findings.map(f => `${role}:${f.id}`));
    }
    if (!findings.length) return true;
    if (state.singlePass) return singlePassReceipt(root, unit, state, findings);
    if (!state.arbitration) return false;
    const record = readJSON(safePath(root, state.arbitration.path)), result = record.result;
    return record.role === 'arbiter' && result?.kind === 'arbitration' && result.target === unit.target &&
      result.decisions?.length === findings.length && new Set(result.decisions.map(d => d.finding)).size === findings.length &&
      result.decisions.every(d => findings.includes(d.finding) && d.confirmed === false);
  } catch { return false; }
}
// fixPolicy single-pass: both reviews judged the earlier candidate; every
// finding the arbiter did not reject was confirmed and handed to one fixer,
// whose recorded output is exactly the current target.
function singlePassReceipt(root, unit, state, findings) {
  const pass = state.singlePass;
  if (!pass?.fix?.path || fileHash(safePath(root, pass.fix.path)) !== pass.fix.hash || pass.reviewedOutputHash === state.outputHash) return false;
  const rejected = new Set();
  if (pass.arbitrated) {
    if (!state.arbitration) return false;
    const record = readJSON(safePath(root, state.arbitration.path)), result = record.result, seen = new Set();
    if (record.role !== 'arbiter' || result?.kind !== 'arbitration' || result.target !== unit.target || !Array.isArray(result.decisions)) return false;
    for (const d of result.decisions) {
      if (!findings.includes(d.finding) || seen.has(d.finding) || typeof d.confirmed !== 'boolean') return false;
      seen.add(d.finding); if (!d.confirmed) rejected.add(d.finding);
    }
  } else if (state.arbitration) return false;
  const confirmed = findings.filter(f => !rejected.has(f)).sort();
  if (!confirmed.length || JSON.stringify(confirmed) !== JSON.stringify(pass.confirmed)) return false;
  const fix = readJSON(safePath(root, pass.fix.path));
  return fix.role === 'fixer' && fix.status === 'success' && fix.result?.kind === 'implementation' &&
    fix.result.target === unit.target && typeof fix.result.content === 'string' && hash(fix.result.content) === state.outputHash;
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
// A build-loop releases the lock between its steps (approve, build, repair);
// another process must not slip in. A grant whose process is gone is stale.
// ignorePid skips this process's own grant, so another live one still shows.
export function activeBuildLoop(root, { ignorePid } = {}) {
  const dir = safePath(root, 'migration/gates');
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (!/^build-loop-[0-9a-f-]{36}\.json$/.test(name)) continue;
    let grant;
    try { grant = readJSON(path.join(dir, name)); } catch { continue; }
    if (grant?.finishedAt || !Number.isInteger(grant?.pid) || grant.pid < 1 || grant.pid === ignorePid || !pidAlive(grant.pid)) continue;
    return { id: grant.id, pid: grant.pid, stage: grant.stage, rounds: grant.rounds?.length ?? 0, maxRounds: grant.maxRounds,
      agentCalls: grant.agentCalls ?? 0, maxCalls: grant.maxCalls, file: `migration/gates/${name}` };
  }
  return null;
}
// Held from a build-loop's start to its end, so two loops never interleave.
// Taken like run.lock (complete metadata, published with link); a lock whose
// owner process is gone is moved aside and retaken once.
export function acquireBuildLoop(root, grantId) {
  const lock = safePath(root, 'migration/build-loop.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const pending = `${lock}.${crypto.randomUUID()}.tmp`;
  const read = file => { try { return readJSON(file); } catch { return null; } };
  try {
    fs.writeFileSync(pending, JSON.stringify({ pid: process.pid, grantId, startedAt: stamp() }), { flag: 'wx' });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(pending, lock);
        return () => { if (read(lock)?.grantId === grantId) fs.rmSync(lock, { force: true }); };
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const owner = read(lock);
      if (owner && Number.isInteger(owner.pid) && pidAlive(owner.pid)) throw new Error(`A build-loop (grant ${owner.grantId}, pid ${owner.pid}) is already running; wait for it to finish or interrupt that process`);
      // Rename is atomic; put back a lock another process took in the meantime.
      const aside = `${lock}.${crypto.randomUUID()}.stale`;
      try { fs.renameSync(lock, aside); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      const moved = read(aside);
      if (moved?.grantId !== owner?.grantId || moved?.pid !== owner?.pid) {
        try { fs.linkSync(aside, lock); } catch {}
        fs.rmSync(aside, { force: true });
        throw new Error('Another build-loop started while a stale build-loop lock was being recovered');
      }
      fs.rmSync(aside, { force: true });
    }
    throw new Error('Could not take the build-loop lock');
  } finally { fs.rmSync(pending, { force: true }); }
}
export function lockRun(root, task, { runId } = {}) {
  const loop = activeBuildLoop(root, { ignorePid: process.pid });
  if (loop) throw new Error(`A build-loop (grant ${loop.id}, pid ${loop.pid}) is running; wait for it to finish or interrupt that process before other runner commands`);
  const lock = safePath(root, 'migration/run.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const pending = `${lock}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(pending, JSON.stringify({ pid: process.pid, task, runId, startedAt: stamp() }), { flag: 'wx' });
    // Publish complete metadata atomically without replacing another owner's
    // lock. Opening the public path first would let readers see empty JSON.
    try { fs.linkSync(pending, lock); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Migration locked. Check the owner process, then use unlock --pid OWNER_PID if it has stopped.'); throw e; }
  } finally { fs.rmSync(pending, { force: true }); }
  return () => fs.rmSync(lock, { force: true });
}
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) args._.push(arg);
    else {
      const key = arg.slice(2);
      if (['apply', 'json', 'check-cli', 'with-workflow', 'confirm-no-dependencies', 'replace'].includes(key)) args[key] = true;
      else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`); args[key] = argv[++i]; }
    }
  }
  return args;
}
