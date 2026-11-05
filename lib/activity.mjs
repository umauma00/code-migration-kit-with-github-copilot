// SPDX-License-Identifier: Apache-2.0
// What a worker call did, counted from the CLI's JSON lines the runner keeps
// (streamed pieces are not kept): its model turns, its tool calls by tool, the
// files it viewed most and how often view turned one down as too large, and
// how large its context grew. Counts and project paths only: no content, no
// tool arguments but a viewed file's path, no answer. A file outside the
// project is counted without its name.
// 2026-11-05: calls told to read every listed file in full ran for hours, and
// nothing in the kit's records said what they did. Checked on CLI 1.0.105
// (offline, the real binary): view turns down a file over 20 KB unless given a
// view_range and then returns about 20 KB per call; each tool result's
// telemetry carries context_current_tokens (the context before that result
// is added), context_token_limit and, for most results, result_token_count
// (no document describes them, so they are read when present and null
// otherwise; a result without result_token_count, such as a whole 1 MB file,
// shows only in the next result's context); a compaction writes no JSON line
// (the 1.0.106 pre-releases add one), so compactions are counted only once
// the CLI writes one.
import fs from 'node:fs';
import path from 'node:path';

const topViews = 5;
export function callActivity(lines, root) {
  const bases = [...new Set([path.resolve(root), (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })()])];
  const relative = file => {
    if (typeof file !== 'string' || !file) return null;
    const full = path.isAbsolute(file) ? file : path.resolve(root, file);
    for (const base of bases) {
      const rel = path.relative(base, full);
      // A name of the project may start with two dots (..config.cs).
      if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    }
    return null;
  };
  const tools = {}, views = new Map(), refused = new Map(), viewOf = new Map();
  let turns = 0, outsideViews = 0, contextTokens = null, contextLimit = null, compactions = null;
  for (const line of lines ?? []) {
    if (typeof line !== 'string' || !line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || event.agentId || event.data?.parentToolCallId) continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    if (event.type === 'assistant.turn_start') turns++;
    else if (event.type === 'tool.execution_start' && typeof data.toolName === 'string' && data.toolName) {
      tools[data.toolName] = (tools[data.toolName] ?? 0) + 1;
      if (data.toolName !== 'view') continue;
      const file = relative(data.arguments?.path);
      if (file === null) { outsideViews++; continue; }
      views.set(file, (views.get(file) ?? 0) + 1);
      if (typeof data.toolCallId === 'string') viewOf.set(data.toolCallId, file);
    } else if (event.type === 'tool.execution_complete') {
      const metrics = data.toolTelemetry?.metrics, properties = data.toolTelemetry?.properties;
      // The context once this result is in it: before it, plus the result.
      const added = Number.isSafeInteger(metrics?.result_token_count) && metrics.result_token_count > 0 ? metrics.result_token_count : 0;
      if (Number.isSafeInteger(metrics?.context_current_tokens) && metrics.context_current_tokens >= 0) contextTokens = Math.max(contextTokens ?? 0, metrics.context_current_tokens + added);
      if (Number.isSafeInteger(metrics?.context_token_limit) && metrics.context_token_limit > 0) contextLimit = metrics.context_token_limit;
      const file = viewOf.get(data.toolCallId);
      if (file !== undefined && properties?.largeOutputAvoided === 'true') refused.set(file, (refused.get(file) ?? 0) + 1);
    } else if (event.type === 'session.compaction_complete') compactions = (compactions ?? 0) + 1;
  }
  const ranked = [...views].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const moreViews = ranked.slice(topViews).reduce((sum, [, n]) => sum + n, 0);
  return { turns, tools: Object.fromEntries(Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : 1))),
    views: ranked.slice(0, topViews).map(([file, n]) => ({ path: file, views: n, ...(refused.get(file) ? { refused: refused.get(file) } : {}) })),
    ...(moreViews ? { moreViews } : {}), ...(outsideViews ? { outsideViews } : {}), contextTokens, contextLimit, compactions };
}
// One line of it for a person: the note to a call tried again names the file
// it viewed most; the reason a file was set aside does not (withPath false),
// since the kit reads that reason to choose its retries and its guidance, and
// a file's name could read as another cause (Interrupted, Credentials,
// manifest.tsv). The call's record keeps the name.
export function activitySummary(activity, { withPath = true } = {}) {
  if (!activity || typeof activity !== 'object') return '';
  const calls = Object.values(activity.tools ?? {}).reduce((sum, n) => sum + n, 0), top = activity.views?.[0];
  return [Number.isSafeInteger(activity.turns) ? `${activity.turns} model turns` : null, `${calls} tool calls`,
    top ? (withPath ? `${top.path} viewed ${top.views} times` : `a file viewed ${top.views} times`) : null,
    Number.isSafeInteger(activity.contextTokens) ? `context up to ${activity.contextTokens} tokens${Number.isSafeInteger(activity.contextLimit) ? ` of ${activity.contextLimit}` : ''}` : null,
    Number.isSafeInteger(activity.compactions) ? `${activity.compactions} compactions` : null].filter(Boolean).join(', ');
}
