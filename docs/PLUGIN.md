# Copilotプラグインとして使う

日本語 | [English](PLUGIN.en.md)

Node.js 22以上、Agent Plugins 1.0対応のVS Code / GitHub Copilotを使います。CLIワーカー方式にはログイン済みCopilot CLIが必要です。Copilot CLIなしでVS Codeだけで進める場合は [native方式](NATIVE-WORKERS.md)（実行モデル未検証として記録）を選べます。確認したCLIは1.0.93・1.0.95・1.0.98です。移行対象の言語環境とテストも必要です。

## インストール

このブランチの0.2.0を含むcheckoutを、移行対象リポジトリとは別の場所に用意します。キット本体を移行対象に配置する必要はありません。

```bash
copilot plugin marketplace add /path/to/code-migration-kit
copilot plugin install code-migration-kit@code-migration-kit-marketplace
copilot plugin list
```

VS CodeはCLIの `~/.copilot/installed-plugins/` を検出します。`chat.plugins.enabled` を有効にし、Agent Pluginsの一覧を確認してください。ローカルのマーケットプレイスから導入したプラグインはcheckoutを直接読みます。変更後はチャットを再起動してください。

開発中のcheckoutは、VS Codeのユーザー設定からも登録できます。

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/path/to/code-migration-kit": true
  }
}
```

同じプラグインは一つの導入元で管理してください。複数版を同時登録すると、先に見つかったエージェント・スキルが使われます。旧コピー導入の `.github/skills/code-migration/` も同名スキルとして優先されます。移行する場合は既存データを保存し、旧スキルを明示的に外して `migration/config.json` に `"runtime": "plugin"` を設定してください。既存の承認・完了記録は再確認が必要です。

Git配布が整った後はマーケットプレイスのGit URLを登録できます。リポジトリの既定ブランチにもこの形式が入ってから、`Chat: Install Plugin From Source` にGit URLを指定する方法が使えます。

## 新しい案件を開始する

移行対象リポジトリをVS Codeで開き、Copilotチャットで「code-migrationスキルを使ってPythonからJavaScriptへ移行を開始して」などと依頼します。利用できるモデルIDを指定してください。スキルは初期化と設定を確認し、事前調査から一工程ずつ進めます。

手動で初期化する場合は、対象リポジトリをcwdにして以下を実行します。`MODEL_ID` はアカウントで利用可能なモデルIDへ置き換えます。

各工程の最後に、Copilotは成果物へのリンク・確認ポイント・次の工程・返信例を報告します。追加の判断が必要な場合、利用可能な質問ツールで「次へ進む／修正する／中断する」を確認します。質問ツールが使えない環境では同じ選択肢をチャットに表示して返信を待ちます。すでに明示した指示は繰り返し確認しません。本番変換・ビルド・smoke・parityには、現在の成果物に対する承認を明示します。詳細と例は [工程末の報告と確認](PHASE-HANDOFF.md) を参照してください。

開始・再開時には、親の調整エージェントがCopilotのTODOに10工程の一覧を作り、現在の工程・承認待ち・修正中・停止を表示します。工程末の報告にも完了した工程数と次の工程を含めます。再開時は保存した成果物・検証記録を確認して更新し、TODOのチェックだけで承認・完了と判断しません。TODOが使えない環境ではチャットの一覧に切り替えます。詳細は [工程のTODO表示](PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list) を参照してください。

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --worker-backend copilot-cli --model MODEL_ID --language ja
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --worker-backend copilot-cli --model MODEL_ID --language ja --apply
```

VS Code・Copilot CLIのどちらから開始する場合も、CLIワーカー方式（`copilot-cli`）を使います。VS Codeでも、親エージェントがターミナルでrunnerを動かし、runnerがCopilot CLIのワーカーを起動します。native方式は**実験的**です（[native方式](NATIVE-WORKERS.md)を参照）。既存案件の方式は初期化で切り替えません。

作成するのは `migration/config.json`、`migration/RULEBOOK.md`、`migration/inventory.tsv` の3ファイルと、`--language` を指定した場合の `migration/preferences.json`（報告の言語）です。設定済みの案件ではモデルやルールを上書きしません。初期化は工程を承認しません。言語、元ソース・出力・テストの場所、検証コマンドを設定してください。

プラグイン内のスクリプトには絶対パスを指定し、実行ディレクトリは対象リポジトリにします。

```bash
node /path/to/code-migration-kit/scripts/run_migration.mjs doctor --check-cli
node /path/to/code-migration-kit/scripts/run_migration.mjs status
```

新規案件ではphase 01で依存マップを作るまでdoctorに不足が表示されます。以降の成果物・実行記録・承認は対象の `migration/`、変換結果は設定した `outputRoots` に保存します。プラグインの更新、案件側の `.github/hooks/`・`.github/agents/`・`.claude/agents/` の変更で、既存の承認と完了判定が失効します。hookが参照する、対象リポジトリ内の追加スクリプト等は `verificationInputs` に指定して追跡してください。

## 実行方式と検証範囲

`plugin.json` と `skills/` はAgent Plugins 1.0形式です。従来の6役、native専用の5ワーカー、CLI用hooksは `com.github.copilot/` に配置しています。既定のCLI方式ではプラグインを `--plugin-dir` で明示し、`--agent code-migration-kit:code-migration-plugin-担当名` で選択します。レビュー担当は固定入力のみ・ツールなし、他担当も読み取りだけです。出力はNodeの調整役が書き込みます。

**VS Codeだけで動かす**：VS Code Copilotで初期化に `--worker-backend native --native-harness copilot` を指定すると、ホストの親エージェントがnative専用サブエージェントを起動します。VS Codeは実行したモデルを親に返さないため、新規導入では `nativeModelVerification: requested-unverified` となり、要求モデルを記録して実行モデルは未検証として残します。全ワーカーはツールなしで、入力・結果をNode runnerと受け渡します。導入後はチャットを再起動して新しいプロファイルを読み込み、[native手順](NATIVE-WORKERS.md)に従ってください。既存設定はinstallerで上書きしません。

案件・親ディレクトリ・個人設定のカスタムエージェントに、上記の完全修飾名を `name` またはファイル由来IDとして使う定義がある場合、doctorとワーカー起動前の検査で停止します。YAMLの引用符・折り畳み・別名参照も解釈し、サブディレクトリのMarkdownも確認します。非修飾の `code-migration-plugin-担当名` は別の名前として共存できます。検査対象は通常のUTF-8ファイルです。YAMLを解析できない定義やシンボリックリンクは、検査不能として停止します。

native専用ワーカーはホストでの名前選択にも対応するため、非修飾の
`code-migration-plugin-native-担当名` も予約します。同名のローカルエージェントは
ツールやモデル設定にかかわらず拒否します。CLI用ワーカーの非修飾名共存は従来どおりです。

`--no-custom-instructions` は、信頼済み案件のhooksを無効化する指定ではありません。案件hooksは承認時に監査し、固定入力レビューへ別の文脈や他担当の結果を追加しないことを確認してください。案件側hooksの追加・変更・削除後は、judgeと承認を再確認してから再開します。

このプラグインはCopilot実行方式を対象とします。VS Code Local用hooksと実験的Dynamic Workflows拡張は従来のコピー導入で選択してください。

自動テストでは案件側に `.github/` や `migration-kit/` を置かずに、3ファイルの変換・独立レビュー・build/smoke/parityを確認します。モデル応答はテスト用です。実CLIでのプラグイン認識・マーケットプレイス導入・担当の名前付きID解決も確認しています。これは `node tests/verify_plugin.mjs /absolute/path/to/copilot` で再確認できます。外部AIは呼びません。`doctor --check-cli` も、ワーカーと同じ条件で全担当IDが解決できるかを確認します。

担当の衝突とhook変更後の失効は、`node tests/verify_plugin_resolution.mjs /absolute/path/to/runtime.node` でCLI 1.0.93の実際の探索・選択・hook APIと照合できます。この内部APIへの依存は検証用スクリプトだけです。

macOSの実CLI（1.0.95・1.0.98）と疑似プロバイダーの間で、プラグイン方式の変換・独立レビュー（ツール付きレビューを含む）・ガードレールhookによる拒否を確認しました。古いCLI（1.0.40）はプラグインのエージェントを読み込めず、`doctor` が不足する担当IDを報告します。VS Code UIと認証済み実モデルでの移植品質は未検証です。実案件の前に [LIVE-SMOKE.md](LIVE-SMOKE.md) の小規模確認を行い、同文書の `migration-kit/` をプラグインの絶対パスへ読み替えてください。
