// SPDX-License-Identifier: Apache-2.0
// Turns a runner failure into a user decision: what went wrong, what it blocks,
// and two or more choices with one recommendation and the reason for each.
// The catalog is presentation only. It never approves, edits or reruns anything;
// the parent shows it and waits for the user's real answer.
import path from 'node:path';
import { pluginRoot } from './runtime.mjs';

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
      { id: 'install-guardrails', label: t('テンプレートをコピーして対象のビルド・テストコマンドに合わせる', 'Copy the template and adapt it to this target\'s build/test commands'),
        command: k => `cp ${k}/templates/guardrails.json migration/guardrails.json`,
        reason: t('上流の deny ルールと同じ保護です。設置は人間の判断なので、ご自身で実行・編集してください（AIは作成しません）。', 'It is the upstream deny-rule protection. Installing it is the human\'s decision, so run and edit it yourself; the AI never creates it.') },
      { id: 'waive-guardrails', label: t('制限を設けない理由を記録して免除する', 'Record a waiver with the reason'),
        reason: t('使い捨て環境などで制限が不要な場合だけ。誤ったgit操作や重いビルドを防げなくなります。', 'Only for disposable environments; destructive git and heavy builds are no longer blocked.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'phase-order', match: /Phase (\w+) is not reviewed for current inputs/,
    cause: m => t(`前の工程 ${m[1]} のレビュー記録がない、または入力が変わって失効しています。`, `Phase ${m[1]} has no review record for the current inputs (missing, or invalidated by a change).`),
    impact: t('後の工程は、前の工程を飛ばして進めません。', 'Later phases cannot skip an unreviewed earlier phase.'),
    options: [
      { id: 'review-previous', label: m => t(`工程 ${m[1]} の成果物を確認して完了を記録する`, `Review phase ${m[1]} artifacts and record its completion`),
        command: (k, m) => `node ${k}/scripts/run_migration.mjs phase complete ${m[1]} --note "確認した内容"`,
        reason: t('工程の順番は承認と完了判定の前提です。成果物を確認したうえでの記録が最短の解決です。', 'Phase order underpins approvals and completion; recording the reviewed artifacts is the shortest fix.') },
      { id: 'bundle-spec', label: t('ソースを仕様とする方式なら 00b〜02 をまとめて承認する', 'For source-as-spec, approve 00b–02 together'),
        command: k => `node ${k}/scripts/run_migration.mjs phase complete 00b,01,02 --note "生成した仕様一式を確認"`,
        reason: t('現行環境・仕様書がない案件では、生成した仕様一式を一度に確認できます。', 'Without a runnable original or spec, review the generated specification package once.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'runtime-judge', match: /Prepare runtime judge inputs and original\/mutation\/parity commands|Configure commands\.(original|mutation|parity)/,
    cause: t('runtime方式は、現行実装を実際に動かす比較コマンド（original / mutation / parity）が必要ですが、設定されていません。',
      'Runtime mode needs commands that actually run the original (original / mutation / parity), and they are not configured.'),
    impact: t('比較テストの準備（00b）を完了できません。', 'Judge preparation (00b) cannot be completed.'),
    options: [
      { id: 'switch-source-as-spec', label: t('ソースを唯一の仕様とする方式（source-as-spec）に切り替える', 'Switch to the source-as-spec profile'),
        command: k => `node ${k}/scripts/run_migration.mjs source-spec init`,
        reason: t('現行の実行環境や仕様書がない場合に推奨。ソースから契約とルールを生成し、確認後に変換へ進めます。動作同等性は未検証として引き継ぎます。', 'Recommended when the original cannot run or no spec exists: contracts and rules come from the source, and equivalence is handed off as unverified.') },
      { id: 'configure-runtime', label: t('現行環境の比較コマンドを設定する', 'Configure the original-runtime commands'),
        reason: t('現行環境を動かせるなら、こちらの方が新旧の動作同等性を実際に検証できます。', 'If the original can run, this verifies behavioral equivalence for real.') },
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
  { id: 'copilot-missing', match: /ENOENT|spawn \S*copilot|copilot: (?:command )?not found|Cannot read the Copilot CLI version/,
    cause: t('Copilot CLI（copilot コマンド）を起動できません。CLIワーカー方式は、VS Code から実行する場合も copilot 実行ファイルを使います。',
      'The Copilot CLI (copilot) could not be started. The CLI worker backend uses the copilot executable even when driven from VS Code.'),
    impact: t('変換・レビューのワーカーを起動できません。', 'Translation and review workers cannot start.'),
    options: [
      { id: 'install-cli', label: t('Copilot CLI をインストールしてログインする', 'Install the Copilot CLI and sign in'), command: () => 'npm install -g @github/copilot && copilot',
        reason: t('既定の方式で、ワーカーごとのモデル指定・ツール制限・指示の隔離が実機で確認されています。', 'The default backend; per-worker models, tool limits and instruction isolation are verified on a real CLI.') },
      { id: 'vscode-native', label: t('CLIを使わず VS Code だけで動かす（native方式・実行モデル未検証）', 'Run inside VS Code only (native backend, executed model unverified)'),
        reason: t('CLIを導入できない場合。サブエージェントが実際に使ったモデルは確認できず、記録に「未検証」と残ります。方式の変更なので judge と承認をやり直します。', 'When the CLI cannot be installed. The model a subagent actually ran cannot be confirmed and records say unverified; changing backend restarts judge and approvals.') },
      { id: 'cli-path', label: t('インストール済みの CLI のパスを指定する', 'Point to an installed CLI'), command: k => `node ${k}/scripts/run_migration.mjs doctor --check-cli --copilot /path/to/copilot`,
        reason: t('PATH にない場所へ入っている場合。以降のコマンドにも --copilot を付けます。', 'When it is installed outside PATH; pass --copilot to later commands too.') },
      { id: 'pause', label: pause, reason: pauseWhy }] },
  { id: 'copilot-auth', match: /authenticat|\/login|401|403 Forbidden|not signed in/i,
    cause: t('Copilot CLI がサインインしていない、または認証に失敗しました。', 'The Copilot CLI is not signed in or authentication failed.'),
    impact: t('ワーカーがモデルを呼び出せません。', 'Workers cannot call a model.'),
    options: [
      { id: 'login', label: t('ターミナルで copilot を起動し /login する', 'Start copilot in a terminal and run /login'), command: () => 'copilot',
        reason: t('ワーカーは同じユーザー設定を使うため、一度ログインすれば全担当に反映されます。', 'Workers share the user configuration, so one sign-in covers every role.') },
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
      { id: 'raise-budget', label: t('maxAgentCalls を増やす', 'Raise maxAgentCalls'), reason: t('1回で多く進めたい場合。設定変更のため承認をやり直します。', 'To do more per run; it changes config, so approvals restart.') },
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
  { id: 'timeout', match: /timed out|timeout/i,
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
      { id: 'rerun', label: t('translate を再実行する', 'Rerun translate'), reason: t('一時的な応答崩れは再実行で解消することが多く、完了済みは保持されます。', 'Malformed replies are often transient; finished units are kept.') },
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
  const options = rule.options.map((o, i) => ({ id: o.id, label: pick(o.label, m)[lang], reason: pick(o.reason, m)[lang],
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
