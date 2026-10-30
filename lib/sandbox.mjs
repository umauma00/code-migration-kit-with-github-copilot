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
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.end(); });
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
// seams: dirs, host and loopback replace the real directories and check.
export async function localSandboxProbe({ dirs = outsideDirs(), host = '127.0.0.1', timeoutMs = 3000, loopback = tryLoopback } = {}) {
  const blocked = [];
  for (const dir of dirs) {
    const error = tryWrite(dir);
    if (error) blocked.push({ access: 'write', path: dir, error });
  }
  // No answer within the timeout counts too: a sandbox may drop the packets.
  const error = await loopback(host, timeoutMs);
  if (error) blocked.push({ access: 'loopback', host, error });
  return { ok: blocked.length === 0, blocked };
}
export const sandboxCheckName = 'commands can write outside the project and use loopback';
export function sandboxCheck(probe) {
  if (probe.ok) return { check: sandboxCheckName, ok: true };
  return { check: sandboxCheckName, ok: false, blocked: probe.blocked,
    detail: probe.blocked.map(b => b.access === 'write' ? `write ${b.path}: ${b.error}` : `loopback ${b.host}: ${b.error}`).join('; '),
    note: 'Usually a local sandbox (VS Code, Copilot CLI or the Copilot app). Phase 03 writes comparison B and the pilot outside the repository, and the reviewer-hook check uses loopback. Only the temporary directories are probed: a pilot target elsewhere needs the same access. Only the person changes sandbox settings: /sandbox off in that session, or allow what is blocked in the sandbox settings.' };
}
// The one setup question when the probe fails, in the report language: asked
// before phase 00 (and before the autopilot handoff), so phase 03 does not
// stop on it hours later.
export function sandboxQuestion(probe, language) {
  const dirs = [...new Set(probe.blocked.filter(b => b.access === 'write').map(b => b.path))];
  const loopback = probe.blocked.some(b => b.access === 'loopback');
  const ja = language === 'ja';
  const allow = ja
    ? (dirs.length && loopback ? '上のフォルダへの書き込みとローカル通信' : dirs.length ? '上のフォルダへの書き込み' : 'ローカル通信')
    : (dirs.length && loopback ? 'writing the folders above and local network access' : dirs.length ? 'writing the folders above' : 'local network access');
  const what = ja
    ? [dirs.length ? `リポジトリ外（${dirs.join('、')}）への書き込み` : '', loopback ? 'ローカル通信（127.0.0.1）' : ''].filter(Boolean).join('と')
    : [dirs.length ? `writes outside the repository (${dirs.join(', ')})` : '', loopback ? 'local network access (127.0.0.1)' : ''].filter(Boolean).join(' and ');
  // Blocked writes stop phase 03; blocked loopback only the reviewer-hook check.
  const effect = ja
    ? (dirs.length ? '工程 03 の比較の翻訳と試運転はプロジェクトの外のフォルダーに書くため、このままでは工程 03 で止まります（試運転のコピー先を一時フォルダーの外にするなら、そこへの書き込みも必要です）。' : '')
      + (loopback ? 'キットの安全チェックが動くかの確認（パソコン内の通信を使います）もできません。' : '')
    : (dirs.length ? 'Phase 03 writes its comparison and pilot outside the repository, so as things are it stops at phase 03 (a pilot target outside the temporary directory needs write access too). ' : '')
      + (loopback ? 'The doctor --check-cli reviewer-hook check (it uses local network access) cannot run either. ' : '');
  return ja ? {
    question: `このセッションのコマンドは${what}ができません（このセッションでサンドボックスという制限が有効なためと思われます）。${effect}どうしますか？ 設定を変えるのはあなたで、AI は変えません。`,
    choices: [
      { value: 'off', label: '制限をオフにする（推奨）。この質問のあと、このセッションのチャット入力欄に /sandbox off と入力して送り、続けて「続けて」と送る。良い点：すぐ進めます。注意点：このセッションのコマンドは制限なしで動きます' },
      { value: 'allow', label: `制限は使い続け、サンドボックスの設定で${allow}だけを許可してから「続けて」と送る（設定の手間はかかりますが、制限は残せます）` },
      { value: 'keep', label: dirs.length ? 'このまま進める（工程 03 の比較と試運転の前に、もう一度この判断が必要になります）' : 'このまま進める（キットの安全チェックの確認は失敗のままです）' }]
  } : {
    question: `Commands in this session cannot make ${what} (most likely a local sandbox is on). ${effect}What should happen? Only you change these settings, never the AI.`,
    choices: [
      { value: 'off', label: 'Turn it off (recommended): after this question, type /sandbox off yourself, then send "continue". Commands in this session then run without the sandbox\'s limits' },
      { value: 'allow', label: `Keep the sandbox, allow ${allow} in its settings, then send "continue"` },
      { value: 'keep', label: dirs.length ? 'Continue as is (the same decision comes back before the phase 03 comparison and pilot)' : 'Continue as is (the reviewer-hook check stays failed)' }]
  };
}
export const sandboxNext = 'The local sandbox check failed. Before anything else in this result (before autoHandoff, and before phase 00), ask sandboxQuestion as one question with its choices. On off or allow, end the turn; on the person\'s next message run doctor and confirm the check "commands can write outside the project and use loopback" passes (if it still fails, say what is still blocked and ask again). On keep, continue; when writes were blocked, say that phase 03 will need the same decision (a later settings apply during setup asks again while it fails). Choose the pilot target in phase 03 under an allowed directory. Never change sandbox settings yourself.';
