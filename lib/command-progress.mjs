// SPDX-License-Identifier: Apache-2.0
export async function commandProgress(label, action, { intervalMs = 15000, write = message => console.error(message) } = {}) {
  const started = Date.now();
  write(`${label}: started`);
  const timer = setInterval(() => write(`${label}: still running (${Math.floor((Date.now() - started) / 1000)}s); waiting is not a failure`), intervalMs);
  timer.unref();
  try { return await action(); } finally { clearInterval(timer); }
}
