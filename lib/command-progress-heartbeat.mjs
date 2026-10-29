// SPDX-License-Identifier: Apache-2.0
// Runs on its own thread so the notice appears while the main thread is busy.
import { workerData } from 'node:worker_threads';
import fs from 'node:fs';

const started = Date.now();
setInterval(() => {
  try { fs.writeSync(2, `${workerData.label}: still running (${Math.floor((Date.now() - started) / 1000)}s); waiting is not a failure\n`); } catch {}
}, workerData.intervalMs);
