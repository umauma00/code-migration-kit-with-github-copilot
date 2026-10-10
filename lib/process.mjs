// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';

export function runProcess(command, args, { cwd, env = process.env, input, timeoutMs = 600000, signal, maxBytes = 16 * 1024 * 1024 } = {}) {
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    let child, failure, timeout, killTimer, closed = false, terminated = true, settled = false;
    let code = null, exitSignal = null, bytes = 0;
    const stdout = [], stderr = [];
    const finish = () => {
      if (settled || !closed || !terminated) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      const result = { command: [command, ...args], code, signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        startedAt, finishedAt: new Date().toISOString(), ...(failure ? { error: failure.message } : {}) };
      if (failure) { failure.result = result; reject(failure); } else resolve(result);
    };
    const fail = error => {
      if (failure || settled) return;
      failure = error; clearTimeout(timeout);
      if (!child?.pid) { closed = true; finish(); return; }
      terminated = false;
      if (process.platform === 'win32') {
        // Kill the tree before its parent can exit and orphan its descendants.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', e => { failure.message += `; taskkill failed: ${e.message}`; child.kill(); terminated = true; finish(); });
        killer.once('close', status => {
          if (status !== 0) { failure.message += `; taskkill exit ${status} (tree termination unconfirmed)`; child.kill(); }
          terminated = true; finish();
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        // Direct-child close must not cancel this escalation or release the
        // caller's lock while a grandchild can still be running.
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') failure.message += `; group kill failed: ${e.message}`; }
          terminated = true; finish();
        }, 1500);
      }
    };
    const abort = () => fail(new Error('Interrupted'));
    if (signal?.aborted) { closed = true; failure = new Error('Interrupted'); finish(); return; }
    try { child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (e) { closed = true; failure = e; finish(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => fail(new Error(`Process timed out after ${timeoutMs}ms`)), timeoutMs);
    const collect = chunks => data => {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining) chunks.push(data.subarray(0, remaining));
      bytes += data.length;
      if (bytes > maxBytes) fail(new Error('Process output exceeded limit'));
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.once('error', e => { failure ??= e; closed = true; finish(); });
    child.once('close', (status, sig) => { code = status; exitSignal = sig; closed = true; finish(); });
    if (input !== undefined) {
      child.stdin.on('error', e => { if (e.code !== 'EPIPE') fail(e); });
      child.stdin.end(input);
    }
    if (signal?.aborted) abort();
  });
}
