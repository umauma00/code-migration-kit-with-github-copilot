// SPDX-License-Identifier: Apache-2.0
// A host's local sandbox (VS Code, Copilot CLI and the Copilot app; off by
// default) runs the session's commands, and the processes they start, with
// writes limited to the workspace and local network access limited. Phase 03
// needs both outside it: comparison B and the pilot work in new directories
// outside the repository, and doctor's reviewer-hook check talks to a loopback
// model provider. The kit never changes sandbox settings, so it checks early,
// during setup, and lets the person decide once instead of stopping at 03.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The directories phase 03 writes outside the repository: the temporary
// directory, and /tmp, where the comparison-B command in the checklist works
// (on macOS os.tmpdir() is a per-user folder, not /tmp).
export function outsideDirs() {
  const dirs = [os.tmpdir()];
  if (process.platform !== 'win32' && fs.existsSync('/tmp')) dirs.push('/tmp');
  return [...new Set(dirs.map(d => path.resolve(d)))];
}
function tryWrite(dir) {
  let made;
  try {
    made = fs.mkdtempSync(path.join(dir, 'migration-kit-sandbox-'));
    fs.writeFileSync(path.join(made, 'probe.txt'), 'probe\n');
    return null;
  } catch (e) { return e.code ?? e.message; }
  finally { if (made) try { fs.rmSync(made, { recursive: true, force: true }); } catch {} }
}
// Listen on loopback and connect to it, as the reviewer-hook check does.
function tryLoopback(host, timeoutMs) {
  return new Promise(resolve => {
    const server = net.createServer(socket => socket.end());
    let settled = false, client;
    const done = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      client?.destroy(); server.close();
      resolve(error);
    };
    const timer = setTimeout(() => done('timed out'), timeoutMs);
    server.once('error', e => done(e.code ?? e.message));
    try {
      server.listen(0, host, () => {
        client = net.connect(server.address().port, host);
        client.once('connect', () => done(null));
        client.once('error', e => done(e.code ?? e.message));
      });
    } catch (e) { done(e.code ?? e.message); }
  });
}
// { ok, blocked: [{ access: 'write' | 'loopback', path?, error }] }. Test
// seams: dirs and host replace the real directories and loopback address.
export async function localSandboxProbe({ dirs = outsideDirs(), host = '127.0.0.1', timeoutMs = 3000 } = {}) {
  const blocked = [];
  for (const dir of dirs) {
    const error = tryWrite(dir);
    if (error) blocked.push({ access: 'write', path: dir, error });
  }
  const error = await tryLoopback(host, timeoutMs);
  if (error) blocked.push({ access: 'loopback', host, error });
  return { ok: blocked.length === 0, blocked };
}
export const sandboxCheckName = 'commands can write outside the project and use loopback';
export function sandboxCheck(probe) {
  if (probe.ok) return { check: sandboxCheckName, ok: true };
  return { check: sandboxCheckName, ok: false, blocked: probe.blocked,
    detail: probe.blocked.map(b => b.access === 'write' ? `write ${b.path}: ${b.error}` : `loopback ${b.host}: ${b.error}`).join('; '),
    note: 'Usually a local sandbox (VS Code, Copilot CLI or the Copilot app). Phase 03 writes comparison B and the pilot outside the repository, and the reviewer-hook check uses loopback. Only the person changes sandbox settings: /sandbox off in that session, or allow these directories and local network access in the sandbox settings.' };
}
// The one setup question when the probe fails, in the report language: asked
// before phase 00 (and before the autopilot handoff), so phase 03 does not
// stop on it hours later.
export function sandboxQuestion(probe, language) {
  const dirs = [...new Set(probe.blocked.filter(b => b.access === 'write').map(b => b.path))];
  const loopback = probe.blocked.some(b => b.access === 'loopback');
  const ja = language === 'ja';
  const what = ja
    ? [dirs.length ? `リポジトリ外（${dirs.join('、')}）への書き込み` : '', loopback ? 'ローカル通信（127.0.0.1）' : ''].filter(Boolean).join('と')
    : [dirs.length ? `writes outside the repository (${dirs.join(', ')})` : '', loopback ? 'local network access (127.0.0.1)' : ''].filter(Boolean).join(' and ');
  return ja ? {
    question: `このセッションのコマンドは${what}ができません（ローカル sandbox が有効なためと思われます）。工程 03 の比較試験と pilot はリポジトリの外で動くため、このままでは 03 で止まります。どうしますか？ 設定を変えるのはあなたで、AI は変えません。`,
    choices: [
      { value: 'off', label: '/sandbox off にする（推奨）。この質問のあと自分で /sandbox off を入力し、「続けて」と送る。オフにするとこのセッションのコマンドは sandbox の制限なしで動きます' },
      { value: 'allow', label: 'sandbox は使い続け、sandbox の設定で上のフォルダへの書き込みとローカル通信を許可してから「続けて」と送る' },
      { value: 'keep', label: 'このまま進める（工程 03 の比較試験・pilot の前で、もう一度この判断が必要になります）' }]
  } : {
    question: `Commands in this session cannot make ${what} (most likely a local sandbox is on). Phase 03 runs its comparison and pilot outside the repository, so as things are it stops at phase 03. What should happen? Only you change these settings, never the AI.`,
    choices: [
      { value: 'off', label: 'Turn it off (recommended): after this question, type /sandbox off yourself, then send "continue". Commands in this session then run without the sandbox\'s limits' },
      { value: 'allow', label: 'Keep the sandbox, allow writing the folders above and local network access in its settings, then send "continue"' },
      { value: 'keep', label: 'Continue as is (the same decision comes back before the phase 03 comparison and pilot)' }]
  };
}
export const sandboxNext = 'The local sandbox check failed. Before anything else in this result (before autoHandoff, and before phase 00), ask sandboxQuestion as one question with its choices. On off or allow, end the turn; on the person\'s next message run doctor and confirm the check "commands can write outside the project and use loopback" passes (if it still fails, say what is still blocked and ask again). On keep, continue, and say that phase 03 will need the same decision. Never change sandbox settings yourself.';
