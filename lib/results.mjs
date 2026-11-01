// SPDX-License-Identifier: Apache-2.0
export function parseResult(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  // The parser's own reason (such as text after the object) travels with the
  // error, so the one correction can say what was wrong; the message is stable.
  try { return JSON.parse(clean); } catch (e) { throw Object.assign(new Error('Agent did not return one valid JSON object; no completion recorded'), { parseError: e.message }); }
}
const string = (v, field) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`Result requires ${field}`); };
export function validateResult(role, result, unit) {
  if (!result || result.schemaVersion !== 1 || result.target !== unit.target) throw new Error('Result schemaVersion/target mismatch');
  if (['implementer', 'fixer'].includes(role)) {
    if (result.kind !== 'implementation') throw new Error('Expected implementation result');
    string(result.content, 'content'); string(result.summary, 'summary');
  } else if (role.startsWith('reviewer-')) {
    if (result.kind !== 'review' || !['pass', 'changes'].includes(result.verdict) || !Array.isArray(result.findings)) throw new Error('Invalid review result');
    const ids = new Set();
    for (const f of result.findings) {
      for (const field of ['id', 'message', 'evidence', 'rule']) string(f[field], `finding.${field}`);
      if (ids.has(f.id)) throw new Error('Duplicate finding id'); ids.add(f.id);
    }
    if ((result.verdict === 'pass') !== (result.findings.length === 0)) throw new Error('Review verdict contradicts findings');
  } else if (role === 'preparation-auditor') {
    if (result.kind !== 'preparation-audit' || !['pass', 'changes'].includes(result.verdict) || !Array.isArray(result.findings)) throw new Error('Invalid preparation audit result');
  } else if (role === 'surveyor') {
    if (result.kind !== 'survey' || typeof result.survey !== 'string' || !Array.isArray(result.items)) throw new Error('Invalid survey result');
  } else if (role === 'arbiter') {
    if (result.kind !== 'arbitration' || !Array.isArray(result.decisions)) throw new Error('Invalid arbitration result');
    for (const d of result.decisions) {
      string(d.finding, 'finding'); string(d.reason, 'reason');
      if (typeof d.confirmed !== 'boolean') throw new Error('Arbitration requires confirmed boolean');
    }
  }
  return result;
}
