// SPDX-License-Identifier: Apache-2.0
import { Worker } from 'node:worker_threads';

// Status, phase and gate checks hash and validate synchronously. A timer on
// the main thread cannot fire until they finish, so the host saw silence and
// cancelled. The default notice therefore comes from its own thread, writing
// straight to stderr. A custom writer (tests) keeps the main-thread timer.

// Quick checks skip the opening line so a failure still starts with ERROR.
export async function commandProgress(label, action, { intervalMs = 15000, write, announce = true } = {}) {
  const started = Date.now();
  if (announce) (write ?? (message => console.error(message)))(`${label}: started`);
  let timer, worker;
  if (write) {
    timer = setInterval(() => write(`${label}: still running (${Math.floor((Date.now() - started) / 1000)}s); waiting is not a failure`), intervalMs);
    timer.unref();
  } else {
    try { worker = new Worker(new URL('./command-progress-heartbeat.mjs', import.meta.url), { workerData: { label, intervalMs }, execArgv: [] }); worker.unref(); worker.on('error', () => {}); }
    catch {}
  }
  try { return await action(); } finally { clearInterval(timer); worker?.terminate().catch(() => {}); }
}
