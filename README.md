# Code Migration Kit with GitHub Copilot

日本語 | [English](README.en.md)

Anthropicの[Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code)を、GitHub Copilot CLIを中心に使える形へ変更した非公式版です。言語間移植の「事前調査 → ルール固定 → 変換 → 独立レビュー → ビルド → 新旧比較」を扱います。

**0.3.0** ではVS Codeのサブエージェント方式（native）を削除しました。ワーカーは常にCopilot CLIで動き、VS Codeから進める場合も同じです。利用者はAIチャットだけで移行を完遂でき、CLIの導入・サインインの開始、guardrailsの設置などのコマンドはAIが実行します。**0.2.0** はVS Code / Copilot CLIのAgent Plugins形式に対応しました。キット本体をプラグインとして導入し、案件側では設定と成果物を管理できます。[プラグイン導入手順](docs/PLUGIN.md)、[従来版の修正と再レビュー](docs/reviews/2026-10-10-copilot-rereview-fixes.md)、[既存版からの更新](docs/UPGRADING.md)を参照してください。

参照したCLIは **1.0.98**（1.0.93・1.0.95でも疑似プロバイダーとの通信を確認。1.0.98ではrepository/plugin両構成の全ロールの往復、hookの読み込み、エラー出力の形式も確認）、VS Codeは **1.142** です。VS Code 1.142ではCopilot harnessが新規セッションの既定になりつつあり、prompt filesはLocal harness専用（`chat.promptFilesLocations` は非推奨）です（出典：[1.142リリースノート](https://code.visualstudio.com/updates/v1_142)、[Prompt files](https://code.visualstudio.com/docs/agent-customization/prompt-files)、[AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings)。2026-10-18確認）。入口はVS Code・Copilot CLIとも、エージェント一覧に出る移行オーケストレーター1つです（0.7.0から。スキルとワーカーはスラッシュメニューや一覧に出さない設定です）。固定した元コミットとSDK参照版は [UPSTREAM.json](UPSTREAM.json) に記録しています。Anthropic/GitHubの公式配布物ではありません。

**検証状況：自動テスト、オフライン題材、macOSでの実CLIと疑似プロバイダー間の通信は検証済みです。実際のCopilot認証・AIによる移植品質、VS Code上の操作、Dynamic Workflowsの実セッションは未検証です。** 実案件の前に [LIVE-SMOKE.md](docs/LIVE-SMOKE.md) の小規模確認を実施してください。

## 主な変更

レビュー1・2を反映し、03前の[隔離pilot](docs/PILOT.md)、比較器の早期検証と
[準備工程の監査契約](docs/PREPARATION-AUDITS.md)、[翻訳batch・並列repair・TODO件数検査](docs/EXECUTION-SCOPES.md)
を追加しています。[変更の対応範囲と残る実機検証](docs/plans/2026-10-15-review-implementation.md)も参照してください。

| 項目 | この版の動作 |
|---|---|
| 入口・スキル | 入口はオーケストレーター（コピー導入は `migration-orchestrator`、プラグインは `code-migration-plugin-orchestrator`）だけ。手順はプラグインの `skills/code-migration/SKILL.md`、またはコピー導入の `.github/skills/code-migration/SKILL.md` にあり、オーケストレーターが最初に読む。スキルは `/` メニューに出さない設定（`user-invocable: false`）。ワーカーは暗黙の指示読み込みを無効化 |
| 役割分担 | orchestrator / implementer / 独立reviewer 2種 / arbiter / fixerに、準備監査用のtool-free profileを追加 |
| モデル | 5種類のワーカーに明示指定。利用できるモデルIDをユーザーが設定 |
| 変換 | Copilot CLIのワーカーは `view,grep,glob` のみ。JSON応答を検証し、Nodeの調整役が対象ファイルだけを書き込む |
| 独立レビュー | 2担当に同じ固定入力を渡す。レビュー担当はツールなし。入力が上限を超えた単位は、ハッシュ付きのファイル一覧と読み取り専用ツールで自動的にレビュー。ワーカーは `--no-custom-instructions` |
| 完了判定 | 出力、入力、2件のレビュー、必要な裁定結果のハッシュを保存。ファイルが存在するだけでは完了にしない |
| 再開 | 中断した工程から再開。失われたレビューや変更された出力は再レビュー |
| 工程の承認 | 入力・出力・前工程の実行IDに結び付ける。上流の再実行で下流結果・承認は失効 |
| VS Code | Copilot harness（1.142で既定化が進行中）・Localとも、エージェント一覧からオーケストレーターを選ぶ。Localは `--harness vscode-local` でLocal用hooksを利用 |
| Dynamic Workflows | 共通実行エンジンを使う任意の実験的アダプター |

## チャットだけで進める

利用者はコマンドを打たず、VS Code（またはCopilot CLI）のAIチャットだけで移行を完遂できます。対象リポジトリを開き、Copilot Chatで次のように依頼してください。

> https://github.com/umauma00/code-migration-kit-with-github-copilot の `feat/github-copilot-migration-kit` ブランチを `../code-migration-kit` にcloneし、`scripts/install.mjs` でこのリポジトリへ導入して

導入後は新しいチャットを開き、エージェント一覧から `migration-orchestrator`（プラグイン導入では `code-migration-plugin-orchestrator`、Copilot CLIでは `/agent` で選択）を選んで、「PythonからTypeScriptへの移行を始めて」「移行の続きを進めて」などと依頼します。ほかのエージェントでは工程を始めず、オーケストレーターへの切り替えを案内します。AIは次をすべて自分で実行し、結果をチャットで報告します。

- Copilot CLIの確認。未導入なら理由を説明し、同意を得てから `npm install -g @github/copilot` を実行します。サインインが必要なら `copilot login` を始め、表示されたURLとワンタイムコードをチャットに出します。VS Codeのサインインとは別に一度だけ必要です。
- 初期化・設定・各工程のコマンド、長時間の変換（バックグラウンドのターミナルで実行し、進捗を報告）、失敗時の原因と選択肢の提示。

利用者が行うのは、次の3つだけです。

1. チャットでの質問への回答（言語・モデル・方針・各工程の判断）
2. 人間が判断する操作の確認ダイアログでの許可（`approve`、`phase complete`、`pilot prepare`、`source-spec init --apply`、`guardrails install`）。AIが実行しようとすると、ホストが利用者に確認を求めます。
3. Copilot CLIのサインインのブラウザでの承認（初回のみ）

ワーカーは常にCopilot CLIのプロセスです。`--model` で担当ごとのモデルを固定し、ツール制限と暗黙指示の隔離は実CLIで確認しています。0.2.0までのnative方式の設定（`workerBackend: "native"` など）は停止して移行方法を表示します。AIが内容を示し、同意を得て設定を直します。

## 必要なもの

- Node.js 22以上。ランナー本体は外部npm依存なし。
- Copilot CLI（未導入ならAIが同意を得てインストールし、サインインを始めます）。指定モデルを利用できる契約・組織設定。
- 対象言語の実行環境・ビルドツール。付属デモとPython/C依存解析にはPython 3が必要です。
- Windowsを主な実行環境として扱い、GitHub Actionsの `windows-latest` と `ubuntu-latest` で `npm test`・`npm run demo` を実行しています（Copilot CLIとVS Codeの実機確認は未実施）。`.cmd`/`.bat` のビルドコマンド（`npm`、`npx`、`mvn`、`gradlew.bat`）も `commands` に書けます。用意するものと注意点は [Windowsで使う](docs/WINDOWS.md) を参照してください。macOSでは自動テストとCLI通信を確認しています。

## プラグインとして導入する

プラグイン対応ブランチを、移行対象とは別の場所にcloneします。

```bash
git clone --branch feat/github-copilot-migration-kit https://github.com/umauma00/code-migration-kit-with-github-copilot.git /path/to/code-migration-kit
copilot plugin marketplace add /path/to/code-migration-kit
copilot plugin install code-migration-kit@code-migration-kit-marketplace
```

この手順には0.2.0の変更を含むcheckoutが必要です。VS CodeはCLIでインストールしたプラグインを検出します。ローカルcheckoutを直接登録する設定、案件の初期化、更新方法は [PLUGIN.md](docs/PLUGIN.md) を参照してください。対象リポジトリをVS Codeで開き、Copilotチャットで `code-migration` スキルを使って移行開始を依頼します。

## キットを対象リポジトリへコピーして導入する

キットのルートで実行します。`--model MODEL_ID` は省略でき、その場合は導入後に下記の `models list` / `models set` で担当ごとに選びます。指定する場合は、利用するアカウントのCopilotで `/model` に表示される実際のIDにしてください。モデル名や料金は固定していません。

```bash
# まず変更対象を確認
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --language ja

# 確認した内容を導入
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --language ja --apply
```

**モデル・エフォート・コンテキストサイズは利用者が選びます。** `--model` を省略して導入し、対象リポジトリで次を実行すると、利用するアカウントで使えるモデルと、モデルごとに選べるエフォート（既定値）・コンテキストサイズ（入力上限）・料金をCLIから取得して表示します。導入直後は、AIがこの一覧から全担当のモデルを**1回の質問**で聞き、`models set --role all` で記録します（ホストが利用者に1回だけ確認を求めます）。担当ごとのエフォート・コンテキストは下の実行設定ファイルで変えます。あとからチャットでモデルを変えるときは、全担当のモデル・エフォート・コンテキストを1回の質問で聞き、1回の `models set --assign` で記録します。`models set` と `preferences` で変えた値は、実行設定ファイルにも反映されます。

```bash
node migration-kit/scripts/run_migration.mjs models list --format markdown
node migration-kit/scripts/run_migration.mjs models set --assign "implementer=MODEL_ID:medium,reviewers=MODEL_ID:high:long_context,arbiter=MODEL_ID,fixer=MODEL_ID"
node migration-kit/scripts/run_migration.mjs models set --role reviewers --model MODEL_ID --effort high
```

`--assign` は `担当=モデルID:エフォート` をカンマで並べた1つの回答です（エフォートを省くと既定、`all=ID` を先に書くと全担当をまとめて指定し、後ろの担当で上書き）。全項目を確認してから書き込むので、1つでも不正なら何も変わりません。`--role` は担当名、`reviewers`（2人のレビュー担当）、`all`（全担当。surveyor は個別設定を解除して implementer と同じ設定に戻す）。surveyor は自分のモデルを持たない間だけ implementer のモデルとエフォートを引き継ぎ、自分のモデルを選んだ後は引き継ぎません。料金はCLIが公開する単価を、AI Credits の100万トークンあたりに換算して表示します。`--effort default` でモデルの既定に戻します。一覧にない・組織の設定で無効なモデルや、そのモデルが対応しないエフォートは記録しません。

コンテキストサイズは、エフォートの後ろに `:long_context` を付けた担当だけ長いコンテキスト（Copilot CLI の `--context long_context`）になります。付けられるのは、一覧のコンテキスト列に long_context があるモデルだけです。料金が上がるので、必要な担当に限ってください。付けなければ既定のコンテキストで、ワーカーに `--context` は渡しません（CLI 自身の設定 `contextTier` に従います）。1人の担当だけなら `--role 担当 --model ID --context long_context|default` も使えます。モデル・エフォートと同じく、変えるとレビュー済みの単位は次の実行で再レビューされます。一覧の取得にはCopilot CLIのサインインが必要です。

従来どおり `--models implementer=ID,reviewers=ID,arbiter=ID,fixer=ID` で担当ごとのモデルを指定することもできます（未指定の担当は `--model`）。上流キットのモデル計画と同じく、影響範囲で選びます：レビュー担当は最大または中規模、大量に動く実装担当は中または小規模、修正・裁定担当は中規模。

**実行設定は1つのファイルで決めます。** 導入後、AIはまず全担当のモデルを1問で聞き（選択肢はアカウントで使えるモデル、`models set --role all` で記録）、続けて `settings init` で `migration/run-settings.json` を作ります。移行元の言語はキットがファイルの拡張子から判定し、「移行元は C#（src 配下、120 ファイル）と判定しました。移行先はどの言語にしますか？」の1問で移行先を聞きます（判定が違うときは自由記入で訂正）。答えは `settings init --source C# --target TypeScript` で記録され、移行元のフォルダーも判定結果で埋まります。移行できる移行元の言語は1つです。同じくらいの量の別の言語があれば質問で知らせ、主言語を選んでもらいます。少しだけ混ざる言語（SQL など）は移行元の言語として扱いません（同梱の依存解析器が読むのは移行元の言語のファイルだけです）。移行元・移行先の言語、フォルダー、検証方式、元のコードが動くか、実行モード、同時実行数、各段階のコマンド、担当ごとのモデル・エフォート・コンテキストサイズが1ファイルに並び、使えるモデル・エフォート・コンテキストは `_choices`、説明は `_help` に入ります。モデル欄は全担当とも選んだモデルで埋まっているので、担当ごとに変えたいときだけ書き換えます。未記入の欄は `FILL_IN` です。質問を1つずつ受ける代わりに、このファイルを埋めて、AIの「記入しましたか？それとも質問がありますか？」に答えます。「記入した」と答えると `settings apply` が全項目をまとめて確かめ、1つでも誤りがあれば何も書き込まずに誤りを全部返します（ホストが1回だけ確認を求めます）。モデルを確かめるため、反映にはCopilot CLIのサインインが必要です。

```bash
node migration-kit/scripts/run_migration.mjs settings init
node migration-kit/scripts/run_migration.mjs settings check
node migration-kit/scripts/run_migration.mjs settings apply
```

値は従来どおり `migration/config.json`（言語・フォルダー・モデルなど）と `migration/preferences.json`（報告言語・元のコードが動くか）に記録され、報告言語を変えても承認は失効しません。ファイルはどの条件で実行したかの記録として残ります。書き換えて反映していない間は、`status` が「未反映の変更あり」と表示します。

`--language ja|en` は、工程報告・質問・`status --format markdown` の言語です。`migration/preferences.json` に保存され、承認・完了判定には影響しません。省略した場合は、スキルが開始時に日本語・英語のどちらにするかを質問します。後から `run_migration.mjs preferences --language en` で変更できます。言語が未設定の間、フックは言語以外の質問を止めます。`ja` のときは、質問ごとに本文と選択肢を確かめ、日本語で書き直させます（`ask_user` と VS Code の askQuestions）。見出しや別の質問、\`バッククォート\` 内の日本語は数えません。ひらがなを含む文は日本語として通します（`src/main.pyを移行しますか？` のようにパスと続けて書いても構いません）。ひらがながない文では、空白で区切られたパス・ファイル名を除いてから判定するため、`Should we migrate 売上集計.java next?` は止まります。選択肢は、英単語2語以上で日本語を含まないものを止めます（`Java` のような1語の名前は通します）。文字種による簡易判定で、言語判定ではありません。ひらがなを含む名前を入れた英文はすり抜けます。

スクリプト・文書は対象の `migration-kit/`、Copilotの入口は `.github/` に入ります。既存のCopilot指示には管理ブロックを追記します。内容が異なる既存ファイルは上書きせず停止し、既存の `migration/config.json` は保持します。同じ内容での再実行は変更を作りません。

VS Code **Local** のhooksを使う場合は、両方のコマンドに `--harness vscode-local` を付けます。標準の `copilot` 設定とはイベント形式が異なります。この指定は配置するhooksの形式を選ぶもので、VS Codeのセッションは切り替えません。チャットの実行方式の選択で **Local** を選んでください。CLIで実行するワーカーはコマンドラインでもツールを制限します。

以降は対象リポジトリのルートで実行してください。

```bash
node migration-kit/scripts/run_migration.mjs doctor --check-cli
```

`doctor` は設定、プロファイル、CLIバージョンと必要なオプションに加え、ワーカーと同じ引数・環境変数でCLIを起動し、全担当エージェントを実際に解決できるかを確認します（AI呼び出しなし）。phase 01で作る依存宣言は、phase 01を記録するまでは未作成でも失敗にせず `pending` と表示します（記録後に欠けていれば失敗します）。さらに、ローカルの疑似モデル（loopback、アカウント・通信・AI利用なし）で実CLIを動かし、ツール付きレビューのワーカーがhookにより `migration/runs` を読めないことを実際に確認します。このhookの読み込みは非公開の環境変数 `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS` に依存するため、CLIの更新で効かなくなった場合はここで失敗します（CLI 1.0.98・1.0.100-1で確認）。モデルの利用可否や対話セッションでのhookの実動作を保証するものではありません。

## 設定する

対話では各工程の最後に、成果物・確認ポイント・次の工程・返信例を示します。判断が必要な場合は利用可能な質問ツールで確認し、使えない環境ではチャットで返信を待ちます。初期化後の操作例は [工程末の報告と確認](docs/PHASE-HANDOFF.md) を参照してください。

`migration/config.json` の最低限の設定は次のとおりです。

| 設定 | 内容 |
|---|---|
| `sourceRoots` | 保護する元ソース。例：`["src"]` |
| `outputRoots` | 変換後の**ソース**。例：`["ported"]`。ビルド生成物は別ディレクトリへ |
| `verificationRoots` | 比較器・テスト・テストデータ。例：`["tests"]` |
| `verificationInputs` | 追加で変更を追跡するビルド設定・依存設定等のファイル。例：`["build/config.json", "packages/api/tsconfig.json"]` |
| `buildArtifactRoots` | コマンドが生成するバイナリ・オブジェクト・レポートのディレクトリ。例：`["artifacts", "dist"]`。既定は空配列 |
| `maxReviewInputBytes` | 固定レビュー入力のJSONサイズ上限。新規導入は262144 bytes（256 KiB、約6.5万〜9万トークン）。既存の設定は値を保ち、項目がなければ65536。超過した単位は、自動でツール付きレビュー（下記）に切り替わる |
| `reviewDependencyMap` | 監査した依存宣言JSON。既定 `migration/review-dependencies.json`。phase 01で作成する必須成果物 |
| `sourceLanguage`, `targetLanguage` | 対象言語。テンプレートのPython/JavaScriptを変更可能 |
| `verificationMode` | `runtime`（省略時）：元環境と新旧比較を実行。`source-only`：ソース由来の準備と変換後build/smokeを検証し、動作同等性未検証として引き継ぐ。既存設定は自動変更しない |
| `mode` | 自動ファイル変換は `preserve`。`redesign` は設計・試行プロンプトまで対応 |
| `phasePolicy` | 新規は`strict`。既存の未設定は従来互換。スキル入口で`phase init`すると既存設定を保って工程順序を有効化 |
| `models` | implementer、reviewer-semantics、reviewer-rules、arbiter、fixerの各ID。利用者が `models list` の一覧から選び、`models set` で記録する |
| `reasoningEfforts` | 任意。担当ごとのエフォート（`low`〜`max` のうちモデルが対応するもの）。未指定はモデルの既定。ワーカーに `--reasoning-effort` として渡す。モデルと同じく、変更するとレビュー済みの単位は再レビュー |
| `phaseModels` | rulebook、judgeAudit、dependencyAudit、inventoryAudit、stressA/B、stressInspector、designAuditの明示的なhost model指定。準備監査は親が実行し、自動runnerへの暗黙継承はしない |
| `designInputs` | 全文を固定入力へ含め、保護する設計文書のパス配列。リンクだけでは本文を渡した扱いにしない。redesignのmodule runnerを有効化する設定ではない |
| `packageMap` | 任意のsource→target package宣言JSON。指定時は01で別のpackage cycle監査を記録 |
| `markerPolicy` | 新規は`todo-lines-v1`：TODO(port)のある行数と末尾todosを照合。未指定の既存案件は従来契約を維持 |
| `workerBackend` | `copilot-cli` のみ（省略可）。0.3.0でnative方式を削除 |
| `concurrency` | 同時AI呼び出し数。新規導入の初期値4、上限64。2つのレビューも含めてこの数以下。CLI方式では各呼び出しが別プロセスなので、Copilotのsubagent同時実行数ではなく、アカウントのレート制限が実質の上限 |
| `dependencyOrder` | `auto`（新規導入）: 単位型チェックがあるときだけ、依存先のレビュー完了まで依存元を待たせる。型チェックがなければ上流と同じく承認範囲を一斉に展開する。`reviewed`（省略時・既存設定）: 常に待つ。`none`: 待たない（型チェックとは併用不可） |
| `fixPolicy` | `single-pass`（新規導入の既定）: 上流Step 3と同じく、確定指摘の修正は1回で完了とし、build/smoke/parityが判定する。呼び出し数と停止する単位が減る。`rereview`（キーのない既存設定）: 修正後に再レビューし、確定した指摘がなくなるまで繰り返す |
| `reviewFocus` | `shared`（新規導入）: 2人のレビュアーがそれぞれ自分の観点を先に、両方の観点（元の動作・ルール順守）を確認し、見つけた欠陥をすべて報告する。互いの結果は見ない。`specialized`（省略時・既存設定）: 上流と同じく1人1観点 |
| `executionMode` | 既定・未指定は `continuous`。旧設定の時間・呼び出し数・修正回数・累計入力・リトライ回数で打ち切らず、終了まで継続する。利用者が明示的に `bounded` を選んだ場合だけ以下の上限を適用する。continuous で効かない値が書かれていれば `doctor` が表示する。[停止条件一覧](docs/INTERRUPTION-POLICY.md) |
| `maxFixRounds`, `maxAgentCalls` | boundedモードだけで使う1単位の修正回数・1実行のAI呼び出し数上限。continuousでは適用しない。`translate --max-calls N` を利用者が明示した場合は、その実行の有限上限として扱う |
| `maxRunInputBytes` | boundedモードだけで使う入力累計bytesの上限。通常実行は量だけで打ち切らず、`usageEstimate` とCLIの使用量を記録する |
| `maxAiCreditsPerCall` | boundedモードだけで各workerへ渡す任意の `--max-ai-credits`（CLIの最小値30）。continuousでは渡さない。サービス側の残高・組織上限は外部制約 |
| `timeoutSeconds` | boundedモードだけで使うCLI呼び出し時間上限。0は期限なし。通常実行は旧設定が600でも打ち切らない |
| `transientRetries`, `transientRetryDelayMs` | レート制限・5xx・通信障害を待って再試行する。通常実行は回数で打ち切らない。boundedだけ既定2回。待機は既定5秒から倍増、最大60秒 |
| `maxConsecutiveFailures` | boundedモードだけで使う連続失敗時の新規起動停止（既定3）。通常実行は独立した残りの単位を処理する。認証・残高など共通の実障害は原因を報告する |
| `commandTimeoutSeconds` | boundedモードだけで使うビルド・比較の時間上限。0は期限なし。CPU使用率・無出力・600秒経過を理由に正常な処理を中断しない |

`commands` は、シェル文字列ではなく引数配列です。パイプや複数コマンドは別スクリプトにまとめます。設定したコマンドは信頼できるものを指定してください。

manifestに明示した元ファイルと変換先は走査除外ディレクトリ内でも必ず追跡します。ルートの主要な依存・ビルド設定と、コマンド引数に直接指定したリポジトリ内のファイルも自動で追跡します。`migration/build.mjs` 等も対象です。間接的に読み込むスクリプトや入れ子の設定は `verificationInputs` に追加し、`doctor` の一覧で確認してください。`migration/build-settings.json` 等も明示できます。自動生成される `migration/state`、`results`、`gates`、`runs`、`run.lock` はコマンドの直接指定と `verificationInputs` に使えません。外部ツールや環境変数の変更は自動検出しません。環境変更時はjudgeから再検証します。

コマンド引数に出力先も含める場合、生成物のディレクトリを `buildArtifactRoots` へ指定します。たとえば `cc -c native/shim.c -o artifacts/shim.o` では `"buildArtifactRoots": ["artifacts"]` を設定します。これにより入力の `native/shim.c` は追跡し、生成物の作成・削除・再生成は入力の変更とみなしません。`-o` 等の意味はツールごとに違うため、出力オプションからの自動推測はしません。未指定の出力ファイルは、作成後に入力とみなされて検証が停止する可能性があります。

生成物のディレクトリは元ソース・変換後ソース・検証ルート・明示入力・キットの管理領域と重ねられません。実際に読み込む設定やスクリプトは生成物のディレクトリ外に置き、必要に応じて `verificationInputs` へ登録します。`doctor` に入力一覧と生成物のディレクトリを別々に表示します。生成物の内容は承認ハッシュで追跡しないため、build・smoke・parityの各コマンドでその正しさを検証してください。Node/Python/POSIX shellの認識したインラインコードはファイル扱いしませんが、`cc -c FILE` と `node -c FILE` のFILEは追跡します。

レビュー入力は対象の元ファイルと宣言した依存の推移的な閉包、当該候補ファイル、RULEBOOK全文、その範囲に一致するinventory行と全体注記、指定した診断です。同じ内容を両担当へ渡し、ツールを無効化します。inventoryは `file` を先頭列とし、リポジトリ相対パスの完全一致で選びます。ファイル先頭のUTF-8 BOMはコメント・空行・ヘッダーの判定前に一度だけ除去します。不正な行や未知の先頭列は停止します。Shift_JIS・EUC-JP・Latin-1・UTF-16 の入力は読み替えて渡し、`encoding` を明記します（元ファイルは変更しません）。NULを含むバイナリは名前を示して停止します。静的な元資料は実装・修正担当の呼び出し前にも検査します。他の変換後ファイルとの統合はbuild/smoke/parityで確認します。上限を超えた単位は止めずに、**ツール付きレビュー**へ自動で切り替えます。両担当には本文の代わりに「対象ファイルの一覧とSHA-256」を同じ内容で渡し、読み取り専用の `reviewer-*-read` プロファイルが各ファイルを読みます。他の担当の記録（`migration/runs` 等）はhookで読めません。固定入力より独立性の保証が弱いため、実行記録の `reviewInputMode`、runの `toolAssistedReviews` と `warnings` に残り、工程報告にも表示されます。変更追跡のための全ソース走査は維持します。

CLIの全5ワーカーは `--no-custom-instructions` を付けて新しいプロセスを起動します。`AGENTS.md`、リポジトリ・個人のCopilot指示などの自動注入を止め、指定した役割プロファイルとランナーの契約を使います。案件固有の移植方針は、承認対象の `migration/RULEBOOK.md` とinventoryへ取り込んでください。暗黙の指示ファイルを変更してもワーカーの方針は変わりません。通常の対話セッションでは引き続きCopilot指示を使えます。

既存の `edges.tsv` が解析器の `--root src` に対する相対パスなら、次のコマンドで依存宣言の草案を作ります。

```bash
node migration-kit/scripts/make_review_dependencies.mjs \
  --source-root src --edges migration/depmap/edges.tsv
```

解析器の `--root` と列挙する元ソースのディレクトリが違う場合は `--depmap-root` を指定します。Pythonの `from pkg import b` 等を解決するためにリポジトリルートで解析したTSVなら、次の例を使います。`.` を許可するのは解析ルートだけです。

```bash
python3 migration-kit/scripts/depmap_python.py --root . --out migration/depmap
node migration-kit/scripts/make_review_dependencies.mjs \
  --source-root pkg --depmap-root . --edges migration/depmap/edges.tsv
# 複数のソースルートをまたぐ依存がある場合（config.sourceRootsも同じ範囲に設定）
node migration-kit/scripts/make_review_dependencies.mjs \
  --source-roots pkg,shared --depmap-root . --edges migration/depmap/edges.tsv
```

同梱の解析器は Python・JS/TS・C/C++・C#・Java・VB.NET・PHP・COBOL 用で、どれもソースを読むだけです（元のアプリは実行しません）。各言語のコマンドと、同梱版のない言語のアダプタの作り方は[依存解析器](docs/DEPENDENCY-MAPPERS.md)にあります。

JSON形式は `{"schemaVersion":1,"dependencies":{"src/a.py":["src/b.py"],"src/b.py":[]}}` です。`--depmap-root` 省略時は単一の `--source-root` を解析ルートとみなすため、従来のコマンドも使えます。列挙は指定したソースルート内に限定し、孤立ファイルにも `[]` を作ります。対象外ファイルから始まる辺（例：tests → pkg）は除外し、標準出力の `ignoredEdges` に列挙します。対象ソースから範囲外への依存（例：pkg → shared）は停止し、必要なルートの追加を求めます。解析器の対応構文・除外・未解決import・除外された辺を監査し、inventoryのevidence等に必要な意味上の参照も追加してください。解析ルートが複数なら別々の `--out migration/PATH.json` へ生成して1つのmapへ統合します。閉包に必要なキーやファイルが欠けていれば停止します。mapと明示依存の変更で承認・完了記録が失効します。

以下は既定の **runtime方式** のコマンド例です。元環境が使えない案件は、明示的な [source-only方式](docs/SOURCE-ONLY.md) の準備記録とbuild/smoke→handoff経路を使います。

```json
{
  "original": ["python3", "-B", "tests/judge.py", "original"],
  "mutation": ["python3", "-B", "tests/judge.py", "mutation"],
  "build": ["python3", "-B", "tests/judge.py", "build"],
  "smoke": ["python3", "-B", "tests/judge.py", "smoke"],
  "parity": ["python3", "-B", "tests/judge.py", "parity"],
  "typecheck": ["node", "--check", "{target}"]
}
```

これは付属題材の例です。実案件のコマンドに置き換えてください。Windowsでは `python3` の代わりに `py`（引数の先頭に `"-3"`）か `python` を使います。`mutation` は「意図的に壊した実装を比較器が検出できたとき」に終了0を返します。`typecheck` は全体の変換前でも有効な軽量検査だけにし、それが難しければ `null` にします。

## 現行の実行環境・仕様書がない場合

現行実装を動かせず、仕様書もない案件では、**ソースコードを唯一の仕様**とする [source-as-spec方式](docs/SOURCE-AS-SPEC.md) を選べます。00b・01・02の成果物（ソース由来の契約、依存マップ、RULEBOOK、inventory）をAIがまとめて作成し、ユーザーが一度確認してOKすれば03以降へ進みます。動作同等性は「未検証」として引き継ぎます。

```bash
# 新規
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --preparation-profile source-as-spec --apply
# 既存案件（runtime方式の00bで止まった場合など）。まず確認し、同意後に --apply
node migration-kit/scripts/run_migration.mjs source-spec init
node migration-kit/scripts/run_migration.mjs source-spec check
```

## 進捗表示と失敗時の案内

`status --format checklist` は10工程と「いまここ」を表示し、`status --format todo` はホストのTODOツールに渡す一覧を返します。工程の報告は毎回このチェックリストから始まります。

runnerのコマンドが失敗すると、`ERROR:` に続けて **原因・影響・選択肢（推奨1つと各理由・実行例）** を表示します。Copilotはこれを示したうえで、質問ツールで選択を求め、ユーザーの回答を待ちます。runner以外の失敗は `run_migration.mjs guidance --message "エラー文"` で同じ形式の案内を作れます。

## 準備工程の調査を範囲ごとに任せる

00 事前調査は上流と同じく、親エージェントが一部を抜き出して読み、読まなかった範囲を報告に書きます（survey は任意）。全ファイルを扱う必要がある 00b（ソースを仕様とする場合）・02 では、親エージェントが全ファイルを自分で読む代わりに、`survey run --kind facts|contracts|inventory` でソースを範囲に分け、範囲ごとに新しい調査担当（新しい `copilot` プロセス）に任せられます。結果は `migration/surveys/` にファイルで保存され、`survey merge` で下書きにまとまります。中断しても残りの範囲から再開します。詳細は [準備工程の調査](docs/SURVEYS.md)。

## 工程を進める

03の前に、コマンド制限 `migration/guardrails.json` を設置します。上流の `.claude/settings.json` の deny ルールに相当し、hookがすべてのエージェントの該当シェルコマンドを拒否します（runnerが実行するbuild等は対象外）。設置は人間の判断です。AIが `run_migration.mjs guardrails show` を基に、対象のビルド・テストコマンドに合わせた禁止リスト（または免除理由）をチャットで提案します。合意後にAIが `guardrails install` を実行すると、ホストが利用者に確認を求めます。この許可が人間の設置行為です。AIがファイルを直接書くことはhookが拒否します。`phase start 03` / `04` は、このファイル（または免除の記録）がないと停止します。対話型のCopilot CLIで進める場合、コピー導入方式のhookは信頼済みのフォルダでしか読み込まれません。`doctor` で確認できます（runnerが起動するワーカーは常に読み込みます）。

オーケストレーターに「比較器の設計を進める」など下表の工程を指定し、各工程の成果物を確認します。オーケストレーターが読む手順（スキル）は全工程のプロンプトへリンクしています。VS CodeのCopilot（Agent Host）・Localのどちらでも同じ入口です。0.6.0以前のLocal用 `/migrate-…` prompt filesは0.7.0で削除しました。

開始・再開時には、親の調整エージェントがCopilotのTODOに下表の10工程を登録し、実行中・承認待ち・修正中・停止を表示します。初期設定は別枠です。工程末には「5/10工程完了、次は04の承認待ち」のように進捗を報告し、再開時は実際の成果物・検証記録に合わせて一覧を更新します。TODOが使えない環境では同じ一覧をチャットに表示します。詳細は [工程のTODO表示](docs/PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list) を参照してください。

下表と続くCLI例は **runtime方式** です。[source-only方式](docs/SOURCE-ONLY.md) では00bにソース由来のjudge-planを準備し、05cを未検証・実行なしと表示、05bの成功後に06の引き継ぎを承認・記録します。

| 工程 | プロンプト | 主な成果物 |
|---|---|---|
| 適否・範囲の調査 | [00-feasibility](prompts/00-feasibility.md) | `migration/feasibility.md` |
| 比較器の設計 | [00b-judge-setup](prompts/00b-judge-setup.md) | 元テスト、比較器、mutation自己検証 |
| 依存関係 | [01-dependency-map](prompts/01-dependency-map.md) | depmap、`migration/manifest.tsv`、`review-dependencies.json` |
| 意味の差・方針 | [02-gap-inventory](prompts/02-gap-inventory.md) | `migration/RULEBOOK.md`、`inventory.tsv` |
| 事前試行 | [03-stress-test](prompts/03-stress-test.md)（[チェックリスト](docs/STRESS-TEST-CHECKLIST.md)） | `migration/stress-test/report.md` |
| 変換・レビュー | [04-translation-kickoff](prompts/04-translation-kickoff.md) | 変換後ソース、レビュー記録 |
| 全体ビルド | [05-survey-build](prompts/05-survey-build.md) | 診断、修正記録 |
| 基本動作 | [05b-smoke](prompts/05b-smoke.md) | 実操作を伴うsmoke結果 |
| 新旧比較 | [05c-parity](prompts/05c-parity.md) | ケース数・差分・元テスト結果 |
| 比較合格後の整理 | [06-post-parity](prompts/06-post-parity.md) | 残課題・採否・引き継ぎ |

manifestはタブ区切りの `source` / `target` の2列です。1元ファイル→1対象ファイルに対応します。同じ出力の重複、元ソースの上書き、管理対象内のsymlinkを拒否します。保護ルートとの重複は実在する親とファイル識別子でも確認し、大文字・小文字の別名が同じ実体を指す場合は拒否します。対象ファイルの書き込み直前にも再確認します。付属解析器はPython、JS/TS、Cの出発点です。Java/C#の解析器やフレームワーク固有規則は追加が必要です。

runtime方式では、準備した比較器・manifest・ルール・報告を確認してから、工程ごとに実行します。以下をまとめて自動実行せず、各結果を読んで次の承認へ進んでください。

```bash
# 元テストと比較器の自己検証
node migration-kit/scripts/run_migration.mjs judge

# 事前調査・ルール・比較器・試行結果を確認した後
node migration-kit/scripts/run_migration.mjs approve translation --note "確認した範囲と判断理由"
node migration-kit/scripts/run_migration.mjs translate
node migration-kit/scripts/run_migration.mjs status

# 全単位のレビュー結果を確認した後
node migration-kit/scripts/run_migration.mjs approve build --note "レビュー結果を確認"
node migration-kit/scripts/run_migration.mjs build

# ビルド結果を確認した後
node migration-kit/scripts/run_migration.mjs approve smoke --note "ビルド結果を確認"
node migration-kit/scripts/run_migration.mjs smoke

# smokeの実動作を確認した後
node migration-kit/scripts/run_migration.mjs approve parity --note "基本動作を確認"
node migration-kit/scripts/run_migration.mjs parity
```

ビルドが失敗したら、チャットで合意したうえでAIが `build-loop` を実行します（ホストが確認を求めます）。通常は「build → エラー解析 → レビュー付き修正 → 再build」をクリーンになるまで継続し、既定の5回・呼び出し数・エラー件数の横ばいでは打ち切りません。有限の上限は利用者が `--max-rounds N` / `--max-calls N` またはboundedモードを選んだ場合だけです。AIは実行範囲と上限の有無を明示します。各回の承認は1つの許可（`migration/gates/build-loop-<id>.json`）の下に記録され、実行中は `status` に表示され、ほかのrunnerコマンドは拒否されます。1回ずつ進める場合は `repair-round` を使います。同梱のパーサー（Python・Java/Maven・JavaScript/Node/ESLint/tsc・シェル/ShellCheck・Rust・汎用の `file:line:col: error` 形式）が記録済みのビルド出力からエラーを読み取り、manifestの変換先ごとの修正キューを作って修正まで実行します。manifestに対応しない行は推測せず一覧で報告します。ラウンドごとのエラー件数は `migration/build-rounds.tsv` に残ります。`--through smoke` または `--through parity` を付けると、同じ1つの許可で、buildがクリーンになった後のsmoke（とparity）も承認・実行し、その失敗もレビュー付き修正に回して次の回をbuildからやり直します（上流のStep 5・6）。元テストの失敗や、変換先に対応しない失敗は推測せずに止まります。ループを使わない場合、修正後のbuildには従来どおり承認が必要です。

```bash
node migration-kit/scripts/run_migration.mjs build-loop --note "ビルドが通るまでレビュー付き修正を継続することに合意"
# smoke・parityまで同じ許可で繰り返す場合
node migration-kit/scripts/run_migration.mjs build-loop --through parity --note "parityが通るまでレビュー付き修正を継続することに合意"
# 1回ずつ進める場合
node migration-kit/scripts/run_migration.mjs repair-round
node migration-kit/scripts/run_migration.mjs approve build --note "修正結果を確認"
node migration-kit/scripts/run_migration.mjs build
```

未対応の形式などで個別に指定する場合は、問題の単位と診断の抜粋を指定します。

```bash
node migration-kit/scripts/run_migration.mjs repair \
  --target ported/example.mjs --evidence migration/diagnostic-slice.txt
```

修正はレビュー→裁定→確認された指摘の修正→再レビューを通ります。出力が変わると古いビルド以降の承認は無効になるため、改めて確認・承認してください。元ソース、設定、ルール、比較器が変わった場合は、judgeから再検証し、事前試行の更新を確認してtranslationを再承認します。ただし実行上限（`concurrency`、`maxAgentCalls`、`maxFixRounds`、各タイムアウト・再試行、`maxRunInputBytes`、`maxAiCreditsPerCall`）、文書・工程プロンプト・スキル・Copilot指示の変更はワーカーの出力に影響しないため、レビュー済みの単位・工程記録・承認を失効させません。

smoke・parityの失敗も同じ経路で修正します（上流Step 6）。元の実装で同じ入力を実行して分類したうえで、`repair-round --stage smoke|parity` を使うと、変換後ファイルを指す出力行がレビュー付き修正のキューになります。比較器がケース単位でしか報告しない場合は、確認した退行を `file<TAB>module<TAB>code<TAB>message` 形式で書き、`diagnostic_queue.mjs --stage parity --diagnostics migration/PATH.tsv` → `repair --queue` を実行します。元テスト（original）の失敗は継承・環境の問題なので、runnerはキューにしません。修正後はbuild・smoke・parityを改めて承認・実行します。

同じ入力であっても、build等の再実行を開始すると下流の結果と承認は失効します。再実行が成功した場合も、smoke以降を改めて確認・承認・実行してください。judgeを再実行した場合はtranslationの承認からやり直します。

長い実行中の進捗確認は `status --fast --wait 600 --format markdown` を使います。これは状態確認だけを最大600秒待つ指定で、workerの期限ではありません。返った後も既存の実行を待ちます。単位の完了や状態変化で返すので、親エージェントの確認回数（＝AI呼び出し）を減らせます。中断後は `translate` を再実行します。通常の `translate` は開始時に完了していた単位も終了時に再確認し、全単位の有効なレビュー記録が揃わなければ失敗します。`repair` の成功条件は指定した単位の完了です。異常終了で残ったロックは、同じホストなら次のコマンドが自動で外します。別ホスト（共有フォルダ）のロックや、PIDが別のプロセスに再利用された場合だけ、その実行が止まったことを確認して `unlock --pid OWNER_PID` を使います。このホストで稼働中のPIDは解除できません。

## 任意：Dynamic Workflows

導入コマンドに `--with-workflow` を付けると `.github/extensions/code-migration/extension.mjs` も配置します。SDKの `defineWorkflow` / `joinSession` で工程を登録し、ワーカーは通常CLIと同じアダプターから起動します。ホストセッションの文脈を受け継ぐ `ctx.agent` は使いません。再開・承認・完了判定はランナーの記録を利用します。

```bash
copilot --experimental --allow-tool read workflow run code-migration --args '{"stage":"translate"}'
```

信頼済みの拡張としてCLIに読み込ませる必要があります。詳細は [Dynamic Workflows](docs/DYNAMIC-WORKFLOWS.md) を参照してください。**実験的な入口で、実際のCLIセッションでは未検証**です。1回のworkflowで1工程だけ実行し、次工程は別途承認します。

## テストと制限

**配布ZIPの展開先**で実行します。AI利用料・ログインなしで実行できます。

```bash
npm test
npm run demo
```

対象プロジェクトへ配置した `migration-kit/` は実行用パッケージで、テスト・デモは含みません。このディレクトリでは `npm run check` で設定・プロファイル・追跡入力を診断します。`npm test` / `npm run demo` は配布元で使います。

デモではワーカーの応答を用意済みコードに置き換え、Python/Nodeの比較・ビルドを実際に走らせます。モデルの生成品質を測るベンチマークではありません。詳しい記録は [TESTING.md](docs/TESTING.md) にあります。ワーカーを統合する前に実モデルで品質を比べる手順は [REVIEW-BENCHMARK.md](docs/REVIEW-BENCHMARK.md) です。

- 運用ルールは言語共通ですが、各言語の依存解析・ビルド・同等性判定を自動で用意する万能変換器ではありません。
- 大規模実案件、巨大な1ファイル、複数ファイルを一体で書き換える単位、再設計の自動実行は未検証・未対応です。
- CLI応答は1つのJSONです。ワーカー応答の取り込み上限は16 MiB。モデル自体の出力上限にも制約されます。
- ログには要求モデルと時間を保存します。CLI方式では、CLIがJSONLで報告する実行モデル（`model.call_final_result`）と `premiumRequests` などの使用量も記録し、要求と違うモデルはrunの警告にします。さらに各呼び出しで `--usage-output-file` を使い、CLI自身が報告する入力・出力・キャッシュのトークン数とAI unit（nano AIU）を `cliUsage` に、runの合計を `measuredUsage` に記録します。AI Creditsへの換算はCLIが報告しないため `null` のままです。呼び出し上限は料金上限ではありません。
- CLIは `--output-format json` のとき、レート制限・5xx・認証エラーをstdoutの `session.error` だけに出します（stderrは空）。runnerはこれを読み、429/5xxは再試行、認証・クレジット切れは全体停止として扱い、エラーメッセージに原因を残します。
- CLIワーカーは呼び出しごとに1つのセッション（GitHubアカウントへの同期は利用者のCopilot CLIの設定に従う。キットは同期用のフラグを渡さない）として `~/.copilot/session-state` に残り、IDはrunnerが呼び出し前に実行記録（`cli-sessions.jsonl`、再試行・中断した呼び出しも含む）へ残します。ソースコードを含むため、移行後にAIが `sessions status` で件数と容量を報告し、同意があれば `sessions prune` でキットのワーカー分だけを削除します（ホストが確認を求めます）。
- 並列ワーカーは多くのファイルを開きます。Copilot CLI（Node）は起動時に自分で開けるファイル数（soft limit）をhard limitまで引き上げるため（1.0.98で256→hard limitを確認）、キット側の引き上げは不要です。上げられないのはhard limitだけなので、`doctor --check-cli` がhard limitを確認し、4096未満なら引き上げ方を案内します。
- レート制限（429）やサービス障害は自動で再試行します。再試行中は `status` に表示され、AIがその旨を伝えます。
- 権限制限とhooksは作業上の制御であり、OSの隔離境界ではありません。SDK拡張と設定コマンドはローカルコードとして動作します。
- Bashの旧 `build_daemon.sh` は互換用です。共通ランナーと同時実行せず、通常はNodeの `build` 工程を使ってください。

原版の記録は [UPSTREAM-README.md](docs/UPSTREAM-README.md)、[UPSTREAM-CLAUDE.md](docs/UPSTREAM-CLAUDE.md)、元の `RUN-NOTES.md` に残しています。権利表記は [LICENSE](LICENSE) / [NOTICE](NOTICE)、実行時の規則は [OPERATING-MANUAL.md](docs/OPERATING-MANUAL.md)、JSON形式は [CONTRACTS.md](docs/CONTRACTS.md) を参照してください。

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

## VS Codeでの進め方と検証方式

親エージェントの役割（工程TODO・質問・コマンドの実行）、読み取り専用の `status --format markdown`、source-only方式、Rubber Duckの扱いは [運用マニュアル](docs/OPERATING-MANUAL.md#vs-code-orchestration-and-verification-modes) にまとめています。

## 工程順序と利用量の記録

オーケストレーターは [10工程の順序チェック](docs/ORDERED-WORKFLOW.md) を有効にし、最初の未完了工程から進めます。新規設定はphasePolicy=strictです。00〜03のレビュー記録が不足していると、正式judgeや本実装へ進めません。既存案件は実際の成果物を順番に確認して工程記録を作成します。

mainと同じ [migration/cost-log.tsv](docs/COST-LOG.md) を出力します。取得できない利用量・実績モデルはunknownです。現在のmodels設定は5つのワーカー役割ごとにモデルを指定し、レビュー担当は独立2プロファイルです。01・02などの調査担当や任意のレビュープロファイルを工程別に選ぶ設定は、現在の自動runnerにはありません。
