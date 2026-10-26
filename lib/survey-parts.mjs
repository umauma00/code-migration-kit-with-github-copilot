// SPDX-License-Identifier: Apache-2.0
// A scope is a durable result identity, not a model-context-sized work item.
// Partition source bodies as well as file/site lists. Fragment receipts prove
// coverage; concatenating observations never invents cross-fragment behavior.
const bytes = value => Buffer.byteLength(value);
const siteKey = item => JSON.stringify([item.file, item.symbol, item.source_construct]);

function rawSource(file) {
  return file.content.split('\n').map(line => line.slice(line.indexOf('|') + 1)).join('\n');
}

function sourceSlicer(file) {
  const raw = rawSource(file), starts = [0];
  for (let at = raw.indexOf('\n'); at !== -1; at = raw.indexOf('\n', at + 1)) starts.push(at + 1);
  const position = at => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const mid = (low + high) >> 1; if (starts[mid] <= at) low = mid; else high = mid; }
    return { line: file.firstLine + low, column: at - starts[low] + 1 };
  };
  const slice = (start, end) => {
    const first = position(start), last = position(Math.max(start, end - 1));
    const text = raw.slice(start, end), lines = text.split('\n'), trailingNewline = text.endsWith('\n');
    // Preserve the delimiter, but do not expose the next unread line's number
    // as if its body had been supplied in this fragment.
    const content = lines.map((line, i) => trailingNewline && i === lines.length - 1 ? '' : `${first.line + i}|${line}`).join('\n');
    const lastLine = first.line + lines.length - 1 - Number(trailingNewline);
    return { file: { path: file.path, firstLine: first.line, lastLine, firstColumn: first.column, lastColumn: last.column - Number(trailingNewline), content },
      fragment: { file: file.path, start, end, total: raw.length, offsetUnit: 'UTF-16 code units', firstLine: first.line, lastLine,
        instruction: 'This is an excerpt, not the complete file. Summarize only supplied code. Cross-excerpt behavior is unknown unless established here. For inventory, return every listed site; if its behavior is not established in this excerpt use UNKNOWN, unknown and TODO(port). Cite only the original lines in this excerpt.' } };
  };
  return { raw, slice };
}

function fittingPrefix(items, serialize, limit) {
  let low = 0, high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(serialize(items.slice(0, mid))) <= limit) low = mid; else high = mid - 1;
  }
  return low;
}

export function surveyRequests(kind, request, limit) {
  if (bytes(request.input.text) <= limit) return [request];
  const data = JSON.parse(request.input.text);
  // Repair explanations are recorded separately; they must not make every
  // fragment's identity change when a previously completed file is skipped.
  delete data.repair; delete data.partition;
  const parts = [];
  for (const file of data.files) {
    const census = kind === 'inventory' ? request.input.sites.filter(s => s.file === file.path) : undefined;
    const serialize = (source, sites, fragment) => JSON.stringify({ ...data, files: [source], ...(sites ? { sites } : {}),
      ...(fragment ? { fragment } : {}), partition: 'Cover only supplied files/sites and source ranges; preserve original line numbers.' });
    const add = (source, selected, fragment) => {
      const text = serialize(source, selected, fragment);
      if (bytes(text) > limit) throw new Error(`Survey metadata exceeds maxReviewInputBytes (${limit}); even one source character and one census site must fit`);
      parts.push({ scope: { ...request.scope, files: [file.path] }, accepted: [], fragment,
        input: { ...request.input, text, sites: selected, ranges: { [file.path]: [{ first: source.firstLine, last: source.lastLine }] } } });
    };
    const addSiteBatches = (source, fragment) => {
      if (!census) { add(source, undefined, fragment); return; }
      for (let at = 0; at < census.length;) {
        const remaining = census.slice(at), count = fittingPrefix(remaining, selected => serialize(source, selected, fragment), limit);
        if (!count) throw new Error(`Survey metadata exceeds maxReviewInputBytes (${limit}) for ${file.path}; the rulebook and one site must fit`);
        add(source, remaining.slice(0, count), fragment); at += count;
      }
    };
    // A large census with a small file needs only site batches, not source
    // fragments. Size source fragments against the largest individual site.
    const largestSite = census?.reduce((a, b) => bytes(JSON.stringify(a)) >= bytes(JSON.stringify(b)) ? a : b);
    const oneSite = largestSite ? [largestSite] : undefined;
    if (bytes(serialize(file, oneSite)) <= limit) { addSiteBatches(file); continue; }
    const { raw, slice } = sourceSlicer(file);
    const extraSiteBytes = census ? Math.max(0, bytes(JSON.stringify(census)) - bytes(JSON.stringify(oneSite))) : 0;
    for (let start = 0; start < raw.length;) {
      // A serialized byte limit also bounds the number of raw UTF-16 units.
      // Never probe the whole remaining file for each chunk (quadratic work).
      // Filling the envelope with source plus ONE site leaves only a handful
      // of bytes for every other site. A large census would then duplicate
      // the same source thousands of times. Share the available capacity
      // between source and census; small censuses all fit in one site batch.
      const empty = slice(start, start), overhead = bytes(serialize(empty.file, oneSite, empty.fragment));
      const reserve = Math.min(extraSiteBytes, Math.floor(Math.max(0, limit - overhead) / 2));
      const prefix = budget => {
        let low = start, high = Math.min(raw.length, start + budget);
        while (low < high) {
          const end = Math.ceil((low + high) / 2), part = slice(start, end);
          if (bytes(serialize(part.file, oneSite, part.fragment)) <= budget) low = end; else high = end - 1;
        }
        if (low < raw.length && /[\uDC00-\uDFFF]/.test(raw[low]) && /[\uD800-\uDBFF]/.test(raw[low - 1])) low--;
        return low;
      };
      let low = prefix(limit - reserve);
      // Required metadata may leave room for only one escaped character or
      // Unicode pair. A batching preference must never cause a false capacity
      // error when that character still fits with one site.
      if (low <= start && reserve) low = prefix(limit);
      if (low <= start) throw new Error(`Survey metadata exceeds maxReviewInputBytes (${limit}) before source text for ${file.path}; increase the capacity for required metadata`);
      // Prefer whole lines when useful; a minified/generated line still splits.
      const newline = raw.lastIndexOf('\n', low - 1);
      if (newline >= start && newline + 1 - start >= (low - start) / 2) low = newline + 1;
      const part = slice(start, low);
      addSiteBatches(part.file, part.fragment); start = low;
    }
    if (!raw.length) throw new Error(`Survey metadata exceeds maxReviewInputBytes (${limit}) with an empty source file`);
  }
  return parts;
}

export function combineSurveyParts(kind, parts) {
  if (kind === 'facts') return parts.flatMap(part => part.items);
  const groups = new Map();
  for (const part of parts) for (const item of part.items) {
    const key = kind === 'contracts' ? item.file : siteKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, fragment: part.fragment });
  }
  return [...groups.values()].map(rows => {
    if (rows.length === 1 && !rows[0].fragment) return rows[0].item;
    const first = rows[0].item;
    const label = r => `${r.item.file}:${r.fragment.firstLine}-${r.fragment.lastLine} [${r.fragment.start},${r.fragment.end})`;
    const field = name => rows.map(r => `[${label(r)}] ${r.item[name]}`).join('; ');
    const evidence = [...new Set(rows.map(r => r.item.evidence))].join('; ');
    if (kind === 'contracts') return { file: first.file, publicInterface: field('publicInterface'), inputsOutputsErrors: field('inputsOutputsErrors'),
      edgeCases: field('edgeCases'), evidence, unknowns: `Cross-fragment relationships require source-spec review; fragment observations are not a whole-file execution claim. ${field('unknowns')}` };
    // Seeing all bytes separately does not prove a whole-file data-flow trace.
    // Preserve every observation and every site while keeping that uncertainty
    // explicit for the inventory's ordinary review and integration gates.
    return { file: first.file, symbol: first.symbol, source_construct: first.source_construct, classification: 'UNKNOWN', status: 'unknown',
      target_translation: `Preserve source representation; TODO(port): verify cross-fragment creation, changes and escapes. Observations: ${field('target_translation')}`,
      evidence };
  });
}
