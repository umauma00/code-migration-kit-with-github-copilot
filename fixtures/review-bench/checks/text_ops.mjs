// Behavior check for a fixed ported/text_ops.mjs: node checks/text_ops.mjs FILE
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readCandidate } from './common.mjs';
const file = process.argv[2];
readCandidate(file);
const { greeting } = await import(pathToFileURL(file).href);
assert.deepEqual(greeting('abc'), ['Hello, abc', 3]);
assert.deepEqual(greeting('\u{1F600}x'), ['Hello, \u{1F600}x', 2]);
assert.deepEqual(greeting(''), ['Hello, ', 0]);
