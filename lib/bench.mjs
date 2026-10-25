// SPDX-License-Identifier: Apache-2.0
// Measure before folding workers together (docs/REVIEW-BENCHMARK.md). Two
// questions, each answered on the same seeded cases with the same workers the
// translation loop runs:
//   review: do one shared reviewer and the arbiter miss more seeded defects
//           than the two independent reviewers and the arbiter?
//   fix:    does the implementer, given the confirmed findings, fix as well as
//           the separate fixer?
// Every case runs several times: a fold that breaks a case may break it only
// on some runs. Nothing here changes the translation loop; the person reads
// the report and decides.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safePath, atomicWrite, writeJSON, readJSON, readManifest, hash, stamp } from './core.mjs';
import { reviewEvidence, findingAnchors, pairFindings } from './review.mjs';
import { runProcess } from './process.mjs';

export const benchDir = fileURLToPath(new URL('../fixtures/review-bench/', import.meta.url));
export const reviewVariants = ['dual', 'single'];
export const fixVariants = ['fixer', 'implementer'];
// The single variant keeps one of the two reviewer profiles. With reviewFocus
// shared it is a full reviewer of both lenses, the same contract each of the
// two dual reviewers already has.
export const singleReviewer = 'reviewer-semantics';

export function loadCases(dir = benchDir, only) {
  const data = readJSON(path.join(dir, 'cases.json'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.cases)) throw new Error('cases.json must be schemaVersion 1 with a cases array');
  const ids = new Set();
  for (const c of data.cases) {
    if (!/^[a-z0-9-]+$/.test(c.id ?? '') || ids.has(c.id)) throw new Error(`Bad or duplicate case id: ${c.id}`);
    ids.add(c.id);
    if (!Array.isArray(c.defects)) throw new Error(`${c.id}: defects must be an array`);
    for (const d of c.defects) if (!d.id || !Array.isArray(d.anchors) || !d.message || !d.evidence || !d.rule) throw new Error(`${c.id}: each defect needs id, anchors, message, evidence and rule`);
    for (const key of ['file', 'check']) if (!fs.existsSync(path.join(dir, c[key]))) throw new Error(`${c.id}: missing ${c[key]}`);
  }
  if (!only) return data.cases;
  const wanted = only.split(',').map(s => s.trim()).filter(Boolean);
  for (const id of wanted) if (!ids.has(id)) throw new Error(`Unknown case ${id}. Cases: ${[...ids].join(', ')}`);
  return data.cases.filter(c => wanted.includes(c.id));
}

// The most calls a run can make: the arbiter runs only when a review found
// something, so the review count is an upper bound.
export function benchPlan(cases, { runs, part = 'all' }) {
  const seeded = cases.filter(c => c.defects.length);
  const review = part === 'fix' ? { dual: 0, single: 0 } : { dual: cases.length * runs * 3, single: cases.length * runs * 2 };
  const fix = part === 'review' ? { fixer: 0, implementer: 0 } : { fixer: seeded.length * runs, implementer: seeded.length * runs };
  return { runs, part, cases: cases.map(c => c.id), maxCalls: { review, fix }, total: review.dual + review.single + fix.fixer + fix.implementer };
}

const text = f => `${f.message ?? ''} ${f.evidence ?? ''} ${f.rule ?? ''}`;
const anchorsOf = f => new Set([...findingAnchors({ evidence: `${f.message ?? ''} ${f.evidence ?? ''}` })]);
// A finding catches a defect when it cites one of the defect's exact lines, or
// names it in the defect's own words. A finding is credited to one defect at
// most: a cited line decides first, and a finding the words alone tie to
// several defects credits none (it is listed as ambiguous). Matching is
// mechanical; the report lists every finding so a person can audit it.
export function citesDefect(finding, defect) {
  const cited = anchorsOf(finding);
  return defect.anchors.some(anchor => cited.has(anchor));
}
export const namesDefect = (finding, defect) => Boolean(defect.pattern && new RegExp(defect.pattern, 'i').test(text(finding)));
export function creditedDefect(finding, defects) {
  const cited = defects.filter(d => citesDefect(finding, d));
  if (cited.length === 1) return { defect: cited[0].id };
  const named = (cited.length ? cited : defects).filter(d => namesDefect(finding, d));
  if (named.length === 1) return { defect: named[0].id };
  return { defect: null, ...(cited.length > 1 || named.length > 1 ? { ambiguous: (named.length > 1 ? named : cited).map(d => d.id) } : {}) };
}
export const catches = (finding, defect) => creditedDefect(finding, [defect]).defect === defect.id;

// Stops taking work after the first failure and waits for every started job,
// so nothing keeps calling models or touches the root once the caller unwinds.
async function pool(items, limit, fn) {
  let next = 0, failure = null;
  await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (e) { failure ??= e; }
    }
  }));
  if (failure) throw failure;
}

function changedLines(before, after) {
  const left = before.split(/\r?\n/), right = after.split(/\r?\n/);
  const counts = new Map();
  for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1);
  let kept = 0;
  for (const line of right) if (counts.get(line)) { counts.set(line, counts.get(line) - 1); kept++; }
  return left.length - kept + (right.length - kept);
}

// setup writes this marker; run refuses any other root, so it never writes
// or deletes a real project's targets.
export const benchMarker = 'migration/review-bench.json';
const fatal = e => /^First .* call failed|^Interrupted$|^Call limit reached$/.test(e.message);
// Checks import model output: give them no credentials from this shell.
const checkEnv = () => Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));

export async function runBenchmark(root, config, adapter, { cases, runs, part = 'all', out, maxCalls, dir = benchDir, signal, onProgress = () => {} }) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  if (!fs.existsSync(safePath(root, benchMarker))) throw new Error(`Not a benchmark root (no ${benchMarker}); create one with review_benchmark.mjs setup`);
  if (config.reviewFocus !== 'shared') throw new Error('The benchmark needs reviewFocus "shared" in migration/config.json, so the single reviewer checks both lenses like each dual reviewer does');
  const plan = benchPlan(cases, { runs, part });
  if (!Number.isInteger(maxCalls) || plan.total > maxCalls) throw new Error(`This benchmark can make up to ${plan.total} model calls; pass --max-calls ${plan.total} or more after checking the plan`);
  // Workers with view/grep/glob read the root: earlier results and fixed
  // files there would hand later runs the answers.
  const realRoot = fs.realpathSync(root), outFull = path.resolve(out);
  if (outFull === realRoot || outFull.startsWith(`${realRoot}${path.sep}`) || outFull === path.resolve(root) || outFull.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('The output directory must be outside the benchmark root, which workers can read');
  if (fs.existsSync(out)) throw new Error(`Output directory already exists: ${out}`);
  for (const c of cases) if (fs.existsSync(safePath(root, c.target))) throw new Error(`${c.target} already exists in the benchmark root; remove it (a stopped run may have left it)`);
  fs.mkdirSync(out, { recursive: true });
  const units = readManifest(root, config);
  const records = [], meta = { startedAt: stamp(), runs, part, cases: plan.cases, models: { ...config.models }, efforts: { ...(config.reasoningEfforts ?? {}) }, reviewFocus: config.reviewFocus, maxCalls };
  // The single reviewer is told it is the only one (agentPrompt reviewFocus single).
  const singleConfig = { ...config, reviewFocus: 'single' };
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let calls = 0, successes = 0;
  const record = r => { records.push(r); fs.appendFileSync(path.join(out, 'results.jsonl'), `${JSON.stringify(r)}\n`); };
  const invoke = async (job, unit, role, extra = {}, review = null, cfg = config) => {
    if (controller.signal.aborted) throw new Error('Interrupted');
    if (++calls > maxCalls) throw new Error('Call limit reached');
    job.calls++;
    try {
      const response = await adapter({ root, config: cfg, role, unit, extra, signal: controller.signal, reviewInput: review?.text, reviewMode: review?.mode });
      successes++;
      return response;
    } catch (e) {
      // No call has worked yet: a login, model or profile problem, not a result.
      if (!successes) { stop(); throw Object.assign(new Error(`First ${role} call failed; nothing was measured: ${e.message}`), { cause: e }); }
      if (controller.signal.aborted) throw new Error('Interrupted');
      throw e;
    }
  };
  const tokens = responses => responses.every(r => Number.isFinite(r?.tokens)) ? responses.reduce((n, r) => n + r.tokens, 0) : null;
  try {
    for (const c of cases) {
      const unit = units.find(u => u.target === c.target);
      if (!unit) throw new Error(`${c.id}: ${c.target} is not in migration/manifest.tsv; run setup again`);
      const seeded = fs.readFileSync(path.join(dir, c.file), 'utf8');
      const target = safePath(root, c.target);
      atomicWrite(target, seeded);
      try {
        if (part !== 'fix') {
          const review = reviewEvidence(root, config, unit);
          const jobs = reviewVariants.flatMap(variant => Array.from({ length: runs }, (_, run) => ({ variant, run })));
          await pool(jobs, config.concurrency ?? 1, async ({ variant, run }) => {
            onProgress({ case: c.id, part: 'review', variant, run });
            const responses = [], job = { calls: 0 };
            const base = { part: 'review', case: c.id, variant, run, seededHash: hash(seeded) };
            try {
              const roles = variant === 'dual' ? ['reviewer-semantics', 'reviewer-rules'] : [singleReviewer];
              const settled = await Promise.allSettled(roles.map(role => invoke(job, unit, role, {}, review, variant === 'single' ? singleConfig : config)));
              responses.push(...settled.filter(s => s.status === 'fulfilled').map(s => s.value));
              const failed = settled.find(s => s.status === 'rejected');
              if (failed) throw failed.reason;
              const reviews = settled.map(s => s.value);
              const reviewMap = Object.fromEntries(roles.map((role, i) => [role, reviews[i]]));
              const { findings, samePlace } = variant === 'dual' ? pairFindings(reviewMap)
                : { findings: reviews[0].result.findings.map(f => ({ ...f, reference: `${singleReviewer}:${f.id}` })), samePlace: [] };
              let confirmed = [];
              if (findings.length) {
                const arbitration = await invoke(job, unit, 'arbiter', { findings, samePlace });
                responses.push(arbitration);
                const decided = new Map(arbitration.result.decisions.map(d => [d.finding, d.confirmed === true]));
                confirmed = findings.filter(f => decided.get(f.reference)).map(f => f.reference);
              }
              const matched = findings.map(f => {
                const credit = creditedDefect(f, c.defects);
                return { reference: f.reference, message: f.message, evidence: f.evidence, rule: f.rule,
                  defects: credit.defect ? [credit.defect] : [], ...(credit.ambiguous ? { ambiguous: credit.ambiguous } : {}), confirmed: confirmed.includes(f.reference) };
              });
              const caught = which => c.defects.filter(d => matched.some(f => (which === 'raw' || f.confirmed) && f.defects.includes(d.id))).map(d => d.id);
              record({ ...base, status: 'ok', findings: matched, caught: { raw: caught('raw'), confirmed: caught('confirmed') },
                calls: job.calls, tokens: tokens(responses), observedModels: responses.map(r => r.observedModel ?? null) });
            } catch (e) {
              if (fatal(e)) throw e;
              record({ ...base, status: 'failed', error: e.message.slice(0, 1000), calls: job.calls });
            }
          });
        }
        if (part !== 'review' && c.defects.length) {
          const confirmedFindings = c.defects.map((d, i) => ({ id: `B${i + 1}`, reference: `bench:${d.id}`, message: d.message, evidence: d.evidence, rule: d.rule }));
          const jobs = fixVariants.flatMap(variant => Array.from({ length: runs }, (_, run) => ({ variant, run })));
          await pool(jobs, config.concurrency ?? 1, async ({ variant, run }) => {
            onProgress({ case: c.id, part: 'fix', variant, run });
            const base = { part: 'fix', case: c.id, variant, run, seededHash: hash(seeded) }, job = { calls: 0 };
            try {
              // The fold: the implementer profile and model, handed the same
              // confirmed findings the fixer gets.
              const response = await invoke(job, unit, variant, { confirmedFindings, diagnostic: null });
              const content = response.result.content;
              const file = path.join(out, 'fixes', `${c.id}-${variant}-${run}`, path.basename(c.target));
              atomicWrite(file, content);
              const unchanged = hash(content) === hash(seeded);
              const check = unchanged ? null : await runProcess(process.execPath, [path.join(dir, c.check), file], { cwd: os.tmpdir(), env: checkEnv(), timeoutMs: 20000, signal: controller.signal });
              record({ ...base, status: 'ok', pass: !unchanged && check.code === 0, unchanged, changedLines: changedLines(seeded, content),
                checkOutput: check ? `${check.stdout}${check.stderr}`.trim().slice(-1000) : 'returned the seeded file unchanged',
                file: path.relative(out, file).split(path.sep).join('/'), calls: job.calls, tokens: tokens([response]), observedModels: [response.observedModel ?? null] });
            } catch (e) {
              if (fatal(e)) throw e;
              record({ ...base, status: 'failed', error: e.message.slice(0, 1000), calls: job.calls });
            }
          });
        }
      } finally { fs.rmSync(target, { force: true }); }
    }
  } finally { signal?.removeEventListener('abort', stop); }
  const summary = summarize(cases, records, { ...meta, finishedAt: stamp(), calls });
  writeJSON(path.join(out, 'summary.json'), summary);
  atomicWrite(path.join(out, 'report.md'), report(summary));
  return summary;
}

const rate = (n, d) => d ? Math.round((n / d) * 1000) / 1000 : null;
const sum = values => values.every(v => Number.isFinite(v)) ? values.reduce((a, b) => a + b, 0) : null;

export function summarize(cases, records, meta = {}) {
  const review = Object.fromEntries(reviewVariants.map(variant => {
    const mine = records.filter(r => r.part === 'review' && r.variant === variant);
    const ok = mine.filter(r => r.status === 'ok');
    let defects = 0, missedRaw = 0, missedConfirmed = 0, falseFindings = 0, falseConfirmed = 0, extraFindings = 0;
    const perCase = {};
    for (const c of cases) {
      const runsOf = ok.filter(r => r.case === c.id);
      if (!c.defects.length) {
        const found = runsOf.flatMap(r => r.findings);
        falseFindings += found.length; falseConfirmed += found.filter(f => f.confirmed).length;
        perCase[c.id] = { runs: runsOf.length, falseFindings: found.length, falseConfirmed: found.filter(f => f.confirmed).length };
        continue;
      }
      extraFindings += runsOf.flatMap(r => r.findings).filter(f => !f.defects.length).length;
      perCase[c.id] = { runs: runsOf.length, defects: Object.fromEntries(c.defects.map(d => {
        const raw = runsOf.filter(r => r.caught.raw.includes(d.id)).length, confirmed = runsOf.filter(r => r.caught.confirmed.includes(d.id)).length;
        defects += runsOf.length; missedRaw += runsOf.length - raw; missedConfirmed += runsOf.length - confirmed;
        return [d.id, { raw, confirmed }];
      })) };
    }
    return [variant, { runs: ok.length, failed: mine.length - ok.length, seededDefectRuns: defects, missedRaw, missedConfirmed,
      missRateRaw: rate(missedRaw, defects), missRateConfirmed: rate(missedConfirmed, defects),
      falseFindings, falseConfirmed, extraFindings, calls: mine.reduce((n, r) => n + (r.calls ?? 0), 0), tokens: sum(ok.map(r => r.tokens)), perCase }];
  }));
  const fix = Object.fromEntries(fixVariants.map(variant => {
    const mine = records.filter(r => r.part === 'fix' && r.variant === variant);
    const ok = mine.filter(r => r.status === 'ok');
    const perCase = Object.fromEntries(cases.filter(c => c.defects.length).map(c => {
      const runsOf = ok.filter(r => r.case === c.id);
      return [c.id, { runs: runsOf.length, pass: runsOf.filter(r => r.pass).length, unchanged: runsOf.filter(r => r.unchanged).length }];
    }));
    return [variant, { runs: ok.length, failed: mine.length - ok.length, pass: ok.filter(r => r.pass).length, passRate: rate(ok.filter(r => r.pass).length, ok.length),
      calls: mine.reduce((n, r) => n + (r.calls ?? 0), 0), tokens: sum(ok.map(r => r.tokens)), perCase }];
  }));
  // What the article asks to look at besides the score: which cases changed.
  const reviewChanges = [], fixChanges = [];
  for (const c of cases) for (const d of c.defects) {
    const a = review.dual.perCase[c.id]?.defects?.[d.id], b = review.single.perCase[c.id]?.defects?.[d.id];
    const runsOf = { dual: review.dual.perCase[c.id]?.runs ?? 0, single: review.single.perCase[c.id]?.runs ?? 0 };
    // Unequal completed runs (failures) make raw counts incomparable: say so.
    if (a && b && (a.confirmed !== b.confirmed || a.raw !== b.raw || runsOf.dual !== runsOf.single)) reviewChanges.push({ case: c.id, defect: d.id, dual: a, single: b, runs: runsOf, ...(runsOf.dual !== runsOf.single ? { unequalRuns: true } : {}) });
  }
  for (const c of cases.filter(x => x.defects.length)) {
    const a = fix.fixer.perCase[c.id], b = fix.implementer.perCase[c.id];
    if (a && b && (a.pass !== b.pass || a.runs !== b.runs)) fixChanges.push({ case: c.id, fixer: a, implementer: b, ...(a.runs !== b.runs ? { unequalRuns: true } : {}) });
  }
  return { schemaVersion: 1, kind: 'review-benchmark', ...meta, review, fix, reviewChanges, fixChanges };
}

const show = v => v === null || v === undefined ? 'unknown' : String(v);
const pct = v => v === null ? 'n/a' : `${Math.round(v * 1000) / 10}%`;
export function report(s) {
  const lines = [`# Review benchmark`, '', `Runs per case: ${s.runs}. Part: ${s.part}. Review focus: ${s.reviewFocus}. Calls made: ${show(s.calls)}.`,
    `Models: ${Object.entries(s.models ?? {}).map(([r, m]) => `${r}=${m}`).join(', ')}.`, '',
    'Matching is mechanical (an exact cited line of a seeded defect, or the defect\'s pattern; one defect per finding at most, ties credit none and are marked ambiguous). Audit the findings in results.jsonl before deciding.', ''];
  if (s.part !== 'fix') {
    lines.push('## Review: two reviewers vs one', '', '| | dual | single |', '|---|---|---|');
    const row = (label, f) => lines.push(`| ${label} | ${f(s.review.dual)} | ${f(s.review.single)} |`);
    row('miss rate after arbiter', v => `${pct(v.missRateConfirmed)} (${v.missedConfirmed}/${v.seededDefectRuns})`);
    row('miss rate before arbiter', v => `${pct(v.missRateRaw)} (${v.missedRaw}/${v.seededDefectRuns})`);
    row('findings on clean controls', v => `${v.falseFindings} (${v.falseConfirmed} confirmed)`);
    row('unmatched findings on seeded cases', v => String(v.extraFindings));
    row('failed runs', v => String(v.failed));
    row('calls / tokens', v => `${v.calls} / ${show(v.tokens)}`);
    lines.push('', '### Cases that changed', '');
    if (!s.reviewChanges.length) lines.push('None: every seeded defect was caught equally often.');
    for (const ch of s.reviewChanges) lines.push(`- ${ch.case} ${ch.defect}: dual ${ch.dual.confirmed} confirmed / ${ch.dual.raw} found of ${ch.runs.dual} runs, single ${ch.single.confirmed} / ${ch.single.raw} of ${ch.runs.single}${ch.unequalRuns ? ' (completed runs differ: compare rates, check the failures)' : ''}`);
    lines.push('');
  }
  if (s.part !== 'review') {
    lines.push('## Fix: fixer vs implementer', '', '| | fixer | implementer |', '|---|---|---|');
    const row = (label, f) => lines.push(`| ${label} | ${f(s.fix.fixer)} | ${f(s.fix.implementer)} |`);
    row('check passed', v => `${pct(v.passRate)} (${v.pass}/${v.runs})`);
    row('failed runs', v => String(v.failed));
    row('calls / tokens', v => `${v.calls} / ${show(v.tokens)}`);
    lines.push('', '### Cases that changed', '');
    if (!s.fixChanges.length) lines.push('None: both passed each case equally often.');
    for (const ch of s.fixChanges) lines.push(`- ${ch.case}: fixer ${ch.fixer.pass}/${ch.fixer.runs}, implementer ${ch.implementer.pass}/${ch.implementer.runs}${ch.unequalRuns ? ' (completed runs differ: check the failures)' : ''}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
