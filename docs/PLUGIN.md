# Copilotプラグインとして使う

Node.js 22以上、Agent Plugins 1.0対応のVS Code / GitHub Copilot、ログイン済みCopilot CLIを使います。確認したCLIは1.0.93です。移行対象の言語環境とテストも必要です。

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

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --model MODEL_ID
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --model MODEL_ID --apply
```

作成するのは `migration/config.json`、`migration/RULEBOOK.md`、`migration/inventory.tsv` の3ファイルです。設定済みの案件ではモデルやルールを上書きしません。初期化は工程を承認しません。言語、元ソース・出力・テストの場所、検証コマンドを設定してください。

プラグイン内のスクリプトには絶対パスを指定し、実行ディレクトリは対象リポジトリにします。

```bash
node /path/to/code-migration-kit/scripts/run_migration.mjs doctor --check-cli
node /path/to/code-migration-kit/scripts/run_migration.mjs status
```

新規案件ではphase 01で依存マップを作るまでdoctorに不足が表示されます。以降の成果物・実行記録・承認は対象の `migration/`、変換結果は設定した `outputRoots` に保存します。プラグインの更新、案件側の `.github/hooks/`・`.github/agents/`・`.claude/agents/` の変更で、既存の承認と完了判定が失効します。hookが参照する、対象リポジトリ内の追加スクリプト等は `verificationInputs` に指定して追跡してください。

## 実行方式と検証範囲

`plugin.json` と `skills/` はAgent Plugins 1.0形式です。6役のエージェントとCLI用hooksは `com.github.copilot/` に配置しています。自動ワーカーはCLIで起動し、プラグインを `--plugin-dir` で明示し、`--agent code-migration-kit:code-migration-plugin-担当名` で選択します。レビュー担当は固定入力のみ・ツールなし、他担当も読み取りだけです。出力はNodeの調整役が書き込みます。

案件・親ディレクトリ・個人設定のカスタムエージェントに、上記の完全修飾名を `name` またはファイル由来IDとして使う定義がある場合、doctorとワーカー起動前の検査で停止します。YAMLの引用符・折り畳み・別名参照も解釈し、サブディレクトリのMarkdownも確認します。非修飾の `code-migration-plugin-担当名` は別の名前として共存できます。検査対象は通常のUTF-8ファイルです。YAMLを解析できない定義やシンボリックリンクは、検査不能として停止します。

`--no-custom-instructions` は、信頼済み案件のhooksを無効化する指定ではありません。案件hooksは承認時に監査し、固定入力レビューへ別の文脈や他担当の結果を追加しないことを確認してください。案件側hooksの追加・変更・削除後は、judgeと承認を再確認してから再開します。

このプラグインはCopilot実行方式を対象とします。VS Code Local用hooksと実験的Dynamic Workflows拡張は従来のコピー導入で選択してください。

自動テストでは案件側に `.github/` や `migration-kit/` を置かずに、3ファイルの変換・独立レビュー・build/smoke/parityを確認します。モデル応答はテスト用です。実CLIでのプラグイン認識・マーケットプレイス導入・6担当の名前付きID解決も確認しています。これは `node tests/verify_plugin.mjs /absolute/path/to/copilot` で再確認できます。外部AIは呼びません。

担当の衝突とhook変更後の失効は、`node tests/verify_plugin_resolution.mjs /absolute/path/to/runtime.node` でCLI 1.0.93の実際の探索・選択・hook APIと照合できます。この内部APIへの依存は検証用スクリプトだけです。

このクラウド環境では実CLIのセッション開始がファイル監視の資源上限（`Too many open files`）で止まり、疑似プロバイダーとのプラグイン通信は完了していません。VS Code UIと認証済み実モデルでの移植品質も未検証です。実案件の前に [LIVE-SMOKE.md](LIVE-SMOKE.md) の小規模確認を行い、同文書の `migration-kit/` をプラグインの絶対パスへ読み替えてください。
