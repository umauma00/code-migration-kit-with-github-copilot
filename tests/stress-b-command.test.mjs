// SPDX-License-Identifier: Apache-2.0
// Comparison B in phase 03 is a fresh `copilot -p` limited by --available-tools.
// On CLI 1.0.105, gpt-6-luna has no create/edit tool: it writes only through
// apply_patch (grep becomes rg on its own, create and edit do not). Without
// apply_patch in the list, B got read-only tools and wrote nothing (2026-10-29).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { kitRoot } from '../scripts/install.mjs';

test('every copy of the comparison-B command can write with create/edit models and apply_patch models', () => {
  // The prompt sends B through the runner, which lists the model's own tools;
  // the checklists keep the fixed fallback command.
  assert.match(fs.readFileSync(path.join(kitRoot, 'prompts/03-stress-test.md'), 'utf8'), /stress-b command --dir DIR/);
  for (const rel of ['docs/STRESS-TEST-CHECKLIST.md', 'docs/STRESS-TEST-CHECKLIST.en.md']) {
    const text = fs.readFileSync(path.join(kitRoot, rel), 'utf8');
    const lists = [...text.matchAll(/--available-tools ([\w,]+) --allow-tool write/g)].map(m => m[1].split(','));
    assert.ok(lists.length, `${rel} shows the B command`);
    for (const tools of lists) {
      for (const tool of ['create', 'edit', 'apply_patch', 'view']) assert.ok(tools.includes(tool), `${rel}: ${tool} missing`);
      assert.ok(!tools.includes('skill'), `${rel}: skill descriptions must stay out of B`);
    }
  }
});
