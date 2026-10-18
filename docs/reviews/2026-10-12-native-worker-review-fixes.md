# Native workerレビュー4件の精査と修正

> アーカイブ：0.3.0で削除したnative（VS Codeサブエージェント）ワーカー方式を扱う記録です。
> 参照先の `docs/NATIVE-WORKERS.md`、`lib/native-workers.mjs`、`tests/native-workers.test.mjs` は現在存在しません。

2026-10-12。未コミットのnative worker対応に対する4件の指摘を、実装、回帰テスト、
現行の公式仕様で再確認した。1件は根拠を訂正して運用手順を補強し、3件を修正した。

## 1. モデル指定：指摘の前提を訂正し、実行確認の手順を補強

「Copilotではプロファイルの `model` だけが確実な指定手段」という前提は採用しない。
[Copilotランタイムの公式仕様](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#custom-agent-frontmatter-fields)
には、`task` とSDKの `session.startSubagent` のいずれでも呼び出し単位の明示値が
優先されることが記載されている。
[VS Code Localの公式仕様](https://code.visualstudio.com/docs/agents/run/subagents#select-the-model-for-a-subagent)
にも `runSubagent` のモデル引数がある。共有プラグインに案件ごとのモデルを
焼き込む変更は不要と判断した。ただし、各VS Codeホストで同じ引数が公開されるとは
推定せず、利用できるホストだけを対象とする。

一方、要求したモデルと実際に使用されたモデルは区別する必要がある。
Copilotの仕様には指定を実現できない場合のフォールバックも記載されている。
native手順（`docs/NATIVE-WORKERS.md`）、各スキル、orchestratorに、
実際のモデル引数で指定し、ホストの実行メタデータを確認してから提出する手順を追加した。
メタデータがない・不一致・対応が曖昧なら `fail` とし、要求値の単純な転記や
モデル自身の自己申告は確認として扱わない。

この接続はホストによる申告を信頼する設計であり、Nodeが実モデルを独立に検証したとは
主張しない。`hostReportedModel` と `observedModel: null` の区別は維持する。
モデル指定・確認のできないホストではこのnative経路を完了させない。

## 2. プラグイン名の衝突：採用・修正

[nativeプロファイル検査](../../lib/review.mjs)から、完全修飾IDに加えてホストへ渡す
`agentName` も[衝突検査](../../lib/runtime.mjs)へ渡すようにした。
案件・祖先・個人の探索範囲で、名前またはファイル由来IDが重複すればdoctorと
ワーカー起動前に拒否する。CLI専用ワーカーは完全修飾IDのみを使うため、従来の
非修飾名の共存を維持する。

## 3. 初期化コマンド：採用・修正

[プラグインスキル](../../skills/code-migration/SKILL.md)と[導入手順](../PLUGIN.md)で、
VS Code Copilotの初期化に `--worker-backend native --native-harness copilot` を明示した。
Copilot CLIは `--worker-backend copilot-cli` とし、Localはコピー導入へ案内する。
既存設定を上書きしないinstallerの動作は維持した。

## 4. 過去タスクの破損：採用・修正

実行ロックに[runnerのrun ID](../../lib/pipeline.mjs)を保存し、
タスク一覧（`lib/native-workers.mjs`）はその実行だけを列挙するようにした。
過去runのrequestを解析しないため、壊れた履歴や異常終了で閉じられなかったタスクも
再開を妨げない。現在の未完了requestが壊れている場合は引き続きエラーにする。
claim・submitとadapterも実行ロックのrun IDに結び付ける。

## 検証結果

- 追加回帰テスト（`tests/native-workers.test.mjs`）で、指摘2・4の修正前の失敗を再現。
- 修正後の `npm test`：112件中111成功、失敗0、skip 1
  （大文字小文字を区別するファイルシステム専用ケース）。
- 過去runの破損を無視した再開と、現在のrequest破損の拒否の両方を確認。
- 非修飾名・完全修飾ID・ファイル由来IDの衝突を確認。既存CLIの名前共存テストも成功。
- nativeプラグイン初期化のプレビュー、設定値、再実行時の既存設定保持を確認。
- 全体テストには用意済み応答によるCLI/nativeの変換・裁定・修正・再開、
  実際の題材でのbuild/smoke/parityが含まれる。実AIは呼び出していない。

実VS Code上のモデル選択、エージェント解決、ツール制限はこの検証に含まない。
この変更で実ホストの動作確認が済んだとは扱わない。

## コミット前の追加検証：実行ロックの公開競合

全体テストの再実行で、runnerが実行ロックを作成した直後、JSONを書き込む前に
nativeクライアントが読み取って失敗するケースを検出した。
[ロック取得](../../lib/core.mjs)を、別ファイルへ完全なJSONを書き込んでから
ハードリンクで排他的に公開する方式へ変更した。既存ロックは上書きしない。

追加回帰テスト（`tests/native-workers.test.mjs`）で公開直後の読み取りを
決定的に再現し、修正前の失敗と修正後の成功を確認した。同時取得の拒否、
既存ロックの保持、一時ファイルの後片付けも検証した。
最終の `npm test` は113件中112成功、失敗0、skip 1。
