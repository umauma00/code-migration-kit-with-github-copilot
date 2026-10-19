// SPDX-License-Identifier: Apache-2.0
// Turns a runner failure into a user decision: what went wrong, what it blocks,
// and two or more choices with one recommendation and the reason for each.
// The catalog is presentation only. It never approves, edits or reruns anything;
// the parent shows it and waits for the user's real answer.
import path from 'node:path';
import { pluginRoot } from './runtime.mjs';
import { loadConfig } from './core.mjs';
import { readPreferences } from './preferences.mjs';

// Phases a person records after reviewing artifacts; the runner records the rest.
const manualPhases = new Set(['00', '00b', '01', '02', '03']);

const t = (ja, en) => ({ ja, en });
const pause = t('ここで中断する', 'Pause here'), pauseWhy = t('成果物と記録はディスクに残るため、後で同じコマンドから再開できます。', 'Artifacts and receipts stay on disk, so the same command resumes later.');
const investigate = (ja, en) => ({ id: 'investigate', label: t('詳細を調査する', 'Investigate the details'), reason: t(ja, en) });

// First matching rule wins; order from specific to generic.
const rules = [
  { id: 'guardrails', match: /guardrails (?:are invalid|deny nothing)|requires human-installed command guardrails/,
    cause: t('03/04は、人間が設置したコマンド制限（migration/guardrails.json）が必要です。未設置・不正・空のいずれかです。',
      'Phases 03/04 need human-installed command guardrails (migration/guardrails.json); the file is missing, invalid or empty.'),
    impact: t('試行・本番変換を開始できません。', 'The stress test and production translation cannot start.'),
    options: [
      { id: 'install-guardrails', label: t('AI が提案する禁止リストに合意し、設置コマンドの確認ダイアログで許可する', 'Agree the deny list the AI proposes, then allow the install command when the host asks'),
        command: k => `node ${k}/scripts/run_migration.mjs guardrails show`,
        reason: t('上流の deny ルールと同じ保護です。設置は人間の判断なので、AI は提案と `guardrails install` の実行だけを行い、ホストがあなたに確認を求めます。ファイルを直接作ることはありません。', 'It is the upstream deny-rule protection. Installing it is the human\'s decision: the AI only proposes and runs `guardrails install`, which the host asks you to confirm; it never writes the file directly.') },
      { id: 'waive-guardrails', label: t('制限を設けない理由を記録して免除する（guardrails install --waiver）', 'Record a waiver with the reason (guardrails install --waiver)'),
        reason: t('使い捨て環境などで制限が不要な場合だけ。誤ったgit操作や重いビルドを防げなくなります。', 'Only for disposable environments; destructive git and heavy builds are no longer blocked.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'phase-order', match: /Phase (\w+) is not reviewed for current inputs/,
    cause: m => t(`前の工程 ${m[1]} のレビュー記録がない、または入力が変わって失効しています。`, `Phase ${m[1]} has no review record for the current inputs (missing, or invalidated by a change).`),
    impact: t('後の工程は、前の工程を飛ばして進めません。', 'Later phases cannot skip an unreviewed earlier phase.'),
    options: [
      // The note is never pre-filled: it must say what the person actually reviewed.
      { id: 'review-previous', when: m => manualPhases.has(m[1]),
        label: m => t(`工程 ${m[1]} の成果物をあなたが確認し、確認した内容を書いて完了を記録する`, `Review phase ${m[1]} artifacts yourself, then record its completion with what you checked`),
        command: (k, m) => `node ${k}/scripts/run_migration.mjs phase complete ${m[1]} --note "<確認した内容 / what you reviewed>"`,
        reason: t('工程の順番は承認と完了判定の前提です。記録はあなたの確認の後にだけ行います。', 'Phase order underpins approvals and completion; the record follows your review, never precedes it.') },
      { id: 'finish-runner-phase', when: m => !manualPhases.has(m[1]),
        label: m => t(`工程 ${m[1]} を runner で実行・検証し直す`, `Run and validate phase ${m[1]} through the runner again`),
        command: k => `node ${k}/scripts/run_migration.mjs status --format markdown`,
        reason: t('この工程は手作業の記録ではなく、runner の実行結果で完了になります。status が次に必要な承認・実行を示します。', 'This phase completes from runner results, not a manual record; status shows the approval or run it needs.') },
      { id: 'bundle-spec', when: (m, c) => c?.preparationProfile === 'source-as-spec' && ['00b', '01', '02'].includes(m[1]),
        label: t('生成した仕様一式（00b〜02）をあなたが確認し、まとめて記録する', 'Review the generated specification package (00b–02) yourself and record it together'),
        command: k => `node ${k}/scripts/run_migration.mjs phase complete 00b,01,02 --note "<確認した内容 / what you reviewed>"`,
        reason: t('source-as-spec では仕様一式を1回で確認できます。不足があればどの工程も記録されません。', 'Source-as-spec reviews the package once; if anything is missing, no phase is recorded.') },
      { id: 'redo-phase', label: m => t(`工程 ${m[1]} に戻り、成果物を作り直す・修正する`, `Return to phase ${m[1]} and redo or revise its artifacts`),
        reason: t('入力の変更で記録が失効した場合や、成果物に問題がある場合はこちらです。', 'Choose this when an input change invalidated the record or the artifacts need work.') },
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
      { id: 'answer-runtime', label: t('まず「現行の実行環境をここで動かせるか」を答える（答えで推奨が決まります）', 'First answer whether the original can still run here (it decides the recommendation)'),
        command: k => `node ${k}/scripts/run_migration.mjs preferences --original-runtime available|unavailable`,
        reason: t('動かせるなら新旧比較で同等性を実証でき、動かせないならソースを仕様にする方式が適切です。推測では選びません。', 'If it runs, parity proves equivalence; if not, the source-as-spec profile fits. The kit does not guess.') },
      { id: 'configure-runtime', label: t('現行環境の比較コマンド（original / mutation / parity）を設定する', 'Configure the original-runtime commands (original / mutation / parity)'),
        reason: t('現行を動かせる場合はこちら。新旧の動作同等性を実際に検証でき、上流キットと同じ品質保証になります。', 'Choose this when the original runs: equivalence is verified for real, as in the upstream kit.') },
      { id: 'switch-source-as-spec', label: t('ソースを唯一の仕様とする方式（source-as-spec）に切り替える', 'Switch to the source-as-spec profile'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec init`,
        reason: t('現行を動かせない・仕様書がない場合はこちら。ソースから契約とルールを作り、確認後に変換へ進めます。動作同等性は未検証として引き継ぎます。', 'Choose this when the original cannot run or no spec exists; equivalence is handed off as unverified.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'source-plan', match: /Source-only judge plan requires|Source-only scenarios require|Invalid (?:scenario|source) input path|Missing or empty (?:scenario|source) input|judge-plan\.json/,
    cause: t('source-only方式の準備記録（migration/judge-plan.json）が不足または不正です。', 'The source-only preparation record (migration/judge-plan.json) is missing or invalid.'),
    impact: t('00bを完了できず、正式なjudge検証も実行できません。', '00b cannot complete and formal judge validation cannot run.'),
    options: [
      { id: 'draft-spec', label: t('ソースから準備記録の下書きを作る', 'Draft the plan from the source'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec init`,
        reason: t('全ソースを列挙した judge-plan と契約メモの雛形を機械的に作ります。既存ファイルは上書きしません。', 'Mechanically lists every source file in a judge-plan and a contract skeleton; existing files are kept.') },
      { id: 'edit-plan', label: t('judge-plan.json を手で直す', 'Fix judge-plan.json by hand'), reason: t('既に計画がある場合。エラーが示す項目だけを修正します。', 'If a plan already exists, fix only the field named in the error.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'spec-placeholder', match: /contracts still contain TODO\(spec\)/,
    cause: t('ソースから作る契約メモ（migration/source-spec/contracts.md）に未記入の TODO(spec) が残っています。', 'The source-derived contracts (migration/source-spec/contracts.md) still contain unfilled TODO(spec) items.'),
    impact: t('雛形のままでは仕様として承認できないため、00b を記録していません。', 'A skeleton is not a specification, so 00b was not recorded.'),
    options: [
      { id: 'fill-contracts', label: t('各ファイルの公開インターフェース・入出力・エラー・境界条件を、ソースの行番号付きで記入する', 'Fill each file\'s interface, inputs/outputs, errors and edge cases with cited source lines'),
        reason: t('ソースが唯一の仕様なので、ここが変換・レビューの判断基準になります。AIが下書きし、あなたが確認します。', 'The source is the only specification, so this is what translation and review are judged against; the AI drafts and you review.') },
      { id: 'mark-unknown', label: t('ソースから判断できない項目は「不明」と書き、TODO(port) の対象として残す', 'Write "unknown" for items the source cannot decide and keep them as TODO(port)'),
        reason: t('推測で埋めるより、不明として残す方が後で検索・確認できます（上流ルール8）。', 'An explicit unknown is searchable later, unlike a guess (upstream rule 8).') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'outside-roots', match: /(?:Source|Target) outside (?:sourceRoots|outputRoots): (\S+)/,
    cause: m => t(`manifest に移行対象外のファイル（${m[1]}）が含まれています。依存解析がキットや管理ファイルまで拾った可能性があります。`, `The manifest contains ${m[1]}, which is outside the configured roots; the dependency parser may have scanned kit or metadata files.`),
    impact: t('manifest と依存宣言を確定できません。', 'The manifest and dependency declaration cannot be finalized.'),
    options: [
      { id: 'regenerate', label: t('依存解析の対象を移行対象のソースに絞って、depmap・manifest を作り直す', 'Rerun the parser on the source roots only and regenerate depmap and manifest'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec check`,
        reason: t('解析結果から機械的に作り直せば、手作業の除外漏れが起きません。check が推奨コマンドを表示します。', 'Regenerating mechanically avoids manual omissions; check prints the suggested commands.') },
      { id: 'fix-roots', label: t('対象ファイルが本当に移行対象なら sourceRoots / outputRoots を広げる', 'If the file really belongs to the migration, widen sourceRoots / outputRoots'),
        reason: t('設定変更は承認をやり直す必要があります。', 'Changing config restarts approvals.') },
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
      { id: 'rerun-parser', label: t('source-spec check が示すコマンドで依存解析・manifest・依存宣言を作り直す', 'Regenerate the map, manifest and declarations with the commands from source-spec check'),
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
      { id: 'draft-rules', label: t('ソースの調査結果から RULEBOOK と inventory を書く（AIが下書きし、あなたが確認）', 'Write RULEBOOK and inventory from the source survey (the AI drafts, you review)'),
        reason: t('RULEBOOK は全担当の判断基準です。ここで決めた方針が全ファイルに一貫して適用されます（上流キットの中心）。', 'The rulebook is every worker\'s reference; deciding it once keeps every file consistent (the core of the upstream kit).') },
      { id: 'source-as-spec', label: t('現行環境・仕様書がないなら source-as-spec で 00b〜02 をまとめて作る', 'Without a runnable original or spec, draft 00b–02 together with source-as-spec'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec check`, reason: t('不足している成果物と作り方を一覧で確認できます。', 'Lists the missing artifacts and how to produce them.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'untrusted-folder', match: /Repository hooks are not loaded: the Copilot CLI folder is untrusted/,
    cause: t('Copilot CLI がこのフォルダを信頼していないため、キットの hook（コマンド制限・承認の確認・ガードレール保護）が読み込まれません。', 'The Copilot CLI does not trust this folder, so the kit hooks (command guardrails, approval confirmation, guardrails-file protection) are not loaded.'),
    impact: t('このままでは、制限や承認の確認が黙って無効になります。', 'Guardrails and approval confirmation are silently off.'),
    options: [
      { id: 'trust-folder', label: t('このリポジトリで copilot を対話起動し、フォルダを信頼する', 'Start copilot interactively in this repository and trust the folder'), command: () => 'copilot',
        reason: t('一度信頼すれば、以降の CLI セッションで hook が読み込まれます。', 'Once trusted, later CLI sessions load the hooks.') },
      { id: 'plugin-layout', label: t('プラグイン導入に切り替える（プラグインの hook はフォルダの信頼に関係なく読み込まれます）', 'Use the plugin layout (plugin hooks load regardless of folder trust)'),
        reason: t('信頼の設定を変えられない環境向け。導入方式の変更なので承認をやり直します。', 'For environments where trust cannot be granted; changing layout restarts approvals.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'cli-options', match: /Copilot CLI is missing required options: (.*)/,
    cause: m => t(`この Copilot CLI には、キットが使うオプション（${m[1]}）がありません。CLI が古い可能性があります。`, `This Copilot CLI lacks options the kit uses (${m[1]}); it is probably outdated.`),
    impact: t('ワーカーを起動できません。', 'Workers cannot start.'),
    options: [
      { id: 'update-cli', label: t('Copilot CLI を更新する', 'Update the Copilot CLI'), command: () => 'copilot update', reason: t('キットは CLI 1.0.93 以降で確認しています。', 'The kit is verified with CLI 1.0.93 or later.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'hook-check', match: /Hook check failed: (.*)/,
    cause: m => t(`hook の動作確認に失敗しました（${m[1]}）。設定されたコマンドが動かない、または時間がかかりすぎています。`, `The hook check failed (${m[1]}): the configured command does not work or is too slow.`),
    impact: t('hook は時間切れや失敗の時に素通りするため、制限と承認の確認が効かない可能性があります。', 'Hooks let calls through on timeout or failure, so guardrails and approval confirmation may be off.'),
    options: [
      { id: 'reinstall-hook', label: t('キットの hook 設定を入れ直す（導入コマンドを再実行）', 'Restore the kit hook configuration (rerun the installer)'),
        reason: t('設定されたコマンドが存在しないスクリプトを指している場合に解決します。', 'Fixes a configuration that points at a missing script.') },
      investigate('Node の起動が遅い環境なら、timeoutSec を長くするか、マシン負荷を確認します。', 'If Node starts slowly here, raise timeoutSec or check machine load.'),
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'profile-modified', match: /Worker profile is not the kit's: (.*)|Kit file missing: (.*)/,
    cause: m => t(`キットの担当プロファイルまたはファイルが変更・欠落しています（${m[1] ?? m[2]}）。`, `A kit worker profile or file was modified or is missing (${m[1] ?? m[2]}).`),
    impact: t('ワーカーの制限（ツールなし・モデル指定）が保証できないため、変換を始められません。', 'Worker restrictions (tools, models) cannot be guaranteed, so translation cannot start.'),
    options: [
      { id: 'restore-kit', label: t('キットのファイルを元に戻す（導入し直す・プラグインを更新する）', 'Restore the kit files (reinstall or update the plugin)'),
        reason: t('担当プロファイルは承認の対象です。キットの内容に戻せば検査が通ります。', 'Profiles are part of what approvals cover; restoring them passes the check.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'waiting-dependency', match: /Waiting on unfinished dependencies \(([^)]*)\)|Dependency jobs are incomplete/,
    cause: m => t(`依存先の単位（${m[1] ?? '不明'}）が完了していないため、この単位には着手していません。`, `This unit was not started because its dependencies (${m[1] ?? 'unknown'}) are not complete.`),
    impact: t('依存先が完了すれば、再実行で自動的に着手されます。', 'It starts automatically on the next run once its dependencies are complete.'),
    options: [
      { id: 'fix-dependency', label: t('先に依存先の失敗を解決してから translate を再実行する', 'Resolve the dependency failures first, then rerun translate'),
        reason: t('依存先の訳がないとレビュー・型チェックの前提が揃いません。依存先の案内を先に見てください。', 'Without the dependencies, reviews and typechecks lack their inputs; follow the dependency guidance first.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'circuit-breaker', match: /Stopped dispatching after (\d+) consecutive unit failures/,
    cause: m => t(`${m[1]} 件続けて単位が失敗したため、残りの配布を止めました。共通の原因（モデル・設定・入力）の可能性が高いです。`, `Dispatching stopped after ${m[1]} unit failures in a row; they most likely share one cause (model, settings or inputs).`),
    impact: t('残りの単位は未着手です。完了済みの単位は保持されます。', 'Remaining units were not started; completed units are kept.'),
    options: [
      { id: 'investigate-first', label: t('最初に失敗した単位の原因を確認して直す', 'Check and fix the cause of the first failures'),
        reason: t('同じ原因なら、直さずに再実行しても同じ失敗を繰り返し、AI Credits を消費するだけです。', 'If they share a cause, rerunning without a fix repeats the failure and only spends AI Credits.') },
      { id: 'raise-breaker', label: t('失敗が互いに無関係と確認できたら maxConsecutiveFailures を増やして再実行する', 'If the failures are unrelated, raise maxConsecutiveFailures and rerun'),
        reason: t('設定変更なので承認をやり直します。', 'It changes config, so approvals restart.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'survey-result', match: /Survey item outside its scope|Survey item must cite PATH:LINE|Unknown fact category|Invalid survey result|Survey item requires|Contracts survey must return exactly one item|Inventory survey covered \d+ of \d+|Inventory item is not a scope census site|Inventory items must be confirmed or unknown/,
    cause: t('調査担当の答えが契約どおりではありませんでした（範囲外のファイル、行番号の引用なし、対象の取りこぼしなど）。この範囲の結果は保存していません。', 'A surveyor answer broke its contract (a file outside the scope, no PATH:LINE citation, missing items); that scope\'s result was not saved.'),
    impact: t('他の範囲の結果は保存済みです。この範囲だけが未完了です。', 'Other scopes are saved; only this scope is unfinished.'),
    options: [
      { id: 'rerun-survey', label: t('survey run をもう一度実行する（未完了の範囲だけ動きます）', 'Run survey run again (only unfinished scopes run)'),
        reason: t('一時的な応答の崩れなら再実行で直ります。完了済みの範囲は再実行しません。', 'Transient answer problems clear on rerun; finished scopes are not repeated.') },
      { id: 'smaller-scopes', label: t('--max-files を小さくして範囲を細かくする', 'Use a smaller --max-files for finer scopes'),
        reason: t('1回に渡すファイルが多いと、取りこぼしや範囲外の引用が増えます。', 'Large scopes make omissions and out-of-scope citations more likely.') },
      { id: 'survey-model', label: t('phaseModels.survey で調査担当のモデルを変える', 'Choose another surveyor model with phaseModels.survey'),
        reason: t('同じ範囲で繰り返すなら、モデルが契約に従えていない可能性があります（設定変更なので承認をやり直します）。', 'If it repeats, the model may not follow the contract; changing config restarts approvals.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'survey-incomplete', match: /Survey incomplete: (\d+) of (\d+) scopes/,
    cause: m => t(`${m[2]} 範囲のうち ${m[1]} 範囲に、現在の入力に対応する結果がありません（未実行・失敗・ソース変更）。`, `${m[1]} of ${m[2]} scopes have no result for the current inputs (not run, failed or source changed).`),
    impact: t('不完全な調査をまとめると見落としが混ざるため、まとめませんでした。', 'Merging an incomplete survey would hide gaps, so nothing was merged.'),
    options: [
      { id: 'resume-survey', label: t('survey run で残りの範囲を実行してから、もう一度まとめる', 'Run the remaining scopes with survey run, then merge again'),
        reason: t('結果はファイル単位で保存されているので、続きだけ実行されます。', 'Results are saved per scope, so only the rest runs.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'survey-census', match: /needs a mechanical site census/,
    cause: t('inventory の調査には、機械的に作った箇所一覧（file・symbol・source_construct の TSV）が必要です。', 'The inventory survey needs a mechanical site census (TSV of file, symbol, source_construct).'),
    impact: t('どの箇所を分類するかが決まらないため、調査を始めていません。', 'Without it, there is nothing defined to classify, so nothing ran.'),
    options: [
      { id: 'make-census', label: t('grep やスクリプトで箇所一覧を作り、--sites に指定する', 'Build the census with grep or a script and pass it as --sites'),
        reason: t('上流キットの原則どおり、対象箇所の列挙は判断ではなく機械的に行います。完了の定義にもなります。', 'As upstream requires, sites are enumerated mechanically, not by judgment; the census is the definition of done.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'manifest', match: /Manifest (?:is empty|header)|manifest\.tsv/,
    cause: t('作業一覧（migration/manifest.tsv）がない、空、または形式が違います。', 'The work manifest (migration/manifest.tsv) is missing, empty or malformed.'),
    impact: t('変換単位が決まらないため、judge・変換に進めません。', 'No translation units exist, so judge and translation cannot proceed.'),
    options: [
      { id: 'make-manifest', label: t('依存マップの順序から manifest を生成する', 'Generate it from the dependency order'),
        command: k => `python3 ${k}/scripts/make_manifest.py --order migration/depmap/order.txt --out migration/manifest.tsv --sub 'src/=ported/' --sub '.py=.mjs'`,
        reason: t('依存の少ないファイルから順に並ぶため、レビューと型チェックが安定します（--sub は実際の命名規則に合わせる）。', 'Leaves-first order keeps reviews and typechecks stable (adapt --sub to the naming rules).') },
      { id: 'edit-manifest', label: t('manifest を手で直す', 'Edit the manifest by hand'), reason: t('ヘッダーは source<TAB>target の2列です。', 'The header is exactly source<TAB>target.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'review-deps', match: /Review dependency map|review-dependencies|Audited file missing from declared source graph|dependency closure/i,
    cause: t('レビュー用の依存宣言（migration/review-dependencies.json）がない、または一部のファイルが宣言されていません。', 'The review dependency declaration (migration/review-dependencies.json) is missing or omits files.'),
    impact: t('レビュー担当に渡す証拠の範囲が決まらず、変換を開始できません。', 'The reviewers\' evidence scope is undefined, so translation cannot start.'),
    options: [
      { id: 'make-review-deps', label: t('依存マップから依存宣言を生成する', 'Generate it from the dependency map'),
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
  { id: 'copilot-auth', match: /session\.error (?:authentication|authorization|forbidden)\b|To authenticate, you can use|run the '\/login' command|not (?:signed|logged) in to (?:GitHub|Copilot)|authentication (?:failed|required)|\b401 Unauthorized\b|\b403 Forbidden\b|Bad credentials/i,
    cause: t('Copilot CLI がサインインしていない、または認証に失敗しました。', 'The Copilot CLI is not signed in or authentication failed.'),
    impact: t('ワーカーがモデルを呼び出せません。', 'Workers cannot call a model.'),
    options: [
      { id: 'login', label: t('AI が copilot login を実行し、ブラウザでサインインを承認する', 'Let the AI run copilot login; approve the sign-in in the browser'), command: () => 'copilot login',
        reason: t('VS Code のサインインとは別に一度だけ必要です。ブラウザが開くか、ワンタイムコードをチャットに表示します。ワーカーは同じユーザー設定を使うため、全担当に反映されます。', 'Needed once, separately from the VS Code sign-in. A browser opens, or a one-time code is shown in chat. Workers share the user configuration, so it covers every role.') },
      { id: 'token', label: t('COPILOT_GITHUB_TOKEN を設定する', 'Set COPILOT_GITHUB_TOKEN'), reason: t('対話ログインができない環境向け。トークンはファイルに書かないでください。', 'For non-interactive environments; never write the token to a file.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'agents', match: /did not report its agent list|No such agent|is shadowed or duplicated/,
    cause: t('CLI がキットの担当エージェントを見つけられない、または同名の別エージェントがあります。', 'The CLI cannot resolve the kit\'s worker agents, or another agent uses the same name.'),
    impact: t('ワーカーを正しい役割で起動できません。', 'Workers cannot start with the right role.'),
    options: [
      { id: 'doctor', label: t('doctor で不足・衝突しているエージェントを確認する', 'Run doctor to list missing or conflicting agents'), command: k => `node ${k}/scripts/run_migration.mjs doctor --check-cli`,
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
      { id: 'wait-deps', label: t('依存先の変換が終わってから translate を再実行する', 'Rerun translate after dependencies finish'),
        reason: t('依存先が未変換なだけなら、再実行で解消します。', 'If only dependencies were missing, a rerun resolves it.') },
      { id: 'defer-typecheck', label: t('単位ごとの型チェックを外し、全体ビルドで検査する', 'Defer the typecheck to the whole build'),
        reason: t('循環依存などで単位ごとの検査が難しい場合。設定変更なので承認をやり直します。', 'For cycles where per-unit checks cannot pass; it changes config, so approvals restart.') }] },
  { id: 'fix-limit', match: /Fix-round limit reached/,
    cause: t('同じ単位で修正の上限回数に達しました。指摘が繰り返されています。', 'The unit hit the fix-round limit; findings keep recurring.'),
    impact: t('この単位は停止しています。', 'This unit is stopped.'),
    options: [
      { id: 'amend-rule', label: t('繰り返す指摘の原因になったルールを特定し、RULEBOOK の修正案を出す', 'Find the rule behind the recurring finding and propose a RULEBOOK amendment'),
        reason: t('同じ失敗の繰り返しはルールの問題です（上流ルール6）。個別修正より再発を防げます。', 'Recurring failures indict a rule (upstream rule 6); fixing the rule prevents recurrences.') },
      { id: 'raise-limit', label: t('maxFixRounds を増やして再実行する', 'Raise maxFixRounds and rerun'), reason: t('指摘が毎回減っていて、あと少しで収束する場合だけ。', 'Only if findings shrink each round and are close to converging.') },
      investigate('migration/state/units/ の記録で、指摘の内容を確認します。', 'Read the findings in migration/state/units/.')] },
  { id: 'call-limit', match: /Agent call limit reached/,
    cause: t('1回の実行で使えるAI呼び出し数（maxAgentCalls）に達しました。失敗ではなく予算の区切りです。', 'This run used its AI-call budget (maxAgentCalls). It is a budget stop, not a failure.'),
    impact: t('残りの単位は未完了のままです。完了済みの単位は保持されます。', 'Remaining units are unfinished; completed units are kept.'),
    options: [
      { id: 'resume', label: t('利用量を確認して translate を再実行する', 'Check usage and rerun translate'), command: k => `node ${k}/scripts/run_migration.mjs translate`,
        reason: t('完了済みはスキップされ、続きから再開します。', 'Completed units are skipped; it resumes where it stopped.') },
      { id: 'raise-budget', label: t('合意した回数で translate --max-calls N を実行する（または maxAgentCalls を増やす）', 'Run translate --max-calls N with an agreed number (or raise maxAgentCalls)'), command: k => `node ${k}/scripts/run_migration.mjs translate --max-calls N`,
        reason: t('1回で多く進めたい場合。実行上限なので、レビュー済みの単位と承認はそのままです。', 'To do more per run; it is a run limit, so reviewed units and approvals stay.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'input-budget', match: /Run input budget \(maxRunInputBytes\) reached/,
    cause: t('1回の実行で送る入力量の上限（maxRunInputBytes）に達しました。失敗ではなく予算の区切りです。', 'The run reached its input budget (maxRunInputBytes). It is a budget stop, not a failure.'),
    impact: t('残りの単位は未完了です。完了済みの単位と記録は保持されます。', 'Remaining units are unfinished; completed units and receipts are kept.'),
    options: [
      { id: 'resume', label: t('実行の要約（usageEstimate）を確認して translate を再実行する', 'Review usageEstimate in the run summary, then rerun translate'), command: k => `node ${k}/scripts/run_migration.mjs translate`,
        reason: t('AI Credits はトークン量で消費されます。区切りごとに使用量を確認しながら進められます。', 'AI Credits are spent per token; this lets you check usage between budgeted runs.') },
      { id: 'raise-input-budget', label: t('maxRunInputBytes を増やす', 'Raise maxRunInputBytes'), reason: t('1回で多く進めたい場合。実行上限なので、レビュー済みの単位と承認はそのままです。', 'To do more per run; it is a run limit, so reviewed units and approvals stay.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'file-limit', match: /Too many open files|\bEMFILE\b/,
    cause: t('同時に開けるファイル数の上限に達しました（EMFILE）。並列の Copilot CLI ワーカーはそれぞれ多くのファイルを監視します。', 'The open-file limit was reached (EMFILE). Each parallel Copilot CLI worker watches many files.'),
    impact: t('ワーカーが起動途中で失敗します。完了済みの単位は保持されます。', 'Workers fail while starting; completed units are kept.'),
    options: [
      { id: 'lower-concurrency', label: t('concurrency を下げて再実行する', 'Lower concurrency and rerun'),
        reason: t('各 CLI は起動時に自分の上限をハード上限まで引き上げています。それでも足りない場合の最短の対処です。実行上限なので、レビュー済みの単位と承認はそのままです。', 'Each CLI already raises its own limit to the hard limit at startup; this is the quickest remedy beyond that. It is a run limit, so reviewed units and approvals stay.') },
      { id: 'raise-hard-limit', label: t('ハード上限を引き上げる（管理者の操作。macOS は launchctl limit maxfiles）', 'Raise the hard limit (an administrator step; on macOS, launchctl limit maxfiles)'),
        reason: t('ハード上限は一般ユーザーの権限では上げられません。doctor の file descriptor limit に現在値を表示します。', 'The hard limit cannot be raised without privileges; doctor shows the current values under file descriptor limit.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'rate-limit', match: /session\.error rate_limit|\b429\b|rate[ -]?limit(?:ed)?\b|too many requests/i,
    cause: t('Copilot のレート制限に、CLI と runner の再試行を使い切っても当たり続けました。', 'Copilot rate limits persisted after the CLI\'s and the runner\'s retries.'),
    impact: t('該当の単位は未完了です。完了済みの単位は保持されます。', 'The unit is unfinished; completed units are kept.'),
    options: [
      { id: 'wait-rerun', label: t('数分待ってから translate を再実行する', 'Wait a few minutes, then rerun translate'), command: k => `node ${k}/scripts/run_migration.mjs translate`,
        reason: t('記録から続きを再開でき、設定を変えないので承認はそのままです。', 'It resumes from the receipts and changes no setting, so approvals stay.') },
      { id: 'lower-concurrency', label: t('concurrency を下げるか transientRetryDelayMs を上げる', 'Lower concurrency or raise transientRetryDelayMs'),
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
  { id: 'lock', match: /Migration locked|Lock owner|run\.lock|Invalid runner lock/,
    cause: t('別の実行が動作中か、異常終了した実行のロックが残っています。', 'Another run is active, or a crashed run left its lock.'),
    impact: t('同時実行による記録の破損を防ぐため停止しました。', 'Stopped to protect receipts from concurrent runs.'),
    options: [
      { id: 'wait', label: t('実行中の処理が終わるのを待つ', 'Wait for the active run'), command: k => `node ${k}/scripts/run_migration.mjs status --format markdown`,
        reason: t('status で実行中かどうかと所有プロセスを確認できます。', 'status shows whether it is running and its owner.') },
      { id: 'unlock', label: t('所有プロセスの終了を確認してロックを外す', 'Confirm the owner stopped, then unlock'), command: k => `node ${k}/scripts/run_migration.mjs unlock --pid OWNER_PID`,
        reason: t('稼働中のPIDは外せない安全設計です。', 'A live PID cannot be unlocked by design.') }] },
  { id: 'inputs-changed', match: /inputs changed|Inputs changed|approval is stale|changed during|Receipt stale/,
    cause: t('元ソース・ルール・設定・比較器などの入力が、承認または実行の後で変わりました。', 'Inputs (source, rules, config or judge) changed after approval or during the run.'),
    impact: t('古い承認・結果は無効になりました。', 'Earlier approvals and results are no longer valid.'),
    options: [
      { id: 'reapprove', label: t('変更内容を確認し、judge から検証・承認をやり直す', 'Review the change, then redo judge and approval'),
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
  { id: 'timeout', match: /timed out|\btimeout\b(?!Seconds)/i,
    cause: t('ワーカーまたはコマンドが時間上限を超えました。', 'A worker or command exceeded its time limit.'),
    impact: t('該当の単位・段階は未完了です。', 'The affected unit or stage is unfinished.'),
    options: [
      { id: 'rerun', label: t('そのまま再実行する', 'Rerun as is'), reason: t('一時的な遅延なら再実行で解消し、完了済みは保持されます。', 'Transient delays clear on rerun; finished work is kept.') },
      { id: 'raise-timeout', label: t('timeoutSeconds / commandTimeoutSeconds を増やす', 'Raise the timeout'), reason: t('大きいファイルや重いビルドで毎回超える場合。', 'When large files or builds always exceed it.') },
      { id: 'lower-concurrency', label: t('concurrency を下げる', 'Lower concurrency'), reason: t('レート制限で遅くなっている場合に有効です。', 'Helps when rate limits slow calls.') }] },
  { id: 'worker-output', match: /valid JSON|Copilot JSONL|Invalid (?:review|arbitration) result|Expected implementation result|verdict contradicts|Copilot \S+ failed \(exit/,
    cause: t('ワーカーの応答が契約どおりのJSONではない、またはCLIが異常終了しました。', 'A worker reply was not contract JSON, or the CLI exited abnormally.'),
    impact: t('該当の単位は完了として記録されていません。', 'The unit was not recorded as complete.'),
    options: [
      { id: 'rerun', label: t('同じコマンド（translate / survey run）を再実行する', 'Rerun the same command (translate / survey run)'), reason: t('一時的な応答崩れは再実行で解消することが多く、完了済みの単位・範囲は保持されます。', 'Malformed replies are often transient; finished units and scopes are kept.') },
      { id: 'change-model', label: t('その担当のモデルを変更する', 'Change that role\'s model'), reason: t('同じ担当で繰り返す場合、モデルが契約に従えていない可能性があります（承認はやり直し）。', 'If it repeats for one role, the model may not follow the contract (approvals restart).') },
      investigate('migration/runs/ の記録で CLI の出力を確認します。', 'Read the CLI output in migration/runs/.')] }
];

function kitPath(root) {
  if (!root) return 'migration-kit';
  const rel = path.relative(root, pluginRoot);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : pluginRoot;
}
const pick = (value, m) => typeof value === 'function' ? value(m) : value;

// Returns { id, message, cause, impact, options[], recommended } in one language.
export function failureGuidance(error, { root, language = 'en' } = {}) {
  const message = String(error?.message ?? error ?? '');
  const lang = language === 'ja' ? 'ja' : 'en', kit = kitPath(root);
  let rule, m;
  for (const r of rules) { m = message.match(r.match); if (m) { rule = r; break; } }
  rule ??= { id: 'unknown', cause: t('想定外のエラーです。メッセージ全文が原因の手掛かりです。', 'Unexpected error; the full message is the main clue.'),
    impact: t('この操作は完了していません。', 'This operation did not complete.'),
    options: [investigate('エラー全文と migration/results/・migration/runs/ の記録を確認し、原因を特定してから選び直します。', 'Read the full error and the records in migration/results/ and migration/runs/, then decide again.'),
      { id: 'revise', label: t('直前の成果物・設定を見直す', 'Revisit the last artifacts or settings'), reason: t('直前に変えた内容が原因であることが多いためです。', 'The most recent change is the usual cause.') },
      { id: 'pause', label: pause, reason: pauseWhy }] };
  let config = null, prefs = {};
  try { if (root) config = loadConfig(root); } catch {}
  try { if (root) prefs = readPreferences(root); } catch {}
  const ctx = { config, originalRuntime: prefs.originalRuntime ?? (config?.preparationProfile === 'source-as-spec' ? 'unavailable' : null) };
  let chosen = rule.options.filter(o => !o.when || o.when(m, config));
  if (rule.order) { const order = rule.order(ctx); chosen = order.map(id => chosen.find(o => o.id === id)).filter(Boolean); }
  const options = chosen.map((o, i) => ({ id: o.id, label: pick(o.label, m)[lang], reason: pick(o.reason, m)[lang],
    ...(o.command ? { command: o.command(kit, m) } : {}), recommended: i === 0 }));
  return { id: rule.id, message, cause: pick(rule.cause, m)[lang], impact: pick(rule.impact, m)[lang], options, recommended: options[0].id };
}

export function guidanceMarkdown(g, language = 'en') {
  const ja = language === 'ja';
  return [ja ? '## うまくいきませんでした' : '## This step did not succeed',
    `- ${ja ? '原因' : 'Cause'}: ${g.cause}`, `- ${ja ? '影響' : 'Impact'}: ${g.impact}`, `- ${ja ? 'エラー' : 'Error'}: \`${g.message.split('\n')[0].slice(0, 400)}\``,
    '', ja ? '### 選択肢' : '### Choices',
    ...g.options.map((o, i) => `${i + 1}. **${o.label}**${o.recommended ? (ja ? '（推奨）' : ' (recommended)') : ''}\n   - ${ja ? '理由' : 'Why'}: ${o.reason}${o.command ? `\n   - ${ja ? '実行例' : 'Command'}: \`${o.command}\`` : ''}`),
    '', ja ? 'どれで進めるか選んでください。返信例：「1で進めて」' : 'Choose how to proceed. Example reply: "Go with 1".'].join('\n');
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
  [/^worker agents resolve$/, c => c.detail ?? `No such agent: ${(c.missing ?? []).join(', ')}`],
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
