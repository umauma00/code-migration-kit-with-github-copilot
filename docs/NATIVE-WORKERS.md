# VS Codeのサブエージェントで実行する

`workerBackend: "native"` は、現在のVS Codeセッションの親エージェントが
サブエージェントを起動する方式です。Copilot CLIは起動しません。
Node runnerは仕事の発行、結果検証、ファイル反映、独立レビュー、裁定・修正、
承認、完了記録と再開を担当します。

| 場所 | workerBackend | nativeHarness | 導入形態 |
|---|---|---|---|
| VS Code Local | `native` | `vscode-local` | コピー |
| VS Code Copilot（Agent Host） | `native` | `copilot` | プラグインまたはコピー |
| Copilot CLI | `copilot-cli`（省略時） | 不要 | プラグインまたはコピー |

これはVS Code拡張による自動ディスパッチではなく、共通スキルに従って親エージェントが
処理する接続です。runnerだけを起動してもAIは呼ばれず、結果提出を待ちます。
LocalとCopilotでは委譲ツール・モデル指定方法が異なります。
[VS Code公式のサブエージェント説明](https://code.visualstudio.com/docs/agents/run/subagents)も参照してください。

## 初期化・設定

`doctor` は静的な設定・profileの正常性を `staticValid` で表示し、nativeの
実行能力は `executionReady: "unknown"` とします。実モデル情報の取得・起動handle・
完成通知・子のcancelを結ぶ正式adapterはまだありません。nativeのdoctorは終了コード1を返し、
実行確認済みとは表示しません。Nodeの文字列一致はhost metadataの真正性を証明しません。
要求モデルを転記したり、workerの自己申告を実績にしたりしないでください。
費用・利用記録の `observedModel` は、正式な取得経路がなければnull/unknownです。

| 能力 | CLI adapter | VS Code Copilot native | VS Code Local native |
|---|---|---|---|
| 起動 | 独立CLI subprocess | 親が公開host schemaを確認して委譲 | 親が公開host schemaを確認して委譲 |
| 並列 | 共通cap内のNode scheduler | Nodeの発行は並列。host dispatchは未検証 | Nodeの発行は並列。同一ターンcall/群待ちはhost次第 |
| 完成順回収 | 完了したPromiseから回収 | handle/event bridge未実装 | 完了待ちtool callと親の群待ち制約を要確認 |
| 実model | 通常のJSON応答からは不明 | taskと実metadataを結ぶbridge未実装 | 公開mainのtoolMetadataは親向け本文と別。実機の取得経路未検証 |
| 停止 | runnerがCLI process groupを停止 | 親がrunnerと子の両方を停止。子API要確認 | 親がrunnerと子の両方を停止。子API要確認 |

公式mainの観測とインストール済み版を区別します。開始前に要求model/profile/tools、
実metadataの取得方法、task/childの対応、独立context、並列回収、Stop責任を確認し、
確認不能なら未対応を報告してください。公開schemaにない引数を推測して実施済みにしません。
実機では短いA・長いB・A依存Cを使い、対応hostでB終了前にAをsubmitしCを開始できるか、
代替modelの検出、timeout/Stop後の子停止、再開後の古い結果拒否を検証します。


Localのコピー導入例です。プレビュー後、案件初期化の指示に従って `--apply` を追加します。

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target /path/to/project --harness vscode-local --worker-backend native --model MODEL_ID
```

VS Code Copilotのプラグイン導入では次を使います。

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target /path/to/project --layout plugin --worker-backend native --native-harness copilot --model MODEL_ID
```

既存案件では `migration/config.json` に以下を設定します。これは追加項目の抜粋です。
installerは既存設定を変更しません。方式変更後はjudgeとtranslation承認をやり直します。

```json
{
  "workerBackend": "native",
  "nativeHarness": "vscode-local"
}
```

`models` にはホストで選べるモデル名・IDを各役に指定します。自動代替しません。
`concurrency` はホストの同時実行上限以下とし、reviewerを含めた共通上限です。
`timeoutSeconds` はタスク発行から提出までの待ち時間も含みます。

キット更新後はチャットを再起動して新しいプロファイルを読み込んでください。
コピー導入の名前は `migration-native-担当名`、プラグインは
`code-migration-plugin-native-担当名` です。全5役で `tools: []` を維持します。
CLI用プロファイルは別に残ります。
プラグインnativeでは完全修飾IDと非修飾名の両方を予約し、案件・祖先・個人設定で
同じ名前またはファイル由来IDを使う別エージェントがあればdoctorと起動前検査で停止します。

native設定の `doctor` はCLIを起動せず専用プロファイルを検査します。
`--check-cli` が付いていても同じです。ホストでのプロファイル解決・モデル利用可否・
実際のツール制限は、Nodeからの検査では保証しません。

### モデルの指定と確認

Localでは `runSubagent` のモデル引数、Copilotではホストに公開された委譲ツールの
呼び出し単位のモデル引数を使います。プロンプトにモデル名を書くことは指定の代わりに
なりません。呼び出し単位の指定ができないホストでは、そのジョブを失敗として報告します。
[VS Code Localの選択順](https://code.visualstudio.com/docs/agents/run/subagents#select-the-model-for-a-subagent)と
[Copilotランタイムの選択順](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#custom-agent-frontmatter-fields)
には呼び出し単位の指定が記載されています。共有プラグインのプロファイルへ案件固有の
モデルを焼き込む必要はありません。

Copilotランタイムは指定を実現できない場合に別モデルへフォールバックすることがあるため、
指定できたことだけでは十分ではありません。提出前にホストが返す実行メタデータで
使用モデルを確認します。要求値と異なる、確認できない、表記の対応が不明な場合は `fail`。
`submit --model` には確認したモデルを指定し、要求の `model` をそのまま写したり、
モデル自身の回答を使用モデルの証明として扱ったりしません。
ホストによる申告をNodeが独立に検証する仕組みではないため、receiptの
`observedModel` は引き続きnullです。

## 親エージェントの実行手順

プラグイン導入では、以下の `migration-kit/` をロードしたスキルから解決した
プラグイン絶対パスへ置き換えます。cwdは対象リポジトリです。

1. 専用nativeプロファイル、ツールなしの実行、設定モデル、並列上限を確認する。
   使用できなければ理由を報告し、CLIへ黙って切り替えない。
2. 変換承認後、`translate`（修正なら `repair --target ... --evidence ...`）を
   ターミナルの継続実行機能で起動する。ターミナル/PIDを保持する。
   親をrunnerの終了待ちで塞がない。
3. `list` のpendingタスクを空き枠分だけ `claim` する。
4. claim結果の `agent`（完全修飾ID）または `agentName`（名前で選択するホスト）
   の専用サブエージェントへ、ホストの実際のモデル引数に `model` を指定して
   `prompt` をそのまま渡す。
   親会話の継承を要求せず、他レビュー・ログ・説明を追加しない。
5. 返ったJSONを要約・修正せず提出する。取得時のtask IDとclaimTokenを使う。
   使用モデルは上記のとおりホストの実行メタデータで確認する。
   親がpassを作ったり、対象ファイルへ直接書いたりしない。
6. モデルを起動できない、不正な応答などは `fail` で失敗を提出する。
   親自身が代役をしない。修正が必要ならrunnerが別タスクを発行する。
7. runner終了まで繰り返す。一覧が空でも検査や次タスク発行中の場合がある。
   終了コード・summary・`status` を確認し、レビュー済みdone/totalを報告する。
   build以降の工程へは別途承認なしに進まない。

```bash
# ターミナルで継続実行。親は終了待ちで塞がない
node migration-kit/scripts/run_migration.mjs translate

# 親が別のツール呼び出しで繰り返す
node migration-kit/scripts/native_workers.mjs list
node migration-kit/scripts/native_workers.mjs claim --task TASK_ID

# 親が受信したJSONをタスク配下の専用ファイルへそのまま保存して提出
node migration-kit/scripts/native_workers.mjs submit --task TASK_ID --claim CLAIM_TOKEN --model HOST_MODEL_ID --file migration/runs/RUN_ID/native/JOB_ID/answer.json

# 起動失敗等を報告
node migration-kit/scripts/native_workers.mjs fail --task TASK_ID --claim CLAIM_TOKEN --error "Requested model is unavailable"
```

`--file -` なら標準入力から提出できます。コード中のバッククォート・`$()` 等を
シェルに解釈させないよう、JSONの保存にはホストのファイル編集ツールか標準入力を
使います。`answer.json` は親の転送用データで、ワーカーには編集権限を与えません。

## 契約と再開

- タスクは実行ID・役割・対象・入力ハッシュ・候補ハッシュ・実行ロックに結び付く。
  claimは排他的、submitは一度だけ。対象違い・モデル違い・期限切れ・古い実行の結果・
  不正JSONを拒否する。`accepted: true` は受付であり、完了receiptではない。
- 両reviewerには同一の固定入力を渡す。実装・裁定・修正にも監査済み依存閉包を渡す。
  CLI担当のような追加検索はできない。資料不足は工程外で依存宣言やルールを修正し、
  再検証・再承認する。入力上限超過は切り詰めず停止する。
- 停止はrunnerのターミナルでキャンセル/Ctrl+C。Nodeはホストのサブエージェントを
  強制終了できないので、親はそちらも停止する。遅い結果を再開後の新しいタスクへ
  転用しない。ワーカーはツールなしなので直接編集できない構成にする。
- 再開は `translate` を再実行する。新しいタスクIDを発行し、有効なreceiptだけを
  再利用する。部分出力には不足するレビューを実行する。異常終了のロックは所有
  プロセスの終了確認後に、既存の `unlock --pid` で解除する。
  `list` は実行ロックのrun IDに対応するタスクだけを列挙する。壊れた過去のrequestや
  異常終了で閉じられなかった過去タスクは再開を妨げず、現在の未完了requestの破損はエラーになる。
- nativeはCLIの `--no-custom-instructions` 相当の隔離を保証しない。
  receiptに `instructionIsolation: "host-managed"` と実行方式を記録する。
  ルート指示・GitHub指示・スキル等は追跡するが、ホスト設定・祖先・個人指示まで
  自動検出しない。追加の案件内指示は `verificationInputs` へ登録し、ホスト設定変更時も
  再検証する。別コンテキストと暗黙指示ゼロは同義ではない。
- `hostReportedModel` は親の申告値。実測モデル・トークン・creditsはnull。
- Dynamic Workflowsからnativeを起動しない。nativeは現在のホストセッション、
  CLI方式は既存のCLIアダプターを使用する。

## 検証範囲

[native-workers.test.mjs](../tests/native-workers.test.mjs) は並列処理、固定レビュー入力、
裁定・修正、中断・再開、古い提出の拒否、入力変更、モデル不一致、標準入力転送を
検証します。応答は用意済みですが、題材のPython/Nodeでbuild/smoke/parityを実行します。
実VS Codeのモデル委譲・プロファイル解決・ツール制限は別途の実環境検証です。

実案件前に、小規模題材で全5役の選択、モデル指定、ツールが空であること、両reviewerの
固定入力、キャンセル・再開、未承認の次工程へ進まないことを確認してください。

## VS Code orchestration and verification modes

The user-facing parent owns phase TODO, questions and native job dispatch.
Status is read-only and available after initialization: `status --format markdown`
shows artifact candidates separately from validation, current reviewed units,
active lock/run roles, blockers and next actions. It never grants approval.
Use [source-only verification](SOURCE-ONLY.md) when the original runtime
is unavailable; runtime remains the default. Use [built-in Rubber Duck](RUBBER-DUCK.md)
only through host capabilities, with advisory decisions and existing repair/review.
Live VS Code rendering, native model dispatch and Stop behavior remain pending
until checked on a real host. Models and existing execution limits are unchanged.

## Dispatch, cancellation and resumption

Start the runner in a continuing terminal. Keep servicing list/claim/delegate/submit
from the top-level parent rather than awaiting terminal completion. All two-reviewer
and implementation/fix/arbiter calls use the existing global concurrency cap.
Available unit slots refill without waiting for an entire wave. Audited transitive
manifest dependencies finish before dependent units start; non-manifest dependencies
are fixed source. Cycles without unit typecheck consume fixed source as a group;
cycles with unit typecheck fail with paths and a grouping/defer-check remedy.

Use existing cancellation only. VS Code Stop does not guarantee continuing terminals
or subagents have stopped. If runner activity continues, send Ctrl+C to its terminal
and stop host children too. Check status/processes before rerunning translate.
Never unlock a live runner. Resume via translate; valid completed receipts and the
one successful independent review are reused, stale native submissions rejected.
No pause/resume/timebox or batch-stop command is introduced.
