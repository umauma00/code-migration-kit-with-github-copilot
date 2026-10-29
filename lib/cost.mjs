// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { safePath, atomicWrite, readJSON, writeJSON } from './core.mjs';

export const costHeader = 'step\ttimestamp\twall_clock_min\ttokens\tsubagents\tmodel';
const cell = value => value === undefined || value === null ? 'unknown' : String(value);
export function costEvent({ id, step, startedAt, finishedAt, tokens, subagents, model }) {
  const wall = startedAt && finishedAt ? (Date.parse(finishedAt) - Date.parse(startedAt)) / 60000 : null;
  if (wall !== null && (!Number.isFinite(wall) || wall < 0)) throw new Error('Invalid cost timing');
  for (const value of [tokens, subagents]) if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Usage must be a nonnegative integer or unknown');
  const values = [step, finishedAt, wall === null ? null : Number(wall.toFixed(6)), tokens, subagents, model].map(cell);
  if (!id || values.some(v => /[\t\r\n\0]/.test(v))) throw new Error('Invalid cost-log value');
  return { id, row: values.join('\t') };
}

// Caller holds the run lock. Keep event IDs outside the main-compatible TSV so
// rerunning a completed operation can repair export without charging it twice.
export function recordCost(root, event) {
  const table = safePath(root, 'migration/cost-log.tsv'), index = safePath(root, 'migration/phases/cost-index.json');
  const parse = text => {
    const rows = text.trimEnd().split('\n');
    if (rows.shift() !== costHeader || rows.some(row => row.split('\t').length !== 6)) throw new Error('Existing migration/cost-log.tsv has an incompatible format');
    return rows;
  };
  let state;
  if (fs.existsSync(index)) {
    state = readJSON(index);
    if (state.schemaVersion !== 1 || !Array.isArray(state.rows) || state.rows.some(r => typeof r.id !== 'string' || typeof r.row !== 'string' || r.row.split('\t').length !== 6)) throw new Error('Invalid cost-log index');
    const expected = `${costHeader}\n${state.rows.map(r => r.row).join('\n')}${state.rows.length ? '\n' : ''}`;
    if (fs.existsSync(table)) {
      const actual = fs.readFileSync(table, 'utf8'); parse(actual);
      if (actual !== expected && actual.startsWith(expected)) {
        for (const row of parse(actual).slice(state.rows.length)) state.rows.push({ id: `import-${state.rows.length}`, row });
      } else if (actual !== expected && !expected.startsWith(actual)) throw new Error('cost-log.tsv was edited; reconcile it with migration/phases/cost-index.json before recording');
    }
  } else {
    state = { schemaVersion: 1, rows: fs.existsSync(table) ? parse(fs.readFileSync(table, 'utf8')).map((row, i) => ({id:`import-${i}`, row})) : [] };
  }
  const existing = state.rows.find(r => r.id === event.id);
  if (existing && existing.row !== event.row) throw new Error('Cost event ID reused with different usage');
  if (!existing) state.rows.push(event);
  writeJSON(index, state);
  atomicWrite(table, `${costHeader}\n${state.rows.map(r => r.row).join('\n')}\n`);
}
