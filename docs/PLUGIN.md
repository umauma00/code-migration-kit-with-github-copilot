# Copilotプラグインとして使う

日本語 | [English](PLUGIN.en.md)

Node.js 22以上、Agent Plugins 1.0に対応したGitHub Copilot CLI・VS Code・GitHub Copilot appのどれかを使います。ワーカーは常にCopilot CLIで動くため、VS Codeやappから進める場合もCopilot CLIが必要です（未導入ならAIが同意を得てインストールし、サインインを始めます）。実際の CLI と疑似のモデルでの通信は 1.0.93〜1.0.98 で確認しています。2026-10-31 時点の最新版 1.0.105 でも、キットが CLI に渡すオプションはすべて有効です（`copilot --help` で確認）。移行対象の言語環境とテストも必要です。

## インストール

GitHub Copilot CLI・VS Code・GitHub Copilot app の3つとも、同じマーケットプレイスから同じプラグインを入れます。識別子は `code-migration-kit@code-migration-kit-marketplace` です。キットは Agent Plugins 1.0 形式（ルートの `plugin.json`、`skills/`、`com.github.copilot/` の担当・hooks）で、3つともこの配置を読みます（2026-10-29 時点の GitHub・VS Code 公式文書で確認）。キット本体を移行対象リポジトリに置く必要はありません。

マーケットプレイスの登録元は次のとおりです（リポジトリの既定ブランチ main）。0.18.0 以前の案内で `#feat/github-copilot-migration-kit` 付きで登録した場合は、そのブランチが残っている間は引き続き入れられますが、今後の更新は main に入ります。切り替える手順は [UPGRADING.md](UPGRADING.md) を参照してください。

```text
umauma00/code-migration-kit-with-github-copilot
```

同じプラグインは一つの導入元で管理してください。複数の方法（マーケットプレイス・ローカルcheckout・`chat.pluginLocations`）で同時に登録すると、オーケストレーターが2つ並び、先に見つかった方が使われます。旧コピー導入の `.github/skills/code-migration/` も同名スキルとして優先されます。移行する場合は既存データを保存し、旧スキルを明示的に外して `migration/config.json` に `"runtime": "plugin"` を設定してください。既存の承認・完了記録は再確認が必要です。

### GitHub Copilot CLI

```bash
copilot plugin marketplace add umauma00/code-migration-kit-with-github-copilot
copilot plugin install code-migration-kit@code-migration-kit-marketplace
copilot plugin list
```

更新は `copilot plugin marketplace update code-migration-kit-marketplace` の後に `copilot plugin update code-migration-kit` です。手元のcheckoutを使う場合は `copilot plugin marketplace add /path/to/code-migration-kit` で登録します。ローカルのマーケットプレイスから入れたプラグインはcheckoutを直接読み、変更は新しいセッション（または `/restart`）で反映されます。

### VS Code

設定 `chat.plugins.enabled` を有効にし、次のどれか一つで入れます。

1. コマンドパレットの **Chat: Open Customizations** → **Browse** → 入手元メニューの **Configure Marketplaces** → **Add Marketplace** で上の登録元を入力し、**Browse** で `code-migration-kit` を **Install** します。設定 `chat.plugins.marketplaces` に同じ値を書いても登録できます。
2. Copilot CLI で入れたプラグイン（`~/.copilot/installed-plugins/`）は VS Code が自動で検出し、Customizations の **Plugins** に表示します。
3. 開発中のcheckoutは、ユーザー設定の `chat.pluginLocations` で登録します（実験的な設定）。

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/path/to/code-migration-kit": true
  }
}
```

Copilot 実行方式のチャットで使える `/plugin` コマンドは、Customizations 画面と別の一覧を持ちます。入れた画面で管理してください。

VS Code でセッションを始めるときは次のようにします（VS Code 1.144、2026-10-31 時点の公式文書で確認）。

- 実行方式（harness）は **Copilot** にします。1.144 では新しいセッションの既定です。プラグインはこの実行方式で読まれます。**Local** は 1.144 では既定で表示されず、Agents window では使えません。Local を使う場合はコピー導入に `--harness vscode-local` を付けます（[詳しい使い方](REFERENCE.md#コピー導入で置かれるもの)）。
- チャットビューでも **Agents window** でも、エージェントの選択欄で `code-migration-plugin-orchestrator` を選びます。
- Agents window では、分離方法を **Folder** にします。**New Worktree** のセッションは常に「Allow all」で動き、確認ダイアログが出ません。キットの承認は確認ダイアログで人が許可する前提なので、使わないでください。New Worktree はコミット済みのファイルから始まるため、まだコミットしていない `migration/` も引き継がれません。
- 権限は **Manual permissions**（既定）か **Assisted permissions** にします。**Allow all** では確認が出ません。
- 通しで自動に進めたいときは、初期設定で自動モードを選び、初期設定が終わってから autopilot モードに切り替えて「続けて」と送ります。

### GitHub Copilot app

1. サイドバーの **Customize** を開き、マーケットプレイスの選択欄の横にあるマーケットプレイス設定から、上の登録元を GitHub リポジトリとして追加します。リンク `ghapp://plugins/marketplace/add?source=umauma00%2Fcode-migration-kit-with-github-copilot` を開くと入力済みのフォームが出ます（確認後に追加）。
2. **Customize** で `code-migration-kit` を検索して **Install** します。リンク `ghapp://plugins/install?source=code-migration-kit%40code-migration-kit-marketplace` でも開けます。**Installed** で有効になっていることを確認してください。

app でセッションを始めるときは次のようにします。

- **Environment** は **This computer** にします。キットは手元の Copilot CLI でワーカーを動かし、移行の記録を手元のファイルに書くためです（Cloud は未確認）。
- **Workspace** は **Current checkout** にします。**New worktree** はセッションごとに別の作業コピーを作り、未コミットの `migration/` が引き継がれません。別のワークツリーに移行がある状態で初期化しようとすると、初期化のプレビューがその場所（`existingMigrations`）を返し、オーケストレーターがそちらで再開するか質問します。
- エージェントの選択欄（または `/agent`）で `code-migration-plugin-orchestrator` を選びます。通しで自動に進めたいときは、初期設定で自動モードを選び、初期設定が終わってから autopilot モードに切り替えて「続けて」と送ります。
- ツールの権限は **Ask every time** か **Assisted** にします。ゲートのコマンドは確認を前提にしています。**Approve all** で確認が出るかは未確認です。
- ローカルのサンドボックスが有効なセッションでワーカーがネットワークやサインインに届かない場合は、そのセッションで `/sandbox off` にします。オフにするとそのセッションのコマンドはサンドボックスの制限なしで動くため、信頼できるリポジトリでだけ行ってください。

### 社内の Git サーバーから入れる

GitLab などに置いたcheckoutも、Git URL（`https://git.example.com/group/code-migration-kit.git` や `git@git.example.com:group/code-migration-kit.git`）を登録元にすれば3つとも追加できます（文書上。実機は未確認）。`#ブランチ` の指定が文書にあるのは `owner/repo` 形式だけなので、キットはそのサーバーの既定ブランチに置いてください。認証は手元の git の設定に従うと見られます。先にターミナルで `git clone` が通ることを確かめてください。組織の管理設定でマーケットプレイスが制限されている場合は追加できません。

### 案件で既定にする（任意）

移行対象リポジトリの `.github/copilot/settings.json` に次を書くと、そのリポジトリで作業する人の Copilot CLI・VS Code（Copilot 実行方式）・app で既定で有効になります。各自のオフ設定や組織の管理設定が優先されます。

```json
{
  "extraKnownMarketplaces": {
    "code-migration-kit-marketplace": {
      "source": { "source": "github", "repo": "umauma00/code-migration-kit-with-github-copilot" }
    }
  },
  "enabledPlugins": {
    "code-migration-kit@code-migration-kit-marketplace": true
  }
}
```

### 調べた一次情報（2026-10-29。VS Code のセッションの設定は 2026-10-31 に再確認）

- GitHub Docs: [Customizing the GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app)、[Opening the app with deep links](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links)、[Agent sessions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
- GitHub Docs: [Finding and installing plugins for Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)、[CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)、[Plugins](https://docs.github.com/en/copilot/concepts/customizations/plugins)
- VS Code: [Agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)、[Agent plugin reference](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference)、[Agent harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses)、[Agents window](https://code.visualstudio.com/docs/agents/run/agents-window)、[Approvals](https://code.visualstudio.com/docs/agents/run/approvals)、[1.144 リリースノート](https://code.visualstudio.com/updates/v1_144)

## 新しい案件を開始する

移行対象リポジトリを開き、エージェントの選択欄（Copilot CLI と app では `/agent` も可）で `code-migration-plugin-orchestrator` を選んで、「PythonからJavaScriptへ移行を開始して」などと依頼します。オーケストレーターは報告の言語を聞いて初期化し、モデルなどを1問ずつ聞いてから、事前調査から一工程ずつ進めます。

手動で初期化する場合は、対象リポジトリをcwdにして以下を実行します（モデルは導入後に質問で選びます）。

各工程の最後に、Copilotは成果物へのリンク・確認ポイント・次の工程・返信例を報告します。追加の判断が必要な場合、利用可能な質問ツールで「次へ進む／修正する／中断する」を確認します。質問ツールが使えない環境では同じ選択肢をチャットに表示して返信を待ちます。すでに明示した指示は繰り返し確認しません。本番変換・ビルド・smoke・parityには、現在の成果物に対する承認を明示します。詳細と例は [工程末の報告と確認](PHASE-HANDOFF.md) を参照してください。

開始・再開時には、親の調整エージェントがCopilotのTODOに10工程の一覧を作り、現在の工程・承認待ち・修正中・停止を表示します。工程末の報告にも完了した工程数と次の工程を含めます。再開時は保存した成果物・検証記録を確認して更新し、TODOのチェックだけで承認・完了と判断しません。TODOが使えない環境ではチャットの一覧に切り替えます。詳細は [工程のTODO表示](PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list) を参照してください。

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --language ja
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --language ja --apply
```

VS Code・Copilot CLI・GitHub Copilot appのどれから開始する場合も、親エージェントがターミナルでrunnerを動かし、runnerがCopilot CLIのワーカーを起動します。これらのコマンドもAIがチャットから実行します。

作成するのは `migration/config.json`、`migration/RULEBOOK.md`、`migration/inventory.tsv` の3ファイルと、`--language` を指定した場合の `migration/preferences.json`（報告の言語）です。設定済みの案件ではモデルやルールを上書きしません。初期化は工程を承認しません。モデル、言語、元ソースの場所、工程の進め方、元のコードが動くかは AI が質問で聞き、`run_migration.mjs settings init` が作る `migration/run-settings.json` に書き込みます。出力・テストの場所や検証コマンドなど残りの欄と後からの変更はこのファイルで行い、`settings apply` で反映します。

プラグイン内のスクリプトには絶対パスを指定し、実行ディレクトリは対象リポジトリにします。

```bash
node /path/to/code-migration-kit/scripts/run_migration.mjs doctor --check-cli
node /path/to/code-migration-kit/scripts/run_migration.mjs status
```

新規案件では、phase 01を記録するまで、doctorは依存宣言を `pending`（まだ不要）と表示します。以降の成果物・実行記録・承認は対象の `migration/`、変換結果は設定した `outputRoots` に保存します。プラグインの更新、案件側の `.github/hooks/`・`.github/agents/`・`.claude/agents/` の変更で、既存の承認と完了判定が失効します。hookが参照する、対象リポジトリ内の追加スクリプト等は `verificationInputs` に指定して追跡してください。

## 実行方式と検証範囲

`plugin.json` と `skills/` はAgent Plugins 1.0形式です。担当プロファイルとCLI用hooksは `com.github.copilot/` に配置しています。runnerはプラグインを `--plugin-dir` で明示し、`--agent code-migration-kit:code-migration-plugin-担当名` で選択します。レビュー担当は固定入力のみ・ツールなし、他担当も読み取りだけです。出力はNodeの調整役が書き込みます。

案件・親ディレクトリ・個人設定のカスタムエージェントに、上記の完全修飾名を `name` またはファイル由来IDとして使う定義がある場合、doctorとワーカー起動前の検査で停止します。YAMLの引用符・折り畳み・別名参照も解釈し、サブディレクトリのMarkdownも確認します。非修飾の `code-migration-plugin-担当名` は別の名前として共存できます。検査対象は通常のUTF-8ファイルです。YAMLを解析できない定義やシンボリックリンクは、検査不能として停止します。

`--no-custom-instructions` は、信頼済み案件のhooksを無効化する指定ではありません。案件hooksは承認時に監査し、固定入力レビューへ別の文脈や他担当の結果を追加しないことを確認してください。案件側hooksの追加・変更・削除後は、judgeと承認を再確認してから再開します。

このプラグインはCopilot実行方式を対象とします。VS Code Local用hooksと実験的Dynamic Workflows拡張は従来のコピー導入で選択してください。

自動テストでは案件側に `.github/` や `migration-kit/` を置かずに、3ファイルの変換・独立レビュー・build/smoke/parityを確認します。モデル応答はテスト用です。実CLIでのプラグイン認識・ローカルのマーケットプレイスからの導入・担当の名前付きID解決も確認しています（GitHub上のマーケットプレイスからの導入は未確認）。これは `node tests/verify_plugin.mjs /absolute/path/to/copilot` で再確認できます。外部AIは呼びません。`doctor --check-cli` も、ワーカーと同じ条件で全担当IDが解決できるかを確認します。

担当の衝突とhook変更後の失効は、`node tests/verify_plugin_resolution.mjs /absolute/path/to/runtime.node` でCLI 1.0.93の実際の探索・選択・hook APIと照合できます。この内部APIへの依存は検証用スクリプトだけです。

macOSの実CLI（1.0.95・1.0.98）と疑似のモデルの間で、プラグイン方式の変換・独立レビュー（ツール付きレビューを含む）・ガードレールhookによる拒否を確認しました。古いCLI（1.0.40）はプラグインのエージェントを読み込めず、`doctor` が不足する担当IDを報告します。VS Code・GitHub Copilot app の画面での網羅的な動作確認と、最後の工程まで通した実モデルでの移植品質は未検証です。実案件の前に [LIVE-SMOKE.md](LIVE-SMOKE.md) の小規模確認を行い、同文書の `migration-kit/` をプラグインの絶対パスへ読み替えてください。
