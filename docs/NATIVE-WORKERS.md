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
