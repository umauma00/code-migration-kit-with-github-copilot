// SPDX-License-Identifier: Apache-2.0
// One line per Copilot CLI worker call, success or failure, with the usage the
// CLI itself wrote (--usage-output-file). Translation, repair, survey and
// preparation audit calls all go through the adapter, so this ledger is the
// kit-wide total. The person's own chat with the orchestrator is a separate
// CLI or VS Code session and is not in it: /usage there shows that part.
import fs from 'node:fs';
import path from 'node:path';
import { safePath, stamp } from './core.mjs';

export const usageLog = 'migration/runs/usage/calls.jsonl';
const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'nanoAiu'];
const nanoPerAiu = 1e9;

// usage is readUsageFile's result, or null when the CLI wrote none (the call
// still counts, so a total with such a call is marked incomplete).
export function recordCallUsage(root, { runId, role, target, sessionId, model, cliVersion, ok, usage }) {
  const file = safePath(root, usageLog);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const measured = usage ? Object.fromEntries([...usageKeys.filter(k => Number.isSafeInteger(usage[k])).map(k => [k, usage[k]]),
    ...(typeof usage.aiCreditsStatus === 'string' ? [['aiCreditsStatus', usage.aiCreditsStatus]] : [])]) : null;
  fs.appendFileSync(file, `${JSON.stringify({ at: stamp(), ...(typeof runId === 'string' ? { runId } : {}), role, target: target ?? null,
    sessionId: sessionId ?? null, model: model ?? null, cliVersion: cliVersion ?? null, ok: ok === true, usage: measured })}\n`);
}

function readLog(root) {
  const file = safePath(root, usageLog);
  if (!fs.existsSync(file)) return { entries: [], unreadable: 0 };
  const entries = []; let unreadable = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e.role === 'string') entries.push(e); else unreadable++; } catch { unreadable++; }
  }
  return { entries, unreadable };
}
const empty = () => ({ calls: 0, failedCalls: 0, unmeasuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 0 });
function add(total, e) {
  total.calls++;
  if (!e.ok) total.failedCalls++;
  if (!e.usage) { total.unmeasuredCalls++; return; }
  for (const k of usageKeys) if (Number.isSafeInteger(e.usage[k])) total[k] += e.usage[k];
}
const finish = t => ({ ...t, aiu: t.nanoAiu / nanoPerAiu, complete: t.unmeasuredCalls === 0 });

// Totals for every recorded call, or one run's calls. Read-only.
export function usageReport(root, { runId } = {}) {
  const { entries: all, unreadable } = readLog(root);
  const entries = runId === undefined ? all : all.filter(e => e.runId === runId);
  const total = empty(), byRole = {}, byModel = {};
  const statuses = new Set();
  for (const e of entries) {
    add(total, e);
    add(byRole[e.role] ??= empty(), e);
    add(byModel[e.model ?? 'unknown'] ??= empty(), e);
    if (typeof e.usage?.aiCreditsStatus === 'string') statuses.add(e.usage.aiCreditsStatus);
  }
  const map = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, finish(v)]));
  return { log: usageLog, ...(runId === undefined ? {} : { runId }), firstCall: entries[0]?.at ?? null, lastCall: entries.at(-1)?.at ?? null,
    total: finish(total), byRole: map(byRole), byModel: map(byModel), ...(statuses.size ? { aiCreditsStatus: [...statuses].sort() } : {}),
    ...(unreadable ? { unreadableLines: unreadable } : {}),
    notIncluded: ['the person\'s own chat with the orchestrator (run /usage in that Copilot CLI session)', 'worker calls made before this ledger existed (kit 0.22.0)', 'other roots such as pilot directories (run usage --root PILOT_DIR)'],
    basis: 'Copilot CLI --usage-output-file per worker call. AI units (AIU) are the CLI\'s figure; the CLI does not report the AI Credits amount, so check GitHub billing for the charge.' };
}

// The run total callers put in their summary: measured fields and completeness.
export function runUsage(root, runId) {
  const { total } = usageReport(root, { runId });
  return total.calls ? total : null;
}

const n = v => Number(v).toLocaleString('en-US');
export function usageMarkdown(report, language = 'en') {
  const ja = language === 'ja';
  const t = report.total;
  if (!t.calls) return ja ? `まだワーカー呼び出しの使用量記録がありません（${report.log}）。` : `No worker call usage recorded yet (${report.log}).`;
  const row = (name, v) => `| ${name} | ${n(v.calls)} | ${n(v.inputTokens)} | ${n(v.outputTokens)} | ${n(v.cacheReadTokens)} | ${v.aiu.toFixed(3)} |${v.complete ? '' : ja ? ' 未計測あり' : ' incomplete'}`;
  const head = ja ? '| 区分 | 呼び出し | 入力 | 出力 | キャッシュ読込 | AIU |\n|---|---:|---:|---:|---:|---:|' : '| Group | Calls | Input | Output | Cache read | AIU |\n|---|---:|---:|---:|---:|---:|';
  const lines = [ja ? `## ワーカーの AI 使用量${report.runId ? `（run ${report.runId}）` : ''}` : `## Worker AI usage${report.runId ? ` (run ${report.runId})` : ''}`, '',
    head, row(ja ? '合計' : 'Total', t), ...Object.entries(report.byRole).map(([k, v]) => row(k, v)), '',
    ja ? `モデル別: ${Object.entries(report.byModel).map(([k, v]) => `${k} ${v.aiu.toFixed(3)} AIU`).join('、')}` : `By model: ${Object.entries(report.byModel).map(([k, v]) => `${k} ${v.aiu.toFixed(3)} AIU`).join(', ')}`,
    ...(t.unmeasuredCalls ? [ja ? `- CLI が使用量を書かなかった呼び出しが ${t.unmeasuredCalls} 件あり、合計は下限です。` : `- ${t.unmeasuredCalls} calls had no CLI usage record, so the total is a lower bound.`] : []),
    ...(report.unreadableLines ? [ja ? `- 読めない記録行が ${report.unreadableLines} 行あります。` : `- ${report.unreadableLines} log lines could not be read.`] : []),
    ja ? '- AIU は CLI が報告する AI unit です。CLI は AI Credits の額を報告しないため、請求額は GitHub の使用量画面で確認してください。' : '- AIU is the AI unit figure the CLI reports. The CLI does not report the AI Credits amount; check GitHub billing for the charge.',
    ja ? '- オーケストレーターとの会話（親セッション）は含みません。その分はその Copilot CLI で /usage を実行すると見られます。' : '- The chat with the orchestrator (the parent session) is not included; run /usage in that Copilot CLI session for it.'];
  return lines.join('\n');
}
