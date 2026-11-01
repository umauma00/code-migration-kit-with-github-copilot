// SPDX-License-Identifier: Apache-2.0
// Turns a runner failure into a user decision: what went wrong, what it blocks,
// and two or more choices with one recommendation and the reason for each.
// The catalog is presentation only. It never approves, edits or reruns anything;
// the parent shows it and waits for the user's real answer.
// Every rule offers at least two choices plus pause, with the recommendation
// first (tests/guidance-contract.test.mjs holds each rule to it).
import fs from 'node:fs';
import path from 'node:path';
import { kitScript, pythonCommand } from './runtime.mjs';
import { loadConfig, safePath } from './core.mjs';
import { readPreferences } from './preferences.mjs';
import { orderedPhases } from './phases.mjs';
import { migrationStatus } from './status.mjs';
import { hostStallPattern, hostStallRetries, networkFailurePattern, explicitAuthRejection, otherSystemicPattern } from './failures.mjs';

// Phases a person records after reviewing artifacts; the runner records the rest.
const manualPhases = new Set(['00', '00b', '01', '02', '03']);
// Source-only 05c is the person's recorded acknowledgment, not a runner stage.
const acknowledgedPhase = (id, config) => id === '05c' && config?.verificationMode === 'source-only';

const t = (ja, en) => ({ ja, en });
const pause = t('ここで中断する', 'Pause here'), pauseWhy = t('成果物と記録はディスクに残るため、後で同じコマンドから再開できます。', 'Artifacts and receipts stay on disk, so the same command resumes later.');
const investigate = (ja, en) => ({ id: 'investigate', label: t('詳細を調査する', 'Investigate the details'), reason: t(ja, en) });
const hasFile = (root, rel) => { try { return Boolean(root) && fs.statSync(safePath(root, rel)).isFile(); } catch { return false; } };

// An error names only the immediate predecessor. While an earlier phase is
// incomplete, recording that one fails the same way, so lead with the first
// incomplete phase exactly as `phase next` reports it.
function earlierIncomplete(root, named) {
  if (!root) return null;
  try {
    const report = migrationStatus(root), next = report.ok ? report.workflow?.next : null;
    return next && orderedPhases.indexOf(next) < orderedPhases.indexOf(named) ? next : null;
  } catch { return null; }
}

// Classification and protection are separate. Rules read the message as
// given; protection (below) never depends on which rule it gets.
//
// A credential check's own result, in English or Japanese, read on the whole
// message once clean phrases and the check's own name ("Secret scan:") are cut
// out:
// - candidate: a finding is left ("No credentials detected but possible
//   hardcoded password ...").
// - incomplete: the message names a credential check that failed, lacked
//   access or was skipped; "0 errors" and 「エラーなし」 are not failures.
// - clear: a clean phrase was found and nothing left names a credential.
// - unsure: something left names a credential ("... and credential check
//   returned X for b.py"). Unsure is never clean.
const noun = String.raw`(?:credentials?|secrets?|passwords?|passwd|api[ _-]?keys?|access[ _-]?tokens?|tokens?)`;
const result = String.raw`(?:candidates?|matches|match|findings?|hits?|leaks?)`;
const jaNoun = '(?:資格情報|認証情報|パスワード|シークレット|秘密情報|APIキー|アクセストークン|トークン)';
const verdict = String.raw`(?:found|detected|flagged|reported)`;
const cleanPhrase = new RegExp([
  String.raw`\b(?:no|zero)\s+(?:\w+\s+)?(?:${noun}|${result})\s+(?:were\s+|was\s+)?${verdict}\b`,
  String.raw`\bno\s+(?:\w+\s+)?${result}\b`,
  String.raw`\b0\s+(?:\w+\s+)?(?:${noun}|${result})\b(?:\s+${verdict})?`,
  String.raw`\b(?:none|nothing)\s+(?:was\s+|were\s+)?${verdict}\b`,
  String.raw`\b(?:found|detected|reported)\s+no\s+(?:\w+\s+)?(?:${noun}|${result}|issues?|problems?)\b`,
  String.raw`\bno\s+(?:issues?|problems?)(?:\s+(?:were\s+|was\s+)?${verdict})?\b`,
  String.raw`(?:^|:)\s*(?:none|clean|0|passed|pass|ok)\s*\.?\s*$`,
  String.raw`(?:${jaNoun}(?:は|が|も)?)?(?:(?:検出|検知|発見)されませんでした|見つかりませんでした|見つからなかった|(?:0|ゼロ)件|検出なし|該当なし|問題(?:は)?(?:なし|ありませんでした))`].join('|'), 'gim');
const checkName = String.raw`(?:\b(?:the\s+)?(?:local\s+)?(?:secrets?|credentials?|passwords?)[ -](?:scan|check|scanner)\b|(?:秘密情報|資格情報|認証情報|シークレット)の(?:検査|スキャン))`;
// The check's name alone, before a colon or a completion word, names no result.
const checkTitle = new RegExp(String.raw`${checkName}(?:\s+(?:complete|completed|finished|done|results?|report))?\s*(?:結果)?\s*(?:[:：]|$|(?=[,、]))`, 'gim');
const findingPhrase = new RegExp([
  String.raw`\b(?:literal|hard-?coded|possible|potential|suspected|exposed|leaked|plain-?text)\s+(?:\w+\s+)?${noun}\b`,
  String.raw`\b${noun}\b[^\n]{0,60}?\b(?:candidates?|suspected|detected|flagged|found|possible|potential)\b`,
  String.raw`\b[1-9]\d*\s+(?:\w+\s+)?(?:${noun}|${result})\b`, String.raw`[1-9]\d*\s*件`,
  String.raw`${jaNoun}[^\n]{0,30}?(?:候補|疑い|検出|検知|発見|見つかりました|見つかった|含まれ)`,
  String.raw`ハードコード[^\n]{0,20}?${jaNoun}`].join('|'), 'i');
const noFailure = /\b(?:no|zero|0)\s+(?:errors?|failures?|warnings?)\b(?:\s+(?:were\s+|was\s+)?reported)?|エラー(?:は)?(?:なし|ありませんでした|0件)|失敗(?:は)?(?:なし|ありませんでした)/gi;
const failurePhrase = /\b(?:fail(?:ed|s|ure)?|errors?|could not|couldn't|cannot|can't|unable|denied|no access|not permitted|permissions?|aborted|skipped|incomplete|not run|crash(?:ed|es)?|unreadable|partial(?:ly)?|truncated|interrupted|timed out|time-?out|expired|limit (?:reached|exceeded)|exit(?:ed)?(?: with)?(?: (?:code|status))? [1-9]\d*|only \d+ (?:of|out of) \d+|not (?:scanned|checked|completed?))\b|権限|失敗|できません|できなかった|読めな|エラー|中断|打ち切|未実施|スキップ|一部|タイムアウト|期限切れ/i;
// A bare "token" (token expired) is too common to count as a mention alone.
// "_" joins names (DB_PASSWORD, SECRET_KEY), so it does not end one here.
const credentialMention = /(?<![A-Za-z0-9])(?:credentials?|secrets?|passwords?|passwd|api[ _-]?keys?|access[ _-]?tokens?)(?![A-Za-z0-9])|資格情報|認証情報|パスワード|シークレット|秘密情報|APIキー|アクセストークン/i;
function credentialResult(message) {
  if (!credentialMention.test(message) && !new RegExp(checkName, 'i').test(message)) return null;
  const rest = message.replace(cleanPhrase, ' ');
  if (findingPhrase.test(rest)) return 'candidate';
  if (new RegExp(checkName, 'i').test(message) && failurePhrase.test(message.replace(noFailure, ' '))) return 'incomplete';
  if (rest !== message && !credentialMention.test(rest.replace(checkTitle, ' '))) return 'clear';
  return 'unsure';
}
const matcher = test => ({ [Symbol.match]: message => test(message) ? [message] : null });
// Unsure is a candidate when no other rule explains the message (password
// prompt timed out stays a timeout).
const credentialCandidate = matcher(message => ['candidate', 'unsure'].includes(credentialResult(message)));
const credentialIncomplete = matcher(message => credentialResult(message) === 'incomplete');
const credentialClear = matcher(message => credentialResult(message) === 'clear');
// Protection: a message that names a credential, assigns a password, secret or
// token value, or puts a value after a password switch (-P, /P, /RP, -pw,
// --password; not -p, which is often a port or mkdir -p) is never repeated,
// and every word of it is removed from whatever text a rule built from it
// (cause, labels, reasons, commands). Any characters count as a value.
// The key of an assignment matches in any case (TOKEN=, Password:); a switch
// keeps its case, since -p is not a password switch. A value is anything up to
// whitespace, or a quoted string.
const assignedValue = /(?<![A-Za-z0-9])((?:\w*_)?(?:password|passwd|pwd|secret|token|api[_-]?key)(?:_\w*)?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const switchValue = /((?:^|\s)(?:-P|\/[Pp]|\/RP|-pw|-pwd|--password)\s+)("[^"]*"|'[^']*'|(?![/-])\S+)/g;
// SQL clients take the password attached to the switch (sqlcmd -Pvalue, mysql -pvalue).
const attachedValue = /(\b(?:sqlcmd|bcp|osql|isql|mysql|mysqldump|mysqladmin)\b[^\n]*?\s-[Pp])([^\s-]\S*)/gi;
const valuesIn = message => [...message.matchAll(assignedValue), ...message.matchAll(switchValue), ...message.matchAll(attachedValue)].map(v => v[2].replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean);
const protect = message => message.replace(assignedValue, '$1***').replace(switchValue, '$1***').replace(attachedValue, '$1***');
const sensitive = message => credentialMention.test(message) || valuesIn(message).length > 0;
const withheld = { ja: '（値を含みうるため、メッセージは表示しません）', en: '(withheld: the message may hold the credential value)' };
// Removes a sensitive message's values from text a rule built: every value an
// assignment or switch carries, whatever its case or length, and the message's
// other uncommon words (with digits or capitals inside), each as a whole word.
const scrubber = message => {
  const values = valuesIn(message);
  const words = message.split(/[\s,;:=()'"`<>[\]{}、。：]+/).filter(w => w.length >= 3 && !/^(?:[a-z]+|[A-Z][a-z]+)$/.test(w));
  const all = [...new Set([...values, ...words])].sort((a, b) => b.length - a.length);
  const escape = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text => all.reduce((out, w) => out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(w)}(?![\\p{L}\\p{N}_])`, 'gu'), '***'), text);
};

// First matching rule wins; order from specific to generic.
const rules = [
  // doctor ends a probe that gets no answer (scripts/run_migration.mjs doctorStallDetail).
  { id: 'doctor-stall', match: /Doctor check "([^"]+)" did not finish within ([\d.]+) s/,
    cause: m => t(`キットの確認（doctor）の「${m[1]}」が ${m[2]} 秒たっても終わりませんでした。Copilot CLI が通信の応答を待ち続けています。会社のプロキシが応答しない、サインインが入力待ち、ネットワークが遮断されている、のどれかがよくある原因です。`,
      `Doctor check "${m[1]}" did not finish within ${m[2]} s: the Copilot CLI kept waiting for an answer. A proxy that does not respond, a sign-in waiting for input, or a blocked network are the usual causes.`),
    impact: t('この確認と、同じ通信を使うそのあとの Copilot CLI の確認はできていません。キットは何も変更していません。', 'This check, and the later Copilot CLI checks that need the same connection, did not finish. The kit changed nothing.'),
    options: [
      { id: 'check-network', label: t('AI と一緒にプロキシの設定（HTTPS_PROXY・NO_PROXY）と Copilot CLI のサインイン状態を確かめ、直してから確認をやり直す', 'Check the proxy settings (HTTPS_PROXY, NO_PROXY) and the Copilot CLI sign-in with the AI, fix them, then rerun the check'),
        command: k => `node ${k}/scripts/run_migration.mjs doctor --check-cli`,
        reason: t('Copilot CLI が通信できないと、AI を使う工程も同じところで止まります。先に通信を直すのが確実です。サインインや会社のプロキシの設定は、あなたの操作や確認が必要なことがあります。単に遅いだけなら、やり直すと通ることもあります。', 'If the CLI cannot connect, phases that use AI stop at the same place, so fixing it first is the sure way. A sign-in or a corporate proxy setting may need you. If the CLI was only slow, a rerun may pass.') },
      { id: 'skip-cli-check', label: t('Copilot CLI の確認を省き、キットの設定だけを確認する', 'Skip the CLI checks and check only the kit settings'), command: k => `node ${k}/scripts/run_migration.mjs doctor`,
        reason: t('設定の確認はすぐ終わります。CLI の問題は残るため、AI を使う工程で同じ原因で止まることがあります。', 'The settings check finishes quickly. The CLI problem remains, so a phase that uses AI may stop for the same reason.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // A refused confirmation or a question the host answered by itself
  // (autopilot) is never the person's answer, whatever command it carried.
  // A worker CLI's own failure output is a worker failure (worker-output).
  { id: 'cannot-ask', match: /^(?![\s\S]*Copilot \S+ failed \(exit)[\s\S]*(?:unable to ask (?:the )?user|user is not available to respond)/i,
    cause: t('このセッションはあなたに確認できません（autopilot や非対話の実行）。ホストが確認を自動で拒否したか、質問に自動で応答しました。',
      'This session cannot ask you (autopilot or a non-interactive run): the host refused the confirmation or answered the question by itself.'),
    impact: t('承認・選択は行われていません。自動の応答はあなたの回答ではないため、何も選んでいません。', 'No approval or choice was made. An automatic reply is not your answer, so nothing was chosen.'),
    options: [
      { id: 'interactive', label: t('自動で進めるモード（autopilot）をやめ、質問に答えられる状態で同じ操作をやり直す', 'Leave autopilot and retry the same step in an interactive session'),
        reason: t('承認・記録・設置はあなたの行為なので、ホストがあなたに確認できるセッションでだけ進められます。', 'Approvals, records and installs are your acts, so they proceed only where the host can ask you.') },
      { id: 'answer-in-chat', label: t('承認の操作ではない選択なら、チャットで選択肢の番号を返信して答える', 'For a choice that is not a gate command, answer in chat with the option number'),
        reason: t('質問ツールが使えなくても、チャットの返信はあなたの回答です。承認・完了・設置のコマンドはホストの確認が要るため、対話セッションが必要です。', 'Your chat reply is an answer even without the question tool. Approve, complete and install commands still need the host confirmation, so they need an interactive session.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // lib/cli.mjs refuses a mistyped command line before anything runs.
  { id: 'command-line', match: /^(?:Unknown option --|Missing value for --|Option --\S+ does not apply to |Unexpected [\s\S]* Add --help for usage|Missing action for |Unknown command |Missing command\. |\S+(?: \S+)? needs (?:ID|STAGE)|--\S+ must be one of |\S+(?: \S+)? (?:ID|STAGE)\S* must be one of |Write --\S+ VALUE as two words)/,
    cause: t('コマンドの書き方（サブコマンド・オプション・値）が runner の仕様と合っていません。', 'The command line (action, option or value) does not match what the runner accepts.'),
    impact: t('コマンドは実行されていません。ファイルも記録も変わっていません。', 'Nothing ran; no file or record changed.'),
    options: [
      { id: 'fix-command', label: t('AI が正しい使い方を確認し、同じ操作をやり直す', 'Check the usage with --help and rerun the same step written correctly'),
        command: k => `node ${k}/scripts/run_migration.mjs --help`,
        reason: t('エラーに受け付けるオプションが示されています。書き方を直せば、そのまま続けられます。', 'The error lists the accepted options; with the command corrected, the step continues as planned.') },
      { id: 'report-doc', label: t('手順書・プロンプトに書かれたコマンドが誤っていれば、その箇所を報告する', 'If a guide or prompt gave the wrong command, report where'),
        reason: t('キットの文書のコマンドはテストで照合していますが、漏れがあれば直す必要があります。', 'The kit tests the commands in its documents; a miss needs fixing at the source.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'guardrails', match: /guardrails (?:are invalid|deny nothing)|requires human-installed command guardrails/,
    cause: t('03/04は、人間が設置したコマンド制限（migration/guardrails.json）が必要です。未設置・不正・空のいずれかです。',
      'Phases 03/04 need human-installed command guardrails (migration/guardrails.json); the file is missing, invalid or empty.'),
    impact: t('試行・本番変換を開始できません。', 'The stress test and production translation cannot start.'),
    options: [
      { id: 'install-guardrails', label: t('AI が提案する禁止リストに合意し、設置コマンドの確認ダイアログで許可する', 'Agree the deny list the AI proposes, then allow the install command when the host asks'),
        command: k => `node ${k}/scripts/run_migration.mjs guardrails show`,
        reason: t('上流の deny ルールと同じ保護です。設置は人間の判断なので、AI は提案と `guardrails install` の実行だけを行い、ホストがあなたに確認を求めます。ファイルを直接作ることはありません。', 'It is the upstream deny-rule protection. Installing it is the human\'s decision: the AI only proposes and runs `guardrails install`, which the host asks you to confirm; it never writes the file directly.') },
      { id: 'waive-guardrails', label: t('禁止リストを使わない理由を記録して、リストなしで進める', 'Record a waiver with the reason (guardrails install --waiver)'),
        reason: t('使い捨て環境などで制限が不要な場合だけ。誤ったgit操作や重いビルドを防げなくなります。', 'Only for disposable environments; destructive git and heavy builds are no longer blocked.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // The kit's own hook denials (lib/guardrails.mjs): the design working, not a fault.
  // The deny list holds two kinds of command (upstream rule 5): version control
  // that rewrites history or the working tree, and builds and tests, which the runner runs.
  { id: 'guardrail-denied', match: /"([^"]+)" is denied by migration\/guardrails\.json/,
    context: m => ({ vcs: /^git\b/.test(m[1]) }),
    cause: (m, x) => x.vcs
      ? t(`履歴や作業ツリーを書き換える「${m[1]}」は、合意したコマンド制限（migration/guardrails.json）で禁止されています。設計どおりの停止で、故障ではありません。`,
        `"${m[1]}" rewrites version control and is denied by the agreed command guardrails (migration/guardrails.json). This is the design working, not a fault.`)
      : t(`「${m[1]}」は、合意したコマンド制限（migration/guardrails.json）で禁止されています。設計どおりの停止で、故障ではありません。`,
        `"${m[1]}" is denied by the agreed command guardrails (migration/guardrails.json). This is the design working, not a fault.`),
    impact: t('そのコマンドは実行されていません。成果物と記録は変わっていません。', 'The command did not run; artifacts and receipts are unchanged.'),
    options: [
      { id: 'keep-history', when: (m, c, x) => x.vcs,
        label: t('この操作は実行せず、何のための操作か（取り消し・差分の確認など）を確かめて、履歴を書き換えない方法で進める', 'Do not run it: confirm what it was for (undo, inspect a diff...) and proceed without rewriting history'),
        command: () => 'git status --short',
        reason: t('移行中は、履歴や作業ツリーを書き換えると、レビュー済みの記録や承認がやり直しになります。git status は読み取りだけで、今の状態を確かめられます。', 'Rewriting history or the working tree during the migration voids reviewed receipts and approvals. git status only reads, so it shows the current state safely.') },
      { id: 'use-runner', when: (m, c, x) => !x.vcs, label: t('ビルドやテストは、キットの決まった段階で承認の後に実行する', 'Run builds and tests as runner stages (build / smoke / parity) after their approval'),
        command: k => `node ${k}/scripts/run_migration.mjs status --format markdown`,
        reason: t('runner は設定したコマンドを1ラウンドに1回だけ実行し、結果を記録に残します。status が次に必要な承認と実行を示します。', 'The runner runs the configured commands once per round and records the result; status shows the approval or run needed next.') },
      { id: 'revise-guardrails', label: t('禁止リストがこの案件に合わないなら見直す（AI が案を出し、あなたが合意したら登録します。登録時に確認画面が出ます）', 'If the deny list does not fit this project, revise it (the AI proposes, then runs guardrails install after your agreement; the host asks you to confirm)'),
        command: k => `node ${k}/scripts/run_migration.mjs guardrails show`,
        reason: t('制限の変更はあなたの判断です。AI はコマンドを言い換えたり別の経路で実行したりして制限を迂回しません。', 'Changing the guardrails is your decision; the AI never rewords or reroutes a command to get around them.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'guardrails-write', match: /guardrails\.json is the human's decision|guardrails\.json の設置・変更は人間の判断/,
    cause: t('migration/guardrails.json（またはそれに当たる migration/* などのパターン）を書き換えうるコマンドとして拒否されました。コマンド制限の設置・変更は人間の判断です。拒否文の「該当した語」が判定の理由です。', 'A command that may write migration/guardrails.json (or a pattern that matches it, such as migration/*) was refused: installing or changing the command guardrails is the human\'s decision. The "Matched" word in the refusal is why.'),
    impact: t('ファイルは変更されていません。今の制限がそのまま有効です。', 'The file was not changed; the current guardrails stay in force.'),
    options: [
      { id: 'propose-guardrails', label: t('AI が禁止リスト（または使わない理由）をチャットで提案し、あなたが合意したら登録する（登録時に確認画面が出ます）', 'Let the AI propose the deny list (or a waiver) in chat and run guardrails install after your agreement (the host asks you to confirm)'),
        command: k => `node ${k}/scripts/run_migration.mjs guardrails show`,
        reason: t('設置・変更の経路はこれだけです。あなたの合意とホストでの確認が、人間による設置になります。', 'This is the only way to install or change them; your agreement and the host confirmation are the human act.') },
      { id: 'split-command', label: t('変更するつもりがなかった場合: 該当した語を外すか、その部分を別のコマンドに分けて実行し直す', 'If no change was meant: drop the matched word, or run that part as a separate command'),
        reason: t('依存宣言の生成など本来の作業は guardrails.json に触れません。同じ行の確認用コマンド（migration/* の一覧など）が拒否の原因なら、分ければ通ります。', 'The real work (generating the dependency map, for example) does not touch guardrails.json. When a checking command on the same line (listing migration/*, say) caused the refusal, splitting it lets the work through.') },
      { id: 'keep-guardrails', label: t('変更せず、今の制限のまま続ける', 'Keep the current guardrails and continue'),
        reason: t('変更が不要なら、何もする必要はありません。拒否によってファイルは守られています。', 'If no change is needed, nothing has to happen; the refusal kept the file intact.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'phase-order', match: /Phase (\w+)(?: is not reviewed for current inputs|'s record is out of date)/,
    context: (m, { root }) => ({ first: earlierIncomplete(root, m[1]) }),
    cause: (m, x) => x.first
      ? t(`工程 ${m[1]} より前の工程 ${x.first} が未完了です。工程は順番に記録するため、${m[1]} を先に記録することはできません。`, `Phase ${x.first}, before ${m[1]}, is not complete. Phases are recorded in order, so ${m[1]} cannot be recorded first.`)
      : t(`前の工程 ${m[1]} のレビュー記録がない、または入力が変わって失効しています。`, `Phase ${m[1]} has no review record for the current inputs (missing, or invalidated by a change).`),
    impact: t('後の工程は、前の工程を飛ばして進めません。', 'Later phases cannot skip an unreviewed earlier phase.'),
    // Options act on the first incomplete phase when it comes earlier, else on the named one.
    options: [
      { id: 'go-first', when: (m, c, x) => Boolean(x.first),
        label: (m, x) => t(`最初の未完了の工程 ${x.first} に戻り、そこから順に進める`, `Go back to the first incomplete phase, ${x.first}, and continue in order`),
        command: k => `node ${k}/scripts/run_migration.mjs phase next`,
        reason: (m, x) => t(`phase next も ${x.first} を返します。その工程の手順に従い、既にある成果物は確認の材料にします。`, `phase next reports ${x.first} too. Follow that phase's prompt and use existing artifacts as evidence to review.`) },
      // The note is never pre-filled: it must say what the person actually reviewed.
      { id: 'review-previous', when: (m, c, x) => manualPhases.has(x.first ?? m[1]),
        label: (m, x) => t(`工程 ${x.first ?? m[1]} の成果物をあなたが確認し、確認した内容を書いて完了を記録する`, `Review phase ${x.first ?? m[1]} artifacts yourself, then record its completion with what you checked`),
        command: (k, m, x) => `node ${k}/scripts/run_migration.mjs phase complete ${x.first ?? m[1]} --note "<確認した内容 / what you reviewed>"`,
        reason: t('工程の順番は承認と完了判定の前提です。記録はあなたの確認の後にだけ行います。', 'Phase order underpins approvals and completion; the record follows your review, never precedes it.') },
      { id: 'acknowledge-unverified', when: (m, c, x) => acknowledgedPhase(x.first ?? m[1], c),
        label: t('元のコードを動かせない方式なので新旧の動作比較はできないと確認し、「同じ動きかは未確認」と記録して進める', 'Acknowledge that source-only mode runs no parity, and record 05c as equivalence unverified'),
        command: k => `node ${k}/scripts/run_migration.mjs phase complete 05c --note "<確認した内容 / what you acknowledged>"`,
        reason: t('source-only の引き継ぎには、動作の同等性が未検証のままであることへのあなたの確認が必要です。', 'A source-only handoff needs your acknowledgment that behavioral equivalence stays unverified.') },
      { id: 'finish-runner-phase', when: (m, c, x) => !manualPhases.has(x.first ?? m[1]) && !acknowledgedPhase(x.first ?? m[1], c),
        label: (m, x) => t(`工程 ${x.first ?? m[1]} をキットの実行機能で実行・確認し直す`, `Run and validate phase ${x.first ?? m[1]} through the runner again`),
        command: k => `node ${k}/scripts/run_migration.mjs status --format markdown`,
        reason: t('この工程は手作業の記録ではなく、runner の実行結果で完了になります。status が次に必要な承認・実行を示します。', 'This phase completes from runner results, not a manual record; status shows the approval or run it needs.') },
      { id: 'bundle-spec', when: (m, c, x) => c?.preparationProfile === 'source-as-spec' && ['00b', '01', '02'].includes(x.first ?? m[1]),
        label: t('生成した仕様一式（00b〜02）をあなたが確認し、まとめて記録する', 'Review the generated specification package (00b–02) yourself and record it together'),
        command: k => `node ${k}/scripts/run_migration.mjs phase complete 00b,01,02 --note "<確認した内容 / what you reviewed>"`,
        reason: t('source-as-spec では仕様一式を1回で確認できます。不足があればどの工程も記録されません。', 'Source-as-spec reviews the package once; if anything is missing, no phase is recorded.') },
      { id: 'redo-phase', when: (m, c, x) => !x.first, label: m => t(`工程 ${m[1]} に戻り、成果物を作り直す・修正する`, `Return to phase ${m[1]} and redo or revise its artifacts`),
        reason: t('入力の変更で記録が失効した場合や、成果物に問題がある場合はこちらです。', 'Choose this when an input change invalidated the record or the artifacts need work.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // Setup's fifth answer, or the source-as-spec switch it calls for, is still
  // open when phase 00 is started: the step is known, so it comes first.
  { id: 'setup-unfinished', match: /^Setup is not finished: (?:the original does not run|there is no specification)/,
    cause: t('初期設定がまだ終わっていません。現行を動かせない場合の検証方式（仕様書の有無と、無いときの source-as-spec への切り替え）が決まっていません。',
      'Setup is not finished: with an original that does not run, the verification method (whether a specification exists, and the source-as-spec switch without one) is not settled.'),
    impact: t('工程 00 は記録されていません。ファイルも記録も変わっていません。', 'Phase 00 was not recorded; no file or record changed.'),
    options: [
      { id: 'answer-specification', when: m => /the original does not run/.test(m[0]), label: t('仕様書・移行先でも使える自動テストの有無に答える', 'Answer whether a specification or a test suite the target can use exists'),
        command: k => `node ${k}/scripts/run_migration.mjs settings init`,
        reason: t('settings init が質問（specificationQuestion）を返します。答えを preferences --specification で記録し、settings apply の next に従うと工程 00 に進めます。', 'settings init returns the question (specificationQuestion); record the answer with preferences --specification and follow the next of settings apply to reach phase 00.') },
      { id: 'switch-source-as-spec', when: m => /there is no specification/.test(m[0]), label: t('元のコードだけを仕様として扱う方式に切り替えてから、最初の工程を始める', 'Switch to source-as-spec, then start phase 00'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec init`,
        reason: t('変更内容を確認してから source-spec init --apply で切り替えます（ホストが1回確認します。自動モードでは確認なし）。', 'Review the changes, then switch with source-spec init --apply (the host asks once; not in auto mode).') },
      { id: 'correct-answer', label: t('前の答えが違っていれば直す（現行を動かせる／仕様書がある）', 'Correct an earlier answer if it was wrong (the original runs, or a specification exists)'),
        command: k => `node ${k}/scripts/run_migration.mjs preferences --original-runtime available`,
        reason: t('現行を動かせるなら preferences --original-runtime available、仕様書や使えるテストがあるなら preferences --specification available で記録し直すと、この確認は不要になります。', 'If the original runs, record preferences --original-runtime available; if a specification or usable tests exist, record preferences --specification available. Either makes this step unnecessary.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'runtime-judge', match: /Prepare runtime judge inputs and original\/mutation\/parity commands|Configure commands\.(original|mutation|parity)/,
    cause: t('runtime方式は、現行実装を実際に動かす比較コマンド（original / mutation / parity）が必要ですが、設定されていません。',
      'Runtime mode needs commands that actually run the original (original / mutation / parity), and they are not configured.'),
    impact: t('比較テストの準備（00b）を完了できません。', 'Judge preparation (00b) cannot be completed.'),
    // The right choice depends on a fact only the person knows: can the
    // original still run? preferences --original-runtime records the answer.
    order: ctx => ctx.originalRuntime === 'unavailable' ? ['switch-source-as-spec', 'configure-runtime', 'pause']
      : ctx.originalRuntime === 'available' ? ['configure-runtime', 'switch-source-as-spec', 'pause']
      : ['answer-runtime', 'configure-runtime', 'switch-source-as-spec', 'pause'],
    options: [
      // An answer comes first, so there is no command to run yet.
      { id: 'answer-runtime', label: t('まず「現行の実行環境をここで動かせるか」を答える（答えで推奨が決まります）', 'First answer whether the original can still run here (it decides the recommendation)'),
        reason: t('動かせるなら新旧比較で同等性を実証でき、動かせないならソースを仕様にする方式が適切です。推測では選びません。答えは preferences --original-runtime available（動かせなければ unavailable）で記録します。',
          'If it runs, parity proves equivalence; if not, the source-as-spec profile fits. The kit does not guess; the answer is recorded with preferences --original-runtime available (or unavailable).') },
      { id: 'configure-runtime', label: t('元のコードを動かして新旧を比べる手順を設定する', 'Configure the original-runtime commands (original / mutation / parity)'),
        reason: t('現行を動かせる場合はこちら。新旧の動作同等性を実際に検証でき、上流キットと同じ品質保証になります。', 'Choose this when the original runs: equivalence is verified for real, as in the upstream kit.') },
      { id: 'switch-source-as-spec', label: t('元のコードだけを仕様として扱う方式に切り替える', 'Switch to the source-as-spec profile'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec init`,
        reason: t('現行を動かせない・仕様書がない場合はこちら。ソースから契約とルールを作り、確認後に変換へ進めます。動作同等性は未検証として引き継ぎます。', 'Choose this when the original cannot run or no spec exists; equivalence is handed off as unverified.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'source-plan', match: /Source-only judge plan requires|Source-only scenarios require|Invalid (?:scenario|source) input path|Missing (?:or empty )?(?:scenario|source) input|judge-plan\.json/,
    cause: t('source-only方式の準備記録（migration/judge-plan.json）が不足または不正です。', 'The source-only preparation record (migration/judge-plan.json) is missing or invalid.'),
    impact: t('00bを完了できず、正式なjudge検証も実行できません。', '00b cannot complete and formal judge validation cannot run.'),
    options: [
      { id: 'draft-spec', label: t('ソースから準備記録の下書きを作る', 'Draft the plan from the source'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec init`,
        reason: t('全ソースを列挙した judge-plan とソース一覧を機械的に作ります。記入が必要な契約メモはありません。既存ファイルは上書きしません。', 'Mechanically lists every source file in a judge-plan and a source index; there is no contract memo to fill. Existing files are kept.') },
      { id: 'edit-plan', label: t('テストの計画ファイル（元のコードから読み取った期待する動き）を手で直す', 'Fix judge-plan.json by hand'), reason: t('既に計画がある場合。エラーが示す項目だけを修正します。', 'If a plan already exists, fix only the field named in the error.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'spec-placeholder', match: /contracts still contain TODO\(spec\)/,
    cause: t('judge-plan のシナリオ（0.10.0 より前に作った契約メモ migration/source-spec/contracts.md など）に未記入の TODO(spec) が残っています。', 'A judge-plan scenario (such as the pre-0.10.0 contract memo migration/source-spec/contracts.md) still contains unfilled TODO(spec) items.'),
    impact: t('雛形のままでは仕様として承認できないため、00b を記録していません。', 'A skeleton is not a specification, so 00b was not recorded.'),
    options: [
      { id: 'fill-contracts', label: t('各ファイルの公開インターフェース・入出力・エラー・境界条件を、ソースの行番号付きで記入する', 'Fill each file\'s interface, inputs/outputs, errors and edge cases with cited source lines'),
        reason: t('ソースが唯一の仕様なので、ここが変換・レビューの判断基準になります。AIが下書きし、あなたが確認します。', 'The source is the only specification, so this is what translation and review are judged against; the AI drafts and you review.') },
      { id: 'mark-unknown', label: t('元のコードから判断できない項目は「不明」と書き、あとで決める項目として残す', 'Write "unknown" for items the source cannot decide and keep them as TODO(port)'),
        reason: t('推測で埋めるより、不明として残す方が後で検索・確認できます（上流ルール8）。', 'An explicit unknown is searchable later, unlike a guess (upstream rule 8).') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'outside-roots', match: /(?:Source|Target) outside (?:sourceRoots|outputRoots): (\S+)/,
    cause: m => t(`manifest に移行対象外のファイル（${m[1]}）が含まれています。依存解析がキットや管理ファイルまで拾った可能性があります。`, `The manifest contains ${m[1]}, which is outside the configured roots; the dependency parser may have scanned kit or metadata files.`),
    impact: t('manifest と依存宣言を確定できません。', 'The manifest and dependency declaration cannot be finalized.'),
    options: [
      { id: 'regenerate', label: t('ファイル同士のつながりの調べ直しを、移行するファイルだけに絞ってやり直す', 'Rerun the parser on the source roots only and regenerate depmap and manifest'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec check`,
        reason: t('解析結果から機械的に作り直せば、手作業の除外漏れが起きません。check が推奨コマンドを表示します。', 'Regenerating mechanically avoids manual omissions; check prints the suggested commands.') },
      { id: 'fix-roots', label: t('そのファイルも本当に移行するなら、移行するフォルダーの範囲を広げる', 'If the file really belongs to the migration, widen sourceRoots / outputRoots'),
        reason: t('設定変更は承認をやり直す必要があります。', 'Changing config restarts approvals.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'input-root', match: /(?:Judge input root|Input root) missing: (\S+) \((sourceRoots|verificationRoots)/,
    cause: m => t(`migration/config.json の ${m[2]} にある ${m[1]} がこのリポジトリに存在しません${m[2] === 'verificationRoots' ? '（"tests" は導入時の仮の値です）' : ''}。`,
      `${m[1]}, listed in ${m[2]} of migration/config.json, does not exist in this repository${m[2] === 'verificationRoots' ? ' ("tests" is only the installer\'s default)' : ''}.`),
    impact: t('入力の指紋を計算できないため、この操作は完了していません。', 'The input fingerprint cannot be computed, so this operation did not complete.'),
    options: [
      { id: 'fix-roots', label: m => t(`${m[2]} を実在するディレクトリに直す（AIがリポジトリを見て直します）`, `Point ${m[2]} at the existing directory (the AI fixes it from the repository layout)`),
        reason: t('設定の書き間違いなら、直して同じコマンドを再実行すれば続きから進みます。', 'If the path is just wrong, fixing it and rerunning the same command continues the work.') },
      { id: 'source-as-spec', when: (m, c) => m[2] === 'verificationRoots' && c?.verificationMode !== 'source-only', label: t('元のコードを動かせず比較用のテストもないなら、元のコードだけを仕様として扱う方式に切り替える', 'If the original cannot run and no tests exist, switch to source-as-spec (no verificationRoots needed)'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec init`, reason: t('source-only の方式では比較テストのディレクトリがなくても進められます。', 'Source-only modes proceed without a test directory.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'artifact', match: /(?:Nonempty phase artifact required|Required artifact missing|Review artifact required): (\S+)/,
    cause: m => t(`必要な成果物 ${m[1]} がない、または空です。`, `Required artifact ${m[1]} is missing or empty.`),
    impact: t('この工程の完了を記録できません。', 'This phase cannot be recorded as complete.'),
    options: [
      { id: 'create-artifact', label: m => t(`${m[1]} を作成・記入してから再実行する`, `Write ${m[1]}, then retry`),
        reason: t('完了記録は実在する成果物のハッシュに結び付くため、成果物が先に必要です。', 'Completion receipts bind to real artifact hashes, so the artifact must exist first.') },
      investigate('どの工程がこの成果物を作るかを確認します（工程表：docs/ORDERED-WORKFLOW.md）。', 'Check which phase produces it (docs/ORDERED-WORKFLOW.md).'),
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'no-dependencies', match: /declares no dependencies between (\d+) manifest files/,
    cause: m => t(`依存宣言で、${m[1]} 個のファイルの間に依存が1件もありません。依存解析の --root がずれて import を解決できなかった可能性が高いです。`, `The dependency map declares no dependencies between ${m[1]} files. The parser most likely ran from the wrong --root and could not resolve imports.`),
    impact: t('このままだと、レビュー担当に依存先のソースが渡らず、変換の順序も崩れるため、01 を記録していません。', 'Reviewers would not see dependency sources and the order would be wrong, so 01 was not recorded.'),
    options: [
      { id: 'rerun-parser', label: t('ファイル同士のつながりと変換対象の一覧を、キットの手順で作り直す', 'Regenerate the map, manifest and declarations with the commands from source-spec check'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec check`,
        reason: t('Python は --root を「import の起点」に合わせる必要があります（src 配置なら src、ソースルート自体がパッケージならその親）。check がそれを判定し、パスを戻す --prefix も付けます。', 'Python needs --root at the import base (src for a src layout, the parent when the source root is a package); check picks it and adds --prefix to restore paths.') },
      { id: 'confirm-independent', label: t('本当に互いに依存しないファイルだけなら、そのことを確認して記録する', 'If the files truly do not depend on each other, confirm it and record'),
        command: k => `node ${k}/scripts/run_migration.mjs phase complete 01 --confirm-no-dependencies --note "<確認した内容 / what you reviewed>"`,
        reason: t('独立したスクリプト群などでは正しい状態です。確認したことは記録に残ります。', 'Correct for independent scripts; the confirmation is recorded.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'template-rules', match: /(RULEBOOK\.md is still the installed template|inventory\.tsv still contains the template example rows)/,
    cause: m => t(m[1].startsWith('RULEBOOK') ? 'RULEBOOK が導入時の雛形のままです（[source language] などの置き換え前の箇所が残っています）。' : 'inventory に雛形の例の行が残っています。',
      m[1].startsWith('RULEBOOK') ? 'RULEBOOK is still the installed template ([source language] placeholders remain).' : 'The inventory still contains the template example rows.'),
    impact: t('雛形は「この案件のルール」ではないため、02 を記録していません。そのまま変換すると、全ファイルが方針なしで訳されます。', 'A template is not this project\'s rules, so 02 was not recorded; translating now would follow no project policy.'),
    options: [
      { id: 'draft-rules', label: t('元のコードの調査結果から、変換ルールと要注意箇所の一覧を書く（AI が下書きし、あなたが確認）', 'Write RULEBOOK and inventory from the source survey (the AI drafts, you review)'),
        reason: t('RULEBOOK は全担当の判断基準です。ここで決めた方針が全ファイルに一貫して適用されます（上流キットの中心）。', 'The rulebook is every worker\'s reference; deciding it once keeps every file consistent (the core of the upstream kit).') },
      { id: 'source-as-spec', label: t('元のコードを動かせず仕様書もないなら、元のコードだけを仕様とする方式で準備の工程をまとめて進める', 'Without a runnable original or spec, draft 00b–02 together with source-as-spec'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec check`, reason: t('不足している成果物と作り方を一覧で確認できます。', 'Lists the missing artifacts and how to produce them.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'untrusted-folder', match: /Repository hooks are not loaded: the Copilot CLI folder is untrusted/,
    cause: t('Copilot CLI がこのフォルダを信頼していないため、キットの hook（コマンド制限・承認の確認・ガードレール保護）が読み込まれません。', 'The Copilot CLI does not trust this folder, so the kit hooks (command guardrails, approval confirmation, guardrails-file protection) are not loaded.'),
    impact: t('このままでは、制限や承認の確認が黙って無効になります。', 'Guardrails and approval confirmation are silently off.'),
    options: [
      { id: 'trust-folder', label: t('このフォルダーで Copilot を一度起動し、「このフォルダーを信頼する」を選ぶ', 'Start copilot interactively in this repository and trust the folder'), command: () => 'copilot',
        reason: t('一度信頼すれば、以降の CLI セッションで hook が読み込まれます。', 'Once trusted, later CLI sessions load the hooks.') },
      { id: 'plugin-layout', label: t('キットをプラグインとして入れ直す（フォルダーの信頼に関係なく安全チェックが動きます）', 'Use the plugin layout (plugin hooks load regardless of folder trust)'),
        reason: t('信頼の設定を変えられない環境向け。導入方式の変更なので承認をやり直します。', 'For environments where trust cannot be granted; changing layout restarts approvals.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'model-tools', match: /^(?:Model tools: (\S+) under the kit's flags lacks|Comparison B: model (\S+) has no file-writing tool)/,
    cause: t('選んだモデルには、この Copilot CLI で、その役割に必要なファイル操作ツールがありません。モデルの系統ごとにツールが違います（例：CLI 1.0.105 の gpt-6-luna は create/edit が無く apply_patch で書きます）。', 'The chosen model has no file tool this role needs in this Copilot CLI. Model families have different tools (for example, on CLI 1.0.105 gpt-6-luna has no create/edit and writes with apply_patch).'),
    impact: t('この役割はファイルを読めない・検索できない・書けないため、正しく動きません。', 'The role cannot read, search or write files, so it cannot do its work.'),
    options: [
      { id: 'other-model', label: m => t(`この役割のモデルを、ツールがそろう別のモデルに変える（${m[1] ?? m[2]}）`, `Choose another model with the tools for this role (${m[1] ?? m[2]})`), command: k => `node ${k}/scripts/run_migration.mjs models list --format markdown`,
        reason: t('すぐに進められます。変えたあと doctor --check-cli で確認します。', 'Unblocks right away; confirm with doctor --check-cli afterwards.') },
      { id: 'update-kit', label: t('キットを更新する（新しいモデルのツール名に対応した版があれば）', 'Update the kit (a release may support this model\'s tool names)'),
        reason: t('同じモデルを使い続けたい場合。', 'If you want to keep this model.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'local-sandbox', match: /^Local sandbox blocks kit commands: (.*)/,
    cause: t('このセッションのコマンドは、リポジトリ外への書き込みかローカル通信（127.0.0.1）ができません。多くの場合、VS Code・Copilot CLI・Copilot アプリのローカル sandbox が有効なためです（コンテナの読み取り専用 /tmp やセキュリティソフトでも起こります）。', 'Commands in this session cannot write outside the repository or use local network access (127.0.0.1). Usually a local sandbox in VS Code, the Copilot CLI or the Copilot app is on (a read-only /tmp in a container or security software can do the same).'),
    impact: t('止められた内容に応じて、工程 03 の比較試験 B と pilot（リポジトリ外に書きます）や、doctor --check-cli の reviewer hook 検査（ローカル通信を使います）ができません。キットは sandbox の設定を変えません。', 'Depending on what is blocked, phase 03 comparison B and the pilot (they write outside the repository) or the doctor --check-cli reviewer-hook check (it uses local network access) cannot run. The kit never changes sandbox settings.'),
    options: [
      { id: 'sandbox-off', label: t('このセッションのチャット入力欄に /sandbox off と入力して制限をオフにしてから、同じ操作をやり直す', 'Type /sandbox off in this session, then retry the same step'), command: () => '/sandbox off',
        reason: t('いちばん確実です。オフにするとこのセッションのコマンドは sandbox の制限なしで動くため、信頼できるリポジトリでだけ行ってください。', 'The most reliable choice. Commands in this session then run without the sandbox\'s limits, so do it only in a repository you trust.') },
      { id: 'sandbox-allow', label: m => t(`サンドボックスの制限は使い続け、その設定で止められたものだけを許可する（${m[1]}）`, `Keep the sandbox and allow what is blocked in its settings (${m[1]})`),
        reason: t('sandbox を使い続けたい場合。許可したあと doctor で確認します。', 'If you want to keep the sandbox. Confirm with doctor afterwards.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'models-unset', match: /Set an available model ID for models\.(\S+)/,
    cause: m => t(`ワーカーのモデルがまだ選ばれていません（${m[1]} など）。`, `The worker models are not chosen yet (${m[1]} and possibly others).`),
    impact: t('翻訳・レビューの担当を起動できず、工程のコマンドも止まります。doctor はモデルなしでも残りを確認します。', 'Workers cannot start and the phase commands stop; doctor checks everything else without them.'),
    options: [
      { id: 'choose-models', label: t('使えるモデルの一覧を表示し、全担当のモデル・エフォート・コンテキストを1回の回答で選ぶ', 'List the available models and choose every role\'s model, effort and context in one answer'), command: k => `node ${k}/scripts/run_migration.mjs models list --format markdown`,
        reason: t('一覧はアカウントのCopilotから取得します（サインインが必要）。回答は models set --assign でまとめて記録します。', 'The list comes from your Copilot account (sign-in required); record the answer with one models set --assign.') },
      { id: 'login-first', label: t('先に Copilot にサインインする（AI がサインイン画面を開きます）', 'Sign in first with copilot login'), command: () => 'copilot login',
        reason: t('一覧の取得がサインインの不足で失敗する場合です。', 'When listing fails because the CLI is not signed in.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'cli-options', match: /Copilot CLI is missing required options: (.*)/,
    cause: m => t(`この Copilot CLI には、キットが使うオプション（${m[1]}）がありません。CLI が古い可能性があります。`, `This Copilot CLI lacks options the kit uses (${m[1]}); it is probably outdated.`),
    impact: t('ワーカーを起動できません。', 'Workers cannot start.'),
    options: [
      { id: 'update-cli', label: t('Copilot CLI を更新する', 'Update the Copilot CLI'), command: () => 'copilot update', reason: t('キットは CLI 1.0.93 以降で確認しています。', 'The kit is verified with CLI 1.0.93 or later.') },
      { id: 'cli-path', label: t('別の場所にある新しい Copilot CLI を使う', 'Point to a newer CLI installed elsewhere with --copilot'), command: k => `node ${k}/scripts/run_migration.mjs doctor --check-cli --copilot /path/to/copilot`,
        reason: t('PATH の先に古い版が見つかっている場合です。以降のコマンドにも --copilot を付けます。', 'When an older copy comes first on PATH; pass --copilot to later commands too.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'hook-check', match: /Hook check failed: (.*)/,
    cause: m => t(`hook の動作確認に失敗しました（${m[1]}）。設定されたコマンドが動かない、または時間がかかりすぎています。`, `The hook check failed (${m[1]}): the configured command does not work or is too slow.`),
    impact: t('hook は時間切れや失敗の時に素通りするため、制限と承認の確認が効かない可能性があります。', 'Hooks let calls through on timeout or failure, so guardrails and approval confirmation may be off.'),
    options: [
      { id: 'reinstall-hook', label: t('キットの安全チェックの設定を入れ直す', 'Restore the kit hook configuration (rerun the installer)'),
        reason: t('設定されたコマンドが存在しないスクリプトを指している場合に解決します。', 'Fixes a configuration that points at a missing script.') },
      investigate('Node の起動が遅い環境なら、timeoutSec を長くするか、マシン負荷を確認します。', 'If Node starts slowly here, raise timeoutSec or check machine load.'),
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'profile-modified', match: /Worker profile is not the kit's: (.*)|Kit file missing: (.*)/,
    cause: m => t(`キットの担当プロファイルまたはファイルが変更・欠落しています（${m[1] ?? m[2]}）。`, `A kit worker profile or file was modified or is missing (${m[1] ?? m[2]}).`),
    impact: t('ワーカーの制限（ツールなし・モデル指定）が保証できないため、変換を始められません。', 'Worker restrictions (tools, models) cannot be guaranteed, so translation cannot start.'),
    options: [
      { id: 'restore-kit', label: t('キットのファイルを元に戻す（導入し直す・プラグインを更新する）', 'Restore the kit files (reinstall or update the plugin)'),
        reason: t('担当プロファイルは承認の対象です。キットの内容に戻せば検査が通ります。', 'Profiles are part of what approvals cover; restoring them passes the check.') },
      investigate('戻す前に、git status / git diff でどのファイルがいつ、なぜ変わったかを確認します。', 'Before restoring, check with git status / git diff which file changed, when and why.'),
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'waiting-dependency', match: /Waiting on unfinished dependencies \(([^)]*)\)|Dependency jobs are incomplete/,
    cause: m => t(`依存先の単位（${m[1] ?? '不明'}）が完了していないため、この単位には着手していません。`, `This unit was not started because its dependencies (${m[1] ?? 'unknown'}) are not complete.`),
    impact: t('依存先が完了すれば、再実行で自動的に着手されます。', 'It starts automatically on the next run once its dependencies are complete.'),
    options: [
      { id: 'fix-dependency', label: t('先に、このファイルが使っているファイルの失敗を直してから、変換をやり直す', 'Resolve the dependency failures first, then rerun translate'),
        reason: t('依存先の訳がないとレビュー・型チェックの前提が揃いません。依存先の案内を先に見てください。', 'Without the dependencies, reviews and typechecks lack their inputs; follow the dependency guidance first.') },
      { id: 'inspect-blockers', label: t('止まっている、使われる側のファイルと理由を確認する', 'Check with status which dependency is stuck and why'), command: k => `node ${k}/scripts/run_migration.mjs status --format markdown`,
        reason: t('依存先ごとの停止理由と次の操作が表示されます。直さずに再実行しても、同じところで止まります。', 'It lists each stuck dependency with its reason and next action; rerunning without a fix stops at the same place.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'circuit-breaker', match: /Stopped dispatching after (\d+) consecutive unit failures/,
    cause: m => t(`${m[1]} 件続けて単位が失敗したため、残りの配布を止めました。共通の原因（モデル・設定・入力）の可能性が高いです。`, `Dispatching stopped after ${m[1]} unit failures in a row; they most likely share one cause (model, settings or inputs).`),
    impact: t('残りの単位は未着手です。完了済みの単位は保持されます。', 'Remaining units were not started; completed units are kept.'),
    options: [
      { id: 'investigate-first', label: t('最初に失敗した単位の原因を確認して直す', 'Check and fix the cause of the first failures'),
        reason: t('同じ原因なら、直さずに再実行しても同じ失敗を繰り返し、AI Credits を消費するだけです。', 'If they share a cause, rerunning without a fix repeats the failure and only spends AI Credits.') },
      { id: 'raise-breaker', label: t('失敗どうしが無関係と確認できたら、連続失敗で止まるまでの回数を増やしてやり直す', 'If the failures are unrelated, raise maxConsecutiveFailures and rerun'),
        reason: t('設定変更なので承認をやり直します。', 'It changes config, so approvals restart.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'survey-result', match: /Survey item outside its scope|Survey item must cite PATH:LINE|Survey citation outside source lines|Unknown fact category|Invalid survey result|Survey item requires|Contracts survey must return exactly one item|Inventory survey covered \d+ of \d+|Inventory item is not a scope census site|Inventory items must be confirmed or unknown/,
    cause: t('調査担当の答えが契約どおりではありませんでした（範囲外のファイル・引用行、引用なし、対象の取りこぼしなど）。完全な結果としては採用せず、検証できた部分は保存しています。', 'A surveyor answer broke its contract (an out-of-scope file/line, missing citation or item). It was not accepted as a complete result; validated partial rows are preserved.'),
    impact: t('他の範囲の結果は保存済みです。この範囲だけが未完了です。', 'Other scopes are saved; only this scope is unfinished.'),
    options: [
      { id: 'rerun-survey', label: t('調査をもう一度実行する（終わっていない範囲だけ動きます）', 'Run survey run again (only unfinished scopes run)'),
        reason: t('一時的な応答の崩れなら再実行で直ります。完了済みの範囲は再実行しません。', 'Transient answer problems clear on rerun; finished scopes are not repeated.') },
      { id: 'smaller-scopes', label: t('1回に調べるファイル数を減らして、範囲を細かくする', 'Use a smaller --max-files for finer scopes'),
        reason: t('1回に渡すファイルが多いと、取りこぼしや範囲外の引用が増えます。', 'Large scopes make omissions and out-of-scope citations more likely.') },
      { id: 'survey-model', label: t('調査を担当するAIのモデルを変える', 'Choose another surveyor model with phaseModels.survey'),
        reason: t('同じ範囲で繰り返すなら、モデルが契約に従えていない可能性があります（設定変更なので承認をやり直します）。', 'If it repeats, the model may not follow the contract; changing config restarts approvals.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // m[3]: the survey kind the message names ("resume survey run --kind K").
  { id: 'survey-incomplete', match: /Survey incomplete: (\d+) of (\d+) scopes(?:[\s\S]*?--kind (facts|contracts|inventory)\b)?/,
    cause: m => t(`${m[2]} 範囲のうち ${m[1]} 範囲に、現在の入力に対応する結果がありません（未実行・失敗・ソース変更）。`, `${m[1]} of ${m[2]} scopes have no result for the current inputs (not run, failed or source changed).`),
    impact: t('不完全な調査をまとめると見落としが混ざるため、まとめませんでした。', 'Merging an incomplete survey would hide gaps, so nothing was merged.'),
    options: [
      { id: 'resume-survey', label: t('残りの範囲を調査してから、もう一度まとめる', 'Run the remaining scopes with survey run, then merge again'),
        reason: t('結果はファイル単位で保存されているので、続きだけ実行されます。', 'Results are saved per scope, so only the rest runs.') },
      { id: 'survey-status', label: t('終わっていない調査の範囲とその理由を確認する', 'Check the unfinished scopes and why with survey status'),
        command: (k, m) => m[3] ? `node ${k}/scripts/run_migration.mjs survey status --kind ${m[3]}` : null,
        reason: t('読み取りだけの確認です。同じ範囲が失敗し続けるなら、再実行の前に範囲の大きさやモデルを見直せます。', 'Read-only; if the same scope keeps failing, revisit the scope size or the model before rerunning.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'survey-census', match: /needs a mechanical site census/,
    cause: t('inventory の調査には、機械的に作った箇所一覧（file・symbol・source_construct の TSV）が必要です。', 'The inventory survey needs a mechanical site census (TSV of file, symbol, source_construct).'),
    impact: t('どの箇所を分類するかが決まらないため、調査を始めていません。', 'Without it, there is nothing defined to classify, so nothing ran.'),
    options: [
      { id: 'make-census', label: t('AI が検索で要注意箇所の一覧を作り、それを調査に使う', 'Build the census with grep or a script and pass it as --sites'),
        reason: t('上流キットの原則どおり、対象箇所の列挙は判断ではなく機械的に行います。完了の定義にもなります。', 'As upstream requires, sites are enumerated mechanically, not by judgment; the census is the definition of done.') },
      { id: 'agree-constructs', label: t('どんな書き方を要注意箇所として数えるかを、先に AI と決める', 'First agree with the AI which source constructs count as sites (the source_construct list)'),
        reason: t('数える対象を決めるのは判断ですが、決めた後の一覧づくりは機械的に行います。', 'Choosing what to count is a decision; enumerating the sites stays mechanical afterwards.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'manifest', match: /Manifest (?:is empty|header)|manifest\.tsv/,
    cause: t('作業一覧（migration/manifest.tsv）がない、空、または形式が違います。', 'The work manifest (migration/manifest.tsv) is missing, empty or malformed.'),
    impact: t('変換単位が決まらないため、judge・変換に進めません。', 'No translation units exist, so judge and translation cannot proceed.'),
    options: [
      { id: 'make-manifest', label: t('ファイル同士のつながりの順に、変換対象の一覧を作る', 'Generate it from the dependency order'),
        command: k => `${pythonCommand()} ${k}/scripts/make_manifest.py --order migration/depmap/order.txt --out migration/manifest.tsv --sub 'src/=ported/' --sub '.py=.mjs'`,
        reason: t('依存の少ないファイルから順に並ぶため、レビューと型チェックが安定します（--sub は実際の命名規則に合わせる）。', 'Leaves-first order keeps reviews and typechecks stable (adapt --sub to the naming rules).') },
      { id: 'edit-manifest', label: t('変換対象の一覧を手で直す', 'Edit the manifest by hand'), reason: t('ヘッダーは source<TAB>target の2列です。', 'The header is exactly source<TAB>target.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'review-deps', match: /Review dependency map|review-dependencies|Audited file missing from declared source graph|dependency closure/i,
    // Phase 01 creates the dependency map; without it there is nothing to generate from.
    context: (m, { root }) => ({ depmap: hasFile(root, 'migration/depmap/edges.tsv') }),
    cause: t('レビュー用の依存宣言（migration/review-dependencies.json）がない、または一部のファイルが宣言されていません。', 'The review dependency declaration (migration/review-dependencies.json) is missing or omits files.'),
    impact: t('レビュー担当に渡す証拠の範囲が決まらず、変換を開始できません。', 'The reviewers\' evidence scope is undefined, so translation cannot start.'),
    options: [
      { id: 'phase-01', when: (m, c, x) => !x.depmap, label: t('依存マップがまだないため、工程01（依存関係）で依存マップと依存宣言を作り、監査する', 'There is no dependency map yet: create the map and the declaration in phase 01 (dependencies) and audit them'),
        command: k => `node ${k}/scripts/run_migration.mjs phase next`,
        reason: t('依存宣言は工程01で依存マップから機械的に作ります。phase next で今の工程を確認し、01より前の工程があれば先に進めます。', 'Phase 01 generates the declaration mechanically from the dependency map. phase next shows the current phase; finish any earlier phase first.') },
      { id: 'make-review-deps', when: (m, c, x) => x.depmap, label: t('依存マップから依存宣言を生成する', 'Generate it from the dependency map'),
        command: k => `node ${k}/scripts/make_review_dependencies.mjs --source-root src --edges migration/depmap/edges.tsv`,
        reason: t('解析器の結果から機械的に作るため、推測による抜けを防げます。', 'Generated mechanically from the parser output, so no guessed gaps.') },
      investigate('どのファイルが不足しているかをエラー全文で確認します。', 'Read the full error for the missing file.'),
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // Only the CLI's own launch/auth failures: a bare ENOENT or "401" also
  // appears in file errors and diagnostics and must not route the user to /login.
  { id: 'copilot-missing', match: /spawn \S*copilot\S*(?: ENOENT)?|copilot: (?:command )?not found|Cannot read the Copilot CLI version/,
    cause: t('Copilot CLI（copilot コマンド）を起動できません。CLIワーカー方式は、VS Code から実行する場合も copilot 実行ファイルを使います。',
      'The Copilot CLI (copilot) could not be started. The CLI worker backend uses the copilot executable even when driven from VS Code.'),
    impact: t('変換・レビューのワーカーを起動できません。', 'Translation and review workers cannot start.'),
    options: [
      { id: 'install-cli', label: t('AI が Copilot CLI をインストールし、サインインを始める', 'Let the AI install the Copilot CLI and start sign-in'), command: () => 'npm install -g @github/copilot && copilot login',
        reason: t('ワーカーは必ず Copilot CLI で動きます（VS Code から進める場合も同じ）。AI がターミナルで実行し、サインインはブラウザで承認するだけです（表示されたコードをチャットに出します）。', 'Workers always run on the Copilot CLI, also from VS Code. The AI runs this in the terminal; you only approve the sign-in in the browser (any one-time code is shown in chat).') },
      { id: 'cli-path', label: t('インストール済みの CLI のパスを指定する', 'Point to an installed CLI'), command: k => `node ${k}/scripts/run_migration.mjs doctor --check-cli --copilot /path/to/copilot`,
        reason: t('PATH にない場所へ入っている場合。以降のコマンドにも --copilot を付けます。', 'When it is installed outside PATH; pass --copilot to later commands too.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // A dropped or timed-out connection. The CLI can add its sign-in help after
  // one (it could not reach GitHub to check the token); without an explicit
  // rejection that is not a sign-in problem, so this comes before copilot-auth.
  // The CLI's own event stall and the causes that stop the run keep their rules.
  { id: 'cli-network', match: new RegExp(`^(?![\\s\\S]*(?:${explicitAuthRejection.source}|${otherSystemicPattern.source}|${hostStallPattern.source}|explicit (?:bounded )?deadline|Interrupted))[\\s\\S]*(?:${networkFailurePattern.source})`, 'i'),
    cause: t('Copilot CLI の通信が途中で切れたか、接続先から決まった時間内に返事がありませんでした（ETIMEDOUT などの通信エラー）。サインインの失敗ではありません。CLI が続けてサインインの案内を出すことがありますが、通信できずに確認できなかっただけです。', 'The Copilot CLI\'s connection dropped or got no answer in time (a network error such as ETIMEDOUT). This is not a failed sign-in: the CLI may add its sign-in help, but only because it could not reach GitHub to check.'),
    impact: t(`キットは同じ呼び出しを自動でやり直します（サインインの案内が一緒に出たときは最大${hostStallRetries}回。上限を設けるモードでは、その回数の上限が少なければそこまで）。それでも通らなかったファイルと、そのファイルを使うファイルが未完了です。`, `The kit retries the same call (up to ${hostStallRetries} times when the sign-in help came with it; in bounded mode, its retry limit if lower). A file that still did not pass, and the files that use it, are unfinished.`),
    options: [
      { id: 'rerun', label: t('同じ処理をもう一度動かす（終わったファイルはそのまま残ります）', 'Run the same command again (finished files are kept)'), reason: t('一時的な切断なら、やり直せば通ります。サインインし直す必要はありません。', 'A brief outage passes on a rerun; no new sign-in is needed.') },
      { id: 'check-network', label: t('何度も続くなら、AI と一緒にプロキシの設定（HTTPS_PROXY・NO_PROXY）とサインイン状態を確かめる', 'If it keeps happening, check the proxy settings (HTTPS_PROXY, NO_PROXY) and the sign-in with the AI'), command: k => `node ${k}/scripts/run_migration.mjs doctor --check-cli`,
        reason: t('会社のプロキシやウイルス対策ソフトが通信を遅らせたり切ったりしていることがあります。doctor が通信とサインインのどちらで止まるかを見分けます。設定の変更やサインインには、あなたの確認が必要なことがあります。', 'A corporate proxy or security software can delay or cut connections. doctor tells whether the connection or the sign-in fails; changing settings or signing in may need you.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'copilot-auth', match: /session\.error (?:authentication|authorization|forbidden)\b|To authenticate, you can use|run the '\/login' command|not (?:signed|logged) in to (?:GitHub|Copilot)|authentication (?:failed|required)|\b401 Unauthorized\b|\b403 Forbidden\b|Bad credentials/i,
    cause: t('Copilot CLI がサインインしていない、または認証に失敗しました。', 'The Copilot CLI is not signed in or authentication failed.'),
    impact: t('ワーカーがモデルを呼び出せません。', 'Workers cannot call a model.'),
    options: [
      { id: 'login', label: t('AI がサインイン画面を開き、あなたがブラウザでサインインを承認する', 'Let the AI run copilot login; approve the sign-in in the browser'), command: () => 'copilot login',
        reason: t('VS Code のサインインとは別に一度だけ必要です。ブラウザが開くか、ワンタイムコードをチャットに表示します。ワーカーは同じユーザー設定を使うため、全担当に反映されます。', 'Needed once, separately from the VS Code sign-in. A browser opens, or a one-time code is shown in chat. Workers share the user configuration, so it covers every role.') },
      { id: 'token', label: t('GitHub のアクセス用の鍵（トークン）を設定する', 'Set COPILOT_GITHUB_TOKEN'), reason: t('対話ログインができない環境向け。トークンはファイルに書かないでください。', 'For non-interactive environments; never write the token to a file.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'agents', match: /did not report its agent list|No such agent|is shadowed or duplicated/,
    cause: t('CLI がキットの担当エージェントを見つけられない、または同名の別エージェントがあります。', 'The CLI cannot resolve the kit\'s worker agents, or another agent uses the same name.'),
    impact: t('ワーカーを正しい役割で起動できません。', 'Workers cannot start with the right role.'),
    options: [
      { id: 'doctor', label: t('足りない・重複しているキットの設定を AI が確認する', 'Run doctor to list missing or conflicting agents'), command: k => `node ${k}/scripts/run_migration.mjs doctor --check-cli`,
        reason: t('サインイン切れ・古いCLI・同名の個人エージェントのどれが原因かを切り分けられます。', 'Separates sign-in, outdated CLI and same-named personal agents.') },
      { id: 'update-cli', label: t('Copilot CLI を更新する', 'Update the Copilot CLI'), command: () => 'copilot update', reason: t('古いCLIはプラグインのエージェントを読み込めません。', 'Old CLIs cannot load plugin agents.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'typecheck', match: /Unit typecheck failed|typecheck still fails/,
    cause: t('変換したファイルの軽量型チェックが失敗しました。', 'The per-unit typecheck failed for a translated file.'),
    impact: t('この単位は完了になりません（他の単位は続行できます）。', 'This unit is not complete; other units can continue.'),
    options: [
      { id: 'repair', label: t('型チェックの出力を証拠にして修正ループへ回す', 'Send the typecheck output to the repair loop'),
        command: k => `node ${k}/scripts/run_migration.mjs repair --target TARGET --evidence migration/EVIDENCE.txt`,
        reason: t('修正はレビュー→裁定→修正→再レビューを通るため、品質を保ったまま直せます。', 'Repairs go through review, arbitration, fix and re-review, so quality holds.') },
      { id: 'wait-deps', label: t('使われる側のファイルの変換が終わってから、変換をやり直す', 'Rerun translate after dependencies finish'),
        reason: t('依存先が未変換なだけなら、再実行で解消します。', 'If only dependencies were missing, a rerun resolves it.') },
      { id: 'defer-typecheck', label: t('単位ごとの型チェックを外し、全体ビルドで検査する', 'Defer the typecheck to the whole build'),
        reason: t('循環依存などで単位ごとの検査が難しい場合。設定変更なので承認をやり直します。', 'For cycles where per-unit checks cannot pass; it changes config, so approvals restart.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // Slips of one unit's worker output (trailer, arbitration references, a fix
  // that changed nothing). They are not rule problems: editing the RULEBOOK
  // for them sends every finished unit back to review (contextHash).
  // An arbitration slip resumes at arbitration, so a rerun usually clears it.
  { id: 'arbitration-slip', match: /Unknown\/duplicate arbitration finding|Arbiter omitted findings/,
    cause: t('この単位の裁定役が、指摘の参照名を決まった形で返しませんでした（やり直しも1回済み）。変換ルール（RULEBOOK）の問題ではありません。', 'This unit\'s arbiter did not return the finding references in the required form, after its one retry. It is not a RULEBOOK problem.'),
    impact: t('この単位だけが未完了です。完了済みの単位はそのまま使えます。RULEBOOK を直すと完了済みがすべてレビューし直しになるので、RULEBOOK は変えません。', 'Only this unit is unfinished; finished units stay valid. Do not edit the RULEBOOK for it: that sends every finished unit back to review.'),
    options: [
      { id: 'rerun', label: t('変換をもう一度実行する', 'Rerun translate'), command: k => `node ${k}/scripts/run_migration.mjs translate`,
        reason: t('止まった単位だけを裁定からやり直します。レビュー結果はそのまま使い、完了済みの単位はやり直しません。', 'Only the stopped units resume at arbitration, reusing their reviews; finished units are not redone.') },
      { id: 'repair', label: t('同じ単位でまた止まったら、エラー文を証拠ファイルに書いて修正ループへ回す', 'If the same unit stops again, write the error to an evidence file and send it to the repair loop'),
        command: k => `node ${k}/scripts/run_migration.mjs repair --target TARGET --evidence migration/EVIDENCE.txt`,
        reason: t('AI がエラー文を migration/ の下に書き、レビュー・裁定・修正をその単位だけ通し直します。', 'The AI writes the error under migration/, and that unit alone goes through review, arbitration and fix again.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // A wrong trailer comes back from review unchanged, and an unchanged fix
  // repeats on the same findings: the error has to reach the fixer.
  { id: 'unit-slip', match: /PORT STATUS count mismatch or invalid trailer|Fixer returned the reviewed candidate unchanged/,
    cause: t('この単位の出力が決まった形になっていませんでした（末尾行の件数・書式、または変更のない修正）。変換ルール（RULEBOOK）の問題ではありません。', 'This unit\'s output missed the required form (the trailer\'s count or format, or a fix that changed nothing). It is not a RULEBOOK problem.'),
    impact: t('この単位だけが未完了です。完了済みの単位はそのまま使えます。RULEBOOK を直すと完了済みがすべてレビューし直しになるので、RULEBOOK は変えません。', 'Only this unit is unfinished; finished units stay valid. Do not edit the RULEBOOK for it: that sends every finished unit back to review.'),
    options: [
      { id: 'repair', label: t('エラー文を証拠ファイルに書いて、その単位を修正ループへ回す', 'Write the error to an evidence file and send the unit to the repair loop'),
        command: k => `node ${k}/scripts/run_migration.mjs repair --target TARGET --evidence migration/EVIDENCE.txt`,
        reason: t('ただ再実行すると同じ出力がまたレビューされ、同じところで止まりがちです。修正ループならエラーの内容がレビュー役と修正役に渡ります。', 'A plain rerun reviews the same output again and tends to stop at the same place; the repair loop hands the error to the reviewers and the fixer.') },
      { id: 'rerun', label: t('変換をもう一度実行する', 'Rerun translate'), command: k => `node ${k}/scripts/run_migration.mjs translate`,
        reason: t('止まった単位だけをやり直し、完了済みの単位はやり直しません。レビューで末尾行の誤りが指摘されれば直ります。', 'Only the stopped units run again; finished units are not redone. It clears if a reviewer flags the trailer.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'fix-limit', match: /Fix-round limit reached/,
    cause: t('同じ単位で修正の上限回数に達しました。指摘が繰り返されています。', 'The unit hit the fix-round limit; findings keep recurring.'),
    impact: t('この単位は停止しています。', 'This unit is stopped.'),
    options: [
      { id: 'amend-rule', label: t('同じ指摘が続く原因のルールを特定し、変換ルールの修正案を出す', 'Find the rule behind the recurring finding and propose a RULEBOOK amendment'),
        reason: t('同じ失敗の繰り返しはルールの問題です（上流ルール6）。個別修正より再発を防げます。修正すると完了済みの単位はレビューし直しになります。', 'Recurring failures indict a rule (upstream rule 6); fixing the rule prevents recurrences. The amendment sends finished units back to review.') },
      { id: 'raise-limit', label: t('AI の直し回数の上限を増やしてやり直す（上限を設けるモードのとき）', 'Raise maxFixRounds and rerun (bounded mode)'), reason: t('指摘が毎回減っていて、あと少しで収束する場合だけ。', 'Only if findings shrink each round and are close to converging.') },
      investigate('migration/state/units/ の記録で、指摘の内容を確認します。', 'Read the findings in migration/state/units/.'),
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'call-limit', match: /Agent call limit reached/,
    cause: t('1回の実行で使えるAI呼び出し数（maxAgentCalls）に達しました。失敗ではなく予算の区切りです。', 'This run used its AI-call budget (maxAgentCalls). It is a budget stop, not a failure.'),
    impact: t('残りの単位は未完了のままです。完了済みの単位は保持されます。', 'Remaining units are unfinished; completed units are kept.'),
    options: [
      { id: 'resume', label: t('AI の使用量を確認してから、変換をやり直す', 'Check usage and rerun translate'), command: k => `node ${k}/scripts/run_migration.mjs translate`,
        reason: t('完了済みはスキップされ、続きから再開します。', 'Completed units are skipped; it resumes where it stopped.') },
      { id: 'raise-budget', label: t('AI を呼ぶ回数の上限をあなたと決めて、変換をやり直す（上限を設けるモードなら、その上限を増やす）', 'Run translate --max-calls N with an agreed number (in bounded mode, raise maxAgentCalls)'), command: k => `node ${k}/scripts/run_migration.mjs translate --max-calls N`,
        reason: t('1回で多く進めたい場合。実行上限なので、レビュー済みの単位と承認はそのままです。', 'To do more per run; it is a run limit, so reviewed units and approvals stay.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'input-budget', match: /Run input budget \(maxRunInputBytes\) reached/,
    cause: t('1回の実行で送る入力量の上限（maxRunInputBytes）に達しました。失敗ではなく予算の区切りです。', 'The run reached its input budget (maxRunInputBytes). It is a budget stop, not a failure.'),
    impact: t('残りの単位は未完了です。完了済みの単位と記録は保持されます。', 'Remaining units are unfinished; completed units and receipts are kept.'),
    options: [
      { id: 'resume', label: t('実行の要約で使用量の目安を確認してから、変換をやり直す', 'Review usageEstimate in the run summary, then rerun translate'), command: k => `node ${k}/scripts/run_migration.mjs translate`,
        reason: t('AI Credits はトークン量で消費されます。区切りごとに使用量を確認しながら進められます。', 'AI Credits are spent per token; this lets you check usage between budgeted runs.') },
      { id: 'raise-input-budget', label: t('1回の実行でAIに渡せる量の上限を増やす', 'Raise maxRunInputBytes'), reason: t('1回で多く進めたい場合。実行上限なので、レビュー済みの単位と承認はそのままです。', 'To do more per run; it is a run limit, so reviewed units and approvals stay.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'file-limit', match: /Too many open files|\bEMFILE\b/,
    cause: t('同時に開けるファイル数の上限に達しました（EMFILE）。並列の Copilot CLI ワーカーはそれぞれ多くのファイルを監視します。', 'The open-file limit was reached (EMFILE). Each parallel Copilot CLI worker watches many files.'),
    impact: t('ワーカーが起動途中で失敗します。完了済みの単位は保持されます。', 'Workers fail while starting; completed units are kept.'),
    options: [
      { id: 'lower-concurrency', label: t('同時に動かすAIの数を減らしてやり直す', 'Lower concurrency and rerun'),
        reason: t('各 CLI は起動時に自分の上限をハード上限まで引き上げています。それでも足りない場合の最短の対処です。実行上限なので、レビュー済みの単位と承認はそのままです。', 'Each CLI already raises its own limit to the hard limit at startup; this is the quickest remedy beyond that. It is a run limit, so reviewed units and approvals stay.') },
      { id: 'raise-hard-limit', label: t('パソコンの「同時に開けるファイル数」の上限を引き上げる（パソコンの管理者の操作。macOS では管理者が上限の設定を変えます）', 'Raise the hard limit (an administrator step; on macOS, launchctl limit maxfiles)'),
        reason: t('ハード上限は一般ユーザーの権限では上げられません。doctor の file descriptor limit に現在値を表示します。', 'The hard limit cannot be raised without privileges; doctor shows the current values under file descriptor limit.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'rate-limit', match: /session\.error rate_limit|\b429\b|rate[ -]?limit(?:ed)?\b|too many requests/i,
    cause: t('Copilot のレート制限に、CLI と runner の再試行を使い切っても当たり続けました。', 'Copilot rate limits persisted after the CLI\'s and the runner\'s retries.'),
    impact: t('該当の単位は未完了です。完了済みの単位は保持されます。', 'The unit is unfinished; completed units are kept.'),
    options: [
      { id: 'wait-rerun', label: t('数分待ってから、変換をやり直す', 'Wait a few minutes, then rerun translate'), command: k => `node ${k}/scripts/run_migration.mjs translate`,
        reason: t('記録から続きを再開でき、設定を変えないので承認はそのままです。', 'It resumes from the receipts and changes no setting, so approvals stay.') },
      { id: 'lower-concurrency', label: t('同時に動かすAIの数を減らすか、やり直すまでの待ち時間を延ばす', 'Lower concurrency or raise transientRetryDelayMs'),
        reason: t('同時呼び出しが多いほど制限に当たりやすくなります。実行上限なので、レビュー済みの単位と承認はそのままです。', 'More concurrent calls hit the limit sooner; it is a run limit, so reviewed units and approvals stay.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'credits', match: /\b(?:AI Credits?|credit|budget|quota|spending limit)\b.*\b(?:exhaust|exceed|reach|insufficient|run out|limit)/i,
    cause: t('Copilot の AI Credits または管理者の予算を使い切った可能性があります（使い切ると利用が止まり、安いモデルへの自動切り替えはありません）。', 'Copilot AI Credits or the admin budget may be used up; usage stops, with no fallback to a cheaper model.'),
    impact: t('ワーカーがモデルを呼び出せません。完了済みの単位は保持されます。', 'Workers cannot call a model; completed units are kept.'),
    options: [
      { id: 'check-billing', label: t('GitHub の課金・予算の設定で残量を確認し、追加・引き上げ後に再実行する', 'Check credits and budget in GitHub billing, add or raise them, then rerun'),
        reason: t('記録は残っているため、残量を戻せば続きから再開できます。', 'Receipts are kept, so the run resumes once credits are available.') },
      { id: 'cheaper-model', label: t('消費の少ないモデルに変更する', 'Switch to a cheaper model'), reason: t('トークン単価の低いモデルなら消費を抑えられます。設定変更なので承認をやり直します。', 'A model with lower token rates spends less; it changes config, so approvals restart.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'lock', match: /Migration locked|Lock owner|run\.lock|Invalid runner lock|build-loop lock|build-loop \(grant .*already running|lock\.recover/,
    cause: t('別の実行が動作中です（異常終了した実行のロックは次のコマンドが自動で外します）。', 'Another run is active (a lock left by a crashed run is removed by the next command).'),
    impact: t('同時実行による記録の破損を防ぐため停止しました。', 'Stopped to protect receipts from concurrent runs.'),
    options: [
      { id: 'wait', label: t('実行中の処理が終わるのを待つ', 'Wait for the active run'), command: k => `node ${k}/scripts/run_migration.mjs status --format markdown`,
        reason: t('status で実行中かどうかと所有プロセスを確認できます。', 'status shows whether it is running and its owner.') },
      { id: 'unlock', label: t('別のパソコンなどの実行が本当に止まっていると確認してから、実行中の印を外す', 'For a lock from another host, confirm that run stopped, then unlock it'), command: k => `node ${k}/scripts/run_migration.mjs unlock --pid OWNER_PID`,
        reason: t('同じホストで止まったプロセスのロックは再実行で自動的に外れます。別ホスト（共有フォルダ）のロックは、unlock が所有プロセスを確認せずに外すため、そのホストで実行が止まったことを確かめてから使います。同じホストで稼働中のPIDは外せません。', 'A stopped owner\'s lock on this host is removed by the rerun. unlock removes a lock from another host (shared folder) without checking its owner, so use it only after confirming that run stopped there. A live PID on this host cannot be unlocked.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'inputs-changed', match: /inputs changed|Inputs changed|approval is stale|changed during|Receipt stale/,
    cause: t('元ソース・ルール・設定・比較器などの入力が、承認または実行の後で変わりました。', 'Inputs (source, rules, config or judge) changed after approval or during the run.'),
    impact: t('古い承認・結果は無効になりました。', 'Earlier approvals and results are no longer valid.'),
    options: [
      { id: 'reapprove', label: t('変わった内容を確認し、テストの判定から確認と承認をやり直す', 'Review the change, then redo judge and approval'),
        reason: t('承認は内容のハッシュに結び付いているため、変更後の内容で確認し直す必要があります。', 'Approvals bind to content hashes, so the changed content needs a fresh review.') },
      { id: 'revert', label: t('意図しない変更なら元に戻す', 'Revert an unintended change'), reason: t('元に戻せば既存の承認がそのまま有効になります。', 'Reverting restores the existing approvals.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'approval', match: /No (\w[\w-]*) approval|approve translation|Run judge successfully/,
    cause: t('次の段階に必要な承認（または judge の成功記録）がありません。', 'The approval (or judge success) required for the next stage is missing.'),
    impact: t('この段階は実行されていません。', 'The stage did not run.'),
    options: [
      { id: 'review-approve', label: t('成果物を確認して、ご自身の判断で承認する', 'Review the artifacts and approve if you agree'),
        reason: t('承認は人間の判断です。AIは確認材料を示すだけで、自分では承認しません。', 'Approval is your decision; the AI shows evidence and never approves on its own.') },
      { id: 'revise', label: t('成果物を修正する', 'Revise the artifacts'), reason: t('確認して問題があれば、承認前に直します。', 'Fix problems before approving.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'build-failed', match: /Build failed|build failed|(?:build|smoke|parity) failed \(exit/i,
    cause: t('ビルドまたは検証コマンドが失敗しました。', 'The build or validation command failed.'),
    impact: t('次の段階へは進めません。', 'The next stage cannot start.'),
    options: [
      { id: 'repair-round', label: t('エラーを解析して修正ラウンドを実行する', 'Parse the errors and run a repair round'), command: k => `node ${k}/scripts/run_migration.mjs repair-round`,
        reason: t('エラー一覧を機械的に修正キューへ変換し、レビュー付きで修正します。', 'Turns the error list into a repair queue mechanically, with reviews.') },
      investigate('migration/results/ のコマンド出力を確認します。環境の問題（ツール未導入など）なら修正ではなく環境を直します。', 'Read the command output in migration/results/; environment problems need environment fixes, not code fixes.'),
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // Retried automatically up to hostStallRetries times (failures.mjs); seen
  // here when those ran out or the host summarizes it. The kit's own deadline
  // and a cancellation are final and stay with the timeout rule.
  { id: 'cli-host-stall', match: new RegExp(`^(?![\\s\\S]*(?:explicit (?:bounded )?deadline|Interrupted))[\\s\\S]*(?:${hostStallPattern.source})`, 'i'),
    cause: t('Copilot CLI の内部で、AI の途中経過を受け取る処理が決まった時間内に応答しませんでした。メッセージは120秒の待ちを示しています。Copilot CLI 1.0.105 とキットを調べた範囲では、これを延ばす設定は見当たりません。', 'Inside the Copilot CLI, the part that takes the AI\'s progress did not answer within its fixed wait. The message reports a 120 s wait; no setting that lengthens it was found in Copilot CLI 1.0.105 or the kit.'),
    impact: t(`キットは同じ呼び出しを自動でやり直します（最大${hostStallRetries}回。上限を設けるモードで動かしている場合は、その回数の上限が少なければそこまで。既定は2回）。それでも通らなかったファイルと、そのファイルを使うファイルが未完了です。`, `The kit retries the same call (continuous mode: up to ${hostStallRetries} times; bounded mode: the lower of transientRetries, default 2, and ${hostStallRetries}). A file that still did not pass, and the files that use it, are unfinished.`),
    options: [
      { id: 'rerun', label: t('同じ処理をもう一度動かす（終わったファイルはそのまま残ります）', 'Run the same command again (finished files are kept)'), reason: t('一時的な詰まりなら、やり直せば通ります。', 'If the stall was temporary, a rerun passes.') },
      { id: 'lower-concurrency', label: t('同時に動かすAIの数を減らす（これまでの許可はそのまま）', 'Lower concurrency (approvals are kept)'), reason: t('パソコンの負荷が下がります。詰まりとの関係は確かめられていませんが、試す価値があります。', 'It lowers the load on the computer; a link to the stall is not proven, but it is worth trying.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'timeout', match: /timed out|\btimeout\b(?!Seconds)/i,
    cause: t('外部サービス・ホスト、または明示的なbounded設定の時間制限です。通常のcontinuous実行は経過時間で中断しません。', 'A service/host or explicitly selected bounded deadline expired. Normal continuous execution never cancels work for elapsed time.'),
    impact: t('該当の単位・段階は未完了です。', 'The affected unit or stage is unfinished.'),
    options: [
      { id: 'rerun', label: t('既存プロセスの生存と終了原因を調べる', 'Check the existing process and the source of the deadline'), reason: t('動作中なら同じ実行を待ちます。ホストの待機終了をworker終了と取り違えず、重複起動しません。', 'Keep waiting if the job lives; a host wait returning is not worker failure. Never launch a duplicate.') },
      { id: 'raise-timeout', label: t('選択済みの時間制限を見直す', 'Review an explicitly selected deadline'), reason: t('利用者が継続実行を望んだ場合はcontinuousへ戻すか0（期限なし）を選びます。', 'When the person wants continuous work, use continuous mode or an explicitly unlimited deadline of 0.') },
      { id: 'lower-concurrency', label: t('同時に動かすAIの数を減らす', 'Lower concurrency'), reason: t('レート制限で遅くなっている場合に有効です。', 'Helps when rate limits slow calls.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'worker-output', match: /valid JSON|Copilot JSONL|Invalid (?:review|arbitration) result|Expected implementation result|verdict contradicts|Copilot \S+ failed \(exit/,
    cause: t('ワーカーの応答が契約どおりのJSONではない、またはCLIが異常終了しました。', 'A worker reply was not contract JSON, or the CLI exited abnormally.'),
    impact: t('該当の単位は完了として記録されていません。', 'The unit was not recorded as complete.'),
    options: [
      { id: 'rerun', label: t('同じ処理（変換または調査）をやり直す', 'Rerun the same command (translate / survey run)'), reason: t('一時的な応答崩れは再実行で解消することが多く、完了済みの単位・範囲は保持されます。', 'Malformed replies are often transient; finished units and scopes are kept.') },
      { id: 'change-model', label: t('その担当のモデルを変更する', 'Change that role\'s model'), reason: t('同じ担当で繰り返す場合、モデルが契約に従えていない可能性があります（承認はやり直し）。', 'If it repeats for one role, the model may not follow the contract (approvals restart).') },
      investigate('migration/runs/ の記録で CLI の出力を確認します。', 'Read the CLI output in migration/runs/.'),
      { id: 'pause', label: pause, reason: pauseWhy }] },
  // The kit runs no secret scan; a host or tool that does reports its result
  // here. A switch such as /P or -p is a credential only with a value after
  // it. A clean result needs nothing: credential-clear only informs.
  { id: 'credential-candidate', match: credentialCandidate,
    cause: t('ソース検査が「資格情報らしい値」を疑いました。キット自体は秘密情報の検査をせず、これで止まる段階もありません。/P や -p のようなスイッチだけ（set /P、xcopy /P、del /P など）は資格情報ではなく、スイッチの直後に実際の値が書かれている場合だけが本物の候補です。値が含まれうるため、渡されたメッセージは表示しません。',
      'A source check suspected a literal credential. The kit runs no secret scan and no phase stops on one. A switch alone such as /P or -p (set /P, xcopy /P, del /P) is not a credential; only a value written right after the switch is a real candidate. The message is not repeated, since it may hold the value.'),
    impact: t('キットの段階はどれも止まっていません。ソースは変更されていません。問題になるのは、その行を読んだり Copilot ワーカー（survey・変換）へ渡したりするかどうかだけです。',
      'No kit phase is blocked and the source is unchanged. The only question is whether that line is read, or sent to Copilot workers (survey, translation).'),
    options: [
      { id: 'check-line', label: t('検出された行をあなたが確認する（値はチャットに出さない）', 'You check the flagged line (keep the value out of chat)'),
        reason: t('AI が行を読むと値が会話に入るため、確認はあなたが行います。スイッチだけなら誤検知なので 00 を続けます。schtasks /U ユーザー /P 値、sqlcmd -P 値 のように値が書かれている場合だけ、次の選択肢に進みます。', 'If the AI reads the line, the value enters the conversation, so you check it. A switch alone is a false positive and 00 continues. Only a written value, as in schtasks /U user /P value or sqlcmd -P value, needs the next choice.') },
      { id: 'skip-line', label: t('その行を読まずに 00 を続け、ファイルと行番号だけを未確認として報告書に書く', 'Continue 00 without reading that line; report only its file and line number as unverified'),
        reason: t('00 の判断はその1行がなくても下せます。AI はその行を表示・引用せず、survey にも渡しません（survey を避けるだけでは、AI が読んだ値は防げません）。', '00 can decide without that one line. The AI does not print, quote or survey it (skipping the survey alone does not keep out a value the AI has read).') },
      { id: 'move-secret', label: t('本物なら、値をソースから外してから進める', 'If it is real, move the value out of the source first'),
        reason: t('環境変数や秘密情報の保管場所へ移し、履歴に残っていればその値を無効にします。ソースの変更はあなたの作業で、キットはソースを書き換えません。', 'Move it to an environment variable or a secret store, and revoke it if history keeps it. Changing the source is your step; the kit never edits it.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'credential-incomplete', match: credentialIncomplete,
    cause: t('資格情報の検査が終わっていません（失敗・権限不足・スキップなど）。「見つからなかった」とは言えません。キット自体は秘密情報の検査をせず、これで止まる段階もありません。値が含まれうるため、渡されたメッセージは表示しません。',
      'The credential check did not finish (it failed, lacked access or was skipped), so this is not a clean result. The kit runs no secret scan and no phase stops on one. The message is not repeated, since it may hold a value.'),
    impact: t('キットの段階はどれも止まっていません。分からないのは、ソースに資格情報があるかどうかだけです。', 'No kit phase is blocked. What is unknown is only whether the source holds a credential.'),
    options: [
      { id: 'check-yourself', label: t('検査が対象にしたファイルをあなたが確認する（値はチャットに出さない）', 'You check the files the check covered (keep any value out of chat)'),
        reason: t('AI が読むと値が会話に入るため、確認はあなたが行います。問題がなければ 00 を続けます。', 'If the AI reads them, any value enters the conversation, so you check. If they are fine, 00 continues.') },
      { id: 'rerun-check', label: t('検査が失敗した原因（権限など）を直して、もう一度検査する', 'Fix why the check failed (access, for example) and run it again'),
        reason: t('検査を使いたい場合。結果が出るまで、検査対象のファイルは未確認として扱います。', 'When you want the check. Until it reports, its files count as unverified.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'credential-clear', match: credentialClear, informational: true,
    cause: t('ソース検査は資格情報を見つけていません。キット自体は秘密情報の検査をせず、これを待つ段階もありません。', 'The source check found no credential. The kit runs no secret scan and no phase waits on one.'),
    impact: t('何も止まっていません。', 'Nothing is blocked.'),
    options: [
      { id: 'continue', label: t('いまの段階をそのまま続ける', 'Continue the current phase as is'), reason: t('検査結果に対応すべきものがないためです。', 'The check reported nothing to act on.') },
      { id: 'note-report', label: t('検査で何も見つからなかったことを報告書に一行書いて続ける', 'Note in the report that the check found nothing, then continue'),
        reason: t('検査を実行した事実を残したい場合。', 'When you want the report to show that the check ran.') },
      { id: 'pause', label: pause, reason: pauseWhy }] }
];
export const guidanceRuleIds = rules.map(r => r.id);

// The phase whose unfinished state a gate message reports (the phase a
// relaxed-mode waiver stands in for), or null for any other failure.
const gateMessages = [
  [/Phase (00b|00|01|02|03|04|05b|05c|05)(?: is not reviewed for current inputs|'s record is out of date)/, m => m[1]],
  [/Run (judge|build|smoke|parity) successfully for (?:the current|current|these) inputs/, m => ({ judge: '03', build: '05', smoke: '05b', parity: '05c' })[m[1]]],
  [/Review artifact required: migration\/(feasibility\.md|stress-test\/report\.md)/, m => m[1] === 'feasibility.md' ? '00' : '03'],
  [/All translation units must have current reviewed receipts|Reviewed translation receipts are missing or stale|Current reviewed translation units are required/, () => '04']];
function gatePhase(message) {
  for (const [pattern, phase] of gateMessages) { const m = message.match(pattern); if (m) return phase(m); }
  return null;
}
const kitMarker = '\u0000kit';
const pick = (value, m, x) => typeof value === 'function' ? value(m, x) : value;

// Returns { id, message, cause, impact, options[], recommended, choices[] } in
// one language. choices are the option labels for the host question tool,
// recommended first and marked, in the order of options.
// explain: the message came from `guidance --message`, so it may not be the
// runner's own error, and the report must not read as guidance itself failing.
export function failureGuidance(error, { root, language = 'en', explain = false } = {}) {
  const message = String(error?.message ?? error ?? '');
  const lang = language === 'ja' ? 'ja' : 'en';
  let rule, m;
  for (const r of rules) { m = message.match(r.match); if (m) { rule = r; break; } }
  // A credential finding is the person's call whatever else the message says
  // (a worker's output can carry one); a CLI sign-in failure (Bad credentials)
  // stays an auth problem. Other results keep the rule that explains them.
  const credential = credentialResult(message);
  if (credential === 'candidate' && rule?.id !== 'copilot-auth' && rule?.id !== 'credential-candidate') { rule = rules.find(r => r.id === 'credential-candidate'); m = [message]; }
  // Text a rule builds from its captures comes from the protected message, so a
  // value never reaches a cause, label or command; rules are chosen on the
  // message as given.
  if (rule && sensitive(message)) m = protect(message).match(rule.match) ?? m;
  rule ??= { id: 'unknown', cause: explain
      ? t('キットのエラー一覧にないメッセージです。runner の出力なら想定外のエラー、別のツールや独自の検査の出力ならそのツールの出力が原因の手掛かりです。', 'The kit has no entry for this message. From the runner it is an unexpected error; from another tool or a check of your own, that tool\'s output is the clue.')
      : t('想定外のエラーです。メッセージ全文が原因の手掛かりです。', 'Unexpected error; the full message is the main clue.'),
    impact: explain ? t('このメッセージだけでは、何が止まっているかキットには判断できません。', 'The kit cannot tell from this message alone what is blocked.')
      : t('この操作は完了していません。', 'This operation did not complete.'),
    options: [investigate('エラー全文と migration/results/・migration/runs/ の記録を確認し、原因を特定してから選び直します。', 'Read the full error and the records in migration/results/ and migration/runs/, then decide again.'),
      { id: 'revise', label: t('直前の成果物・設定を見直す', 'Revisit the last artifacts or settings'), reason: t('直前に変えた内容が原因であることが多いためです。', 'The most recent change is the usual cause.') },
      { id: 'pause', label: pause, reason: pauseWhy }] };
  let config = null, prefs = {};
  try { if (root) config = loadConfig(root); } catch {}
  try { if (root) prefs = readPreferences(root); } catch {}
  const ctx = { config, originalRuntime: prefs.originalRuntime ?? (config?.preparationProfile === 'source-as-spec' ? 'unavailable' : null),
    ...(rule.context ? rule.context(m, { root, config }) : {}) };
  let chosen = rule.options.filter(o => !o.when || o.when(m, config, ctx));
  if (rule.order) { const order = rule.order(ctx); chosen = order.map(id => chosen.find(o => o.id === id)).filter(Boolean); }
  // Relaxed mode: a gate the person may proceed past. The fixes stay first
  // (recommended); proceeding is one more choice before pause, never chosen
  // for them. Its command records their reason as a waiver.
  const waivable = message.match(/Relaxed mode(?: \(auto\))?: .*?phase waive (\w+) --note/s);
  // Normal mode: the same gate may be passed by switching to relaxed mode.
  // Offered last before pause and never recommended; production pilots cannot.
  const switchable = !waivable && !['relaxed', 'auto'].includes(prefs.phaseMode) && config?.executionPurpose !== 'pilot' ? gatePhase(message) : null;
  if (switchable) {
    const at = chosen.findIndex(o => o.id === 'pause');
    chosen.splice(at < 0 ? chosen.length : at, 0, { id: 'switch-relaxed',
      label: t(`緩和モードに切り替え、工程 ${switchable} を終えずに先へ進む`, `Switch to relaxed mode and proceed without finishing phase ${switchable}`),
      command: k => `node ${k}/scripts/run_migration.mjs preferences --phase-mode relaxed`,
      reason: t(`切り替えても承認や完了記録は消えません。その後で同じ操作をやり直すと、直すか進むかをもう一度聞きます。進む場合は phase waive ${switchable} で見送りとして記録します。`, `Switching revokes no approval or record. Retrying the same step then asks again whether to fix or proceed; proceeding records phase waive ${switchable}.`) });
  }
  if (waivable) {
    const at = chosen.findIndex(o => o.id === 'pause');
    chosen.splice(at < 0 ? chosen.length : at, 0, { id: 'waive',
      label: /Relaxed mode \(auto\)/.test(message)
        ? t(`工程 ${waivable[1]} の作業で埋められないときは、質問せずに見送って進む（自動モード・見送りとして記録）`, `If phase ${waivable[1]}'s own work cannot supply it, proceed without asking (auto mode; recorded as waived)`)
        : t(`工程 ${waivable[1]} を終えずに、このまま先へ進む（緩和モード・見送りとして記録）`, `Proceed without finishing phase ${waivable[1]} (relaxed mode; recorded as waived)`),
      command: k => `node ${k}/scripts/run_migration.mjs phase waive ${waivable[1]} --note "<進む理由 / why you proceed>"`,
      reason: t('足りない前提は未完了のまま status と引き継ぎ報告に残ります。あとで直して記録し直せば、見送りは自動で外れます。', 'What is missing stays unfinished in status and the handoff report. Fixing and recording it later lifts the waiver automatically.') });
  }
  // A command runs as written, so it is a single command line; an option whose
  // command depends on a fact the message lacks has none.
  // Commands name the kit through a marker, so a kit path with spaces is quoted whole.
  const hide = sensitive(message), clean = hide ? scrubber(message) : text => text;
  const options = chosen.map((o, i) => { const command = o.command?.(kitMarker, m, ctx)?.replace(/\u0000kit(\/[^\s'"]*)/g, (_, rel) => kitScript(root, rel.slice(1)));
    return { id: o.id, label: clean(pick(o.label, m, ctx)[lang]), reason: clean(pick(o.reason, m, ctx)[lang]), ...(command ? { command: clean(command) } : {}), recommended: i === 0 }; });
  const mark = lang === 'ja' ? '（推奨）' : ' (recommended)';
  return { id: rule.id, message: hide ? withheld[lang] : message, cause: clean(pick(rule.cause, m, ctx)[lang]), impact: clean(pick(rule.impact, m, ctx)[lang]), options, recommended: options[0].id,
    choices: options.map(o => o.recommended ? `${o.label}${mark}` : o.label), actionRequired: !rule.informational, ...(explain ? { explained: true } : {}) };
}

export function guidanceMarkdown(g, language = 'en') {
  const ja = language === 'ja';
  return [...(g.explained ? [ja ? '## 渡されたメッセージへの対処' : '## What to do about this message',
      ja ? '- 注記: guidance コマンドは正常に終了しました。以下は渡されたメッセージの説明で、guidance 自体の失敗ではありません。' : '- Note: the guidance command succeeded. What follows explains the message it was given; it is not a failure of guidance itself.']
    : [ja ? '## うまくいきませんでした' : '## This step did not succeed']),
    `- ${ja ? '原因' : 'Cause'}: ${g.cause}`, `- ${ja ? '影響' : 'Impact'}: ${g.impact}`, `- ${g.explained ? (ja ? 'メッセージ' : 'Message') : ja ? 'エラー' : 'Error'}: \`${g.message.split('\n')[0].slice(0, 400)}\``,
    // Nothing to decide: show the next step and ask no question.
    ...(g.actionRequired === false ? ['', ja ? '### 次の手順' : '### Next step', `- ${g.options[0].label}: ${g.options[0].reason}`,
      '', ja ? '判断は不要です。質問せずにそのまま続けてください。' : 'No decision is needed; continue without asking.'] : [
    '', ja ? '### 選択肢' : '### Choices',
    ...g.options.map((o, i) => `${i + 1}. **${o.label}**${o.recommended ? (ja ? '（推奨）' : ' (recommended)') : ''}\n   - ${ja ? '理由' : 'Why'}: ${o.reason}${o.command ? `\n   - ${ja ? 'AI が実行するコマンド（利用者には見せない）' : 'Command (for the agent; do not show it to the person)'}: \`${o.command}\`` : ''}`),
    '', ja ? 'どれで進めるか選んでください。返信例：「1で進めて」' : 'Choose how to proceed. Example reply: "Go with 1".'])].join('\n');
}

// "Translation stopped: a.mjs: X; b.mjs: Y" carries one cause per unit. Group
// the units by guidance so each distinct cause gets its own choices.
export function failureGuidanceList(error, options = {}) {
  const message = String(error?.message ?? error ?? '');
  const body = message.match(/^(?:Translation|Survey) stopped: ([\s\S]*)$/)?.[1];
  if (!body) return [{ targets: [], guidance: failureGuidance(message, options) }];
  const groups = new Map();
  for (const entry of body.split(/;\s(?=(?:\([\w-]+\)|[^\s;:]+): )/)) {
    const [, target, cause] = entry.match(/^(\([\w-]+\)|[^\s;:]+): ([\s\S]*)$/) ?? [null, null, entry];
    const guidance = failureGuidance(cause, options);
    const key = `${guidance.id}\0${guidance.id === 'unknown' ? cause : ''}`;
    if (!groups.has(key)) groups.set(key, { targets: [], guidance });
    if (target) groups.get(key).targets.push(target);
  }
  return [...groups.values()];
}
export function guidanceListMarkdown(list, language = 'en') {
  if (list.length === 1 && !list[0].targets.length) return guidanceMarkdown(list[0].guidance, language);
  const ja = language === 'ja';
  return [ja ? `# 原因ごとの対処（${list.length}件）` : `# What to do, per cause (${list.length})`,
    ...list.map(({ targets, guidance }, i) => `${targets.length ? `${ja ? '対象' : 'Affected'}: ${targets.join(', ')}\n` : ''}${guidanceMarkdown(guidance, language).replace(/^## /, `## ${i + 1}. `)}`)].join('\n\n');
}

// doctor reports problems as failed checks rather than errors; map each to the
// same cause/choices format. Checks that are only informational are skipped.
const checkMessages = [
  [/^model tools: comparison B$/, c => c.detail ?? 'Comparison B: model unknown has no file-writing tool'],
  [/^model tools: /, c => `Model tools: ${c.model ?? 'unknown'} under the kit's flags lacks ${(c.missing ?? []).join(', ')} for ${c.check.slice('model tools: '.length)}`],
  [/^commands can write outside the project and use loopback$/, c => `Local sandbox blocks kit commands: ${c.detail ?? ''}`],
  [/^tool-assisted reviewer hook loads in prompt mode$/, c => c.cause === 'local-sandbox' ? `Local sandbox blocks kit commands: loopback 127.0.0.1` : `${c.check}: ${c.detail ?? 'failed'}`],
  [/^worker models chosen$/, c => `Set an available model ID for models.${(c.missing ?? [])[0] ?? 'implementer'}`],
  [/^worker agents resolve$/, c => c.detail ?? `No such agent: ${(c.missing ?? []).join(', ')}`],
  [/^Copilot CLI answers$/, c => c.detail ?? 'Doctor check "Copilot CLI" did not finish within ? s'],
  [/^Copilot executable$/, c => /ENOENT|not found/i.test(c.detail ?? '') ? 'spawn copilot ENOENT' : `Cannot read the Copilot CLI version: ${c.detail ?? ''}`],
  [/^required flags$/, c => `Copilot CLI is missing required options: ${(c.missing ?? []).join(' ')}`],
  [/^repository hooks load in Copilot CLI$/, () => 'Repository hooks are not loaded: the Copilot CLI folder is untrusted'],
  [/^command guardrails$/, c => `Phase 03 guardrails are invalid: ${c.detail ?? ''}`],
  [/^review dependency map$/, c => `Review dependency map: ${c.detail ?? 'missing'}`],
  [/^hook responds before its timeout$/, c => `Hook check failed: ${c.command ?? 'no hook command'} took ${c.durationMs ?? '?'} ms (timeout ${c.timeoutSec ?? '?'} s)`],
  [/: model and tools$/, c => `Worker profile is not the kit's: ${c.detail ?? ''}`],
  [/\.agent\.md$|hooks/, c => `Kit file missing: ${c.check}`],
  [/^verification input files$/, c => c.detail ?? 'verification inputs invalid'],
  [/^file descriptor limit$/, c => `Too many open files: the hard descriptor limit is ${c.hard ?? 'unknown'}`]
];
export function doctorGuidance(report, options = {}) {
  const list = [];
  for (const c of report.checks ?? []) {
    if (c.ok !== false) continue;
    const entry = checkMessages.find(([re]) => re.test(c.check));
    list.push({ targets: [c.check], guidance: failureGuidance(entry ? entry[1](c) : `${c.check}: ${c.detail ?? 'failed'}`, options) });
  }
  return list;
}
