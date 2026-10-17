# Code Migration Kit with GitHub Copilot

日本語 | [English](README.en.md)

Anthropicの[Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code)を、GitHub Copilot CLIを中心に使える形へ変更した非公式版です。言語間移植の「事前調査 → ルール固定 → 変換 → 独立レビュー → ビルド → 新旧比較」を扱います。

**0.2.0** はVS Code / Copilot CLIのAgent Plugins形式に対応しました。キット本体をプラグインとして導入し、案件側では設定と成果物を管理できます。[プラグイン導入手順](docs/PLUGIN.md)、[従来版の修正と再レビュー](docs/reviews/2026-10-10-copilot-rereview-fixes.md)、[既存版からの更新](docs/UPGRADING.md)を参照してください。

参照したCLIは **1.0.93**（1.0.95・1.0.98でも疑似プロバイダーとの通信を確認）、VS Codeは **1.141.0** です。固定した元コミットとSDK参照版は [UPSTREAM.json](UPSTREAM.json) に記録しています。Anthropic/GitHubの公式配布物ではありません。

**検証状況：自動テスト、オフライン題材、macOSでの実CLIと疑似プロバイダー間の通信は検証済みです。実際のCopilot認証・AIによる移植品質、VS Code上の操作、Dynamic Workflowsの実セッションは未検証です。** 実案件の前に [LIVE-SMOKE.md](docs/LIVE-SMOKE.md) の小規模確認を実施してください。

## 主な変更

レビュー1・2を反映し、03前の[隔離pilot](docs/PILOT.md)、比較器の早期検証と
[準備工程の監査契約](docs/PREPARATION-AUDITS.md)、[翻訳batch・並列repair・TODO件数検査](docs/EXECUTION-SCOPES.md)
を追加しています。[変更の対応範囲と残る実機検証](docs/plans/2026-10-15-review-implementation.md)も参照してください。

| 項目 | この版の動作 |
|---|---|
| 指示・スキル | プラグインの `skills/code-migration/SKILL.md`、またはコピー導入の `.github/skills/code-migration/SKILL.md`。CLIワーカーは暗黙の指示読み込みを無効化。nativeはhost管理 |
| 役割分担 | orchestrator / implementer / 独立reviewer 2種 / arbiter / fixerに、準備監査用のtool-free profileを追加 |
| モデル | 5種類のワーカーに明示指定。利用できるモデルIDをユーザーが設定 |
| 変換 | CLI担当は `view,grep,glob` のみ、native担当は固定入力・ツールなし。JSON応答を検証し、Nodeの調整役が対象ファイルだけを書き込む |
| 独立レビュー | 2担当に同じ固定入力を渡す。レビュー担当はツールなし。入力が上限を超えた単位は、ハッシュ付きのファイル一覧と読み取り専用ツールで自動的にレビュー。CLIは `--no-custom-instructions`、nativeはホスト管理の指示環境 |
| 完了判定 | 出力、入力、2件のレビュー、必要な裁定結果のハッシュを保存。ファイルが存在するだけでは完了にしない |
| 再開 | 中断した工程から再開。失われたレビューや変更された出力は再レビュー |
| 工程の承認 | 入力・出力・前工程の実行IDに結び付ける。上流の再実行で下流結果・承認は失効 |
| VS Code | Copilotは共通スキル、Localは10工程のprompt filesとLocal用hooksを利用 |
| Dynamic Workflows | 共通実行エンジンを使う任意の実験的アダプター |

## VS Codeだけで動かす（native方式・実行モデル未検証）

Copilot CLIを導入せずにVS Codeだけで進めたい場合は、native方式を選びます。新規のnative導入は `nativeModelVerification: "requested-unverified"` になり、親エージェントが要求モデルをサブエージェント呼び出しのモデル引数に渡して結果を提出します。VS Codeはサブエージェントが**実際に使ったモデル**を返さないため、各実行記録・runの要約・status・doctorに「実行モデル未検証」と残ります。

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --layout plugin --worker-backend native --native-harness copilot --model MODEL_ID --apply
```

Copilot CLIを使える場合は既定のCLIワーカー方式（`copilot-cli`）を推奨します。ワーカーごとに `--model` で固定したプロセスを起動し、暗黙の指示の隔離も実機で確認済みです。実行メタデータでの確認を必須にする従来の契約は `--native-model-verification host-metadata` で選べますが、VS Codeでは完了できない実験的な設定です。

`workerBackend: "native"` を選ぶと、現在のVS Codeセッションの親エージェントが
実装・レビュー・裁定・修正をサブエージェントへ委譲します。Copilot CLIは起動しません。
Node runnerが仕事を発行し、親が結果を提出します。検証・ファイル反映・承認・再開は
CLI方式と共通です。初期化には `--worker-backend native` を指定します。
Localはコピー導入、Copilot（Agent Host）はプラグインまたはコピーに対応します。
詳細は [VS Codeネイティブワーカー](docs/NATIVE-WORKERS.md) を参照してください。

既存設定では `workerBackend` 省略時の `copilot-cli` を維持します。
native接続は自動テストとオフライン題材で検証し、実VS CodeセッションのAI委譲は未検証です。
CLIとnativeでは暗黙指示の扱いが異なり、同じ隔離保証とは扱いません。

## 必要なもの

- Node.js 22以上。ランナー本体は外部npm依存なし。
- CLI方式ではログイン済みのCopilot CLI。native方式では委譲機能を使えるVS Codeセッション。いずれも指定モデルを利用できる契約・組織設定。
- 対象言語の実行環境・ビルドツール。付属デモとPython/C依存解析にはPython 3が必要です。
- Linuxの既存検証とmacOSでの自動テスト・CLI通信検証があります。Windowsでの実行は未検証です。WindowsではNodeから直接起動できるCopilot実行ファイルを使ってください。

## プラグインとして導入する

プラグイン対応ブランチを、移行対象とは別の場所にcloneします。

```bash
git clone --branch feat/github-copilot-migration-kit https://github.com/umauma00/code-migration-kit-with-github-copilot.git /path/to/code-migration-kit
copilot plugin marketplace add /path/to/code-migration-kit
copilot plugin install code-migration-kit@code-migration-kit-marketplace
```

この手順には0.2.0の変更を含むcheckoutが必要です。VS CodeはCLIでインストールしたプラグインを検出します。ローカルcheckoutを直接登録する設定、案件の初期化、更新方法は [PLUGIN.md](docs/PLUGIN.md) を参照してください。対象リポジトリをVS Codeで開き、Copilotチャットで `code-migration` スキルを使って移行開始を依頼します。

## キットを対象リポジトリへコピーして導入する

キットのルートで実行します。`MODEL_ID` は、利用するアカウントのCopilotで `/model` に表示される実際のIDへ置き換えてください。モデル名や料金は固定していません。

```bash
# まず変更対象を確認
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --language ja

# 確認した内容を導入
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --language ja --apply
```

`--language ja|en` は、工程報告・質問・`status --format markdown` の言語です。`migration/preferences.json` に保存され、承認・完了判定には影響しません。省略した場合は、スキルが開始時に日本語・英語のどちらにするかを質問します。後から `run_migration.mjs preferences --language en` で変更できます。

スクリプト・文書は対象の `migration-kit/`、Copilotの入口は `.github/` に入ります。既存のCopilot指示には管理ブロックを追記します。内容が異なる既存ファイルは上書きせず停止し、既存の `migration/config.json` は保持します。同じ内容での再実行は変更を作りません。

VS Code **Local** のhooksを使う場合は、両方のコマンドに `--harness vscode-local` を付けます。標準の `copilot` 設定とはイベント形式が異なります。この指定は配置するhooksの形式を選ぶもので、VS Codeのセッションは切り替えません。チャットの実行方式の選択で **Local** を選んでください。CLIで実行するワーカーはコマンドラインでもツールを制限します。

以降は対象リポジトリのルートで実行してください。

```bash
node migration-kit/scripts/run_migration.mjs doctor --check-cli
```

`doctor` は設定、プロファイル、CLIバージョンと必要なオプションに加え、ワーカーと同じ引数・環境変数でCLIを起動し、全担当エージェントを実際に解決できるかを確認します（AI呼び出しなし）。新規導入直後はphase 01で作る依存宣言が不足と表示されます。作成・監査後に再実行してください。モデルの利用可否やhooksの実動作を保証するものではありません。

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
| `maxReviewInputBytes` | 固定レビュー入力のJSONサイズ上限。既定65536 bytes。CLI方式で超過した単位は、自動でツール付きレビュー（下記）に切り替わる。native方式は停止 |
| `reviewDependencyMap` | 監査した依存宣言JSON。既定 `migration/review-dependencies.json`。phase 01で作成する必須成果物 |
| `sourceLanguage`, `targetLanguage` | 対象言語。テンプレートのPython/JavaScriptを変更可能 |
| `verificationMode` | `runtime`（省略時）：元環境と新旧比較を実行。`source-only`：ソース由来の準備と変換後build/smokeを検証し、動作同等性未検証として引き継ぐ。既存設定は自動変更しない |
| `mode` | 自動ファイル変換は `preserve`。`redesign` は設計・試行プロンプトまで対応 |
| `phasePolicy` | 新規は`strict`。既存の未設定は従来互換。スキル入口で`phase init`すると既存設定を保って工程順序を有効化 |
| `models` | implementer、reviewer-semantics、reviewer-rules、arbiter、fixerの各ID |
| `phaseModels` | rulebook、judgeAudit、dependencyAudit、inventoryAudit、stressA/B、stressInspector、designAuditの明示的なhost model指定。準備監査は親が実行し、自動runnerへの暗黙継承はしない |
| `designInputs` | 全文を固定入力へ含め、保護する設計文書のパス配列。リンクだけでは本文を渡した扱いにしない。redesignのmodule runnerを有効化する設定ではない |
| `packageMap` | 任意のsource→target package宣言JSON。指定時は01で別のpackage cycle監査を記録 |
| `markerPolicy` | 新規は`todo-lines-v1`：TODO(port)のある行数と末尾todosを照合。未指定の既存案件は従来契約を維持 |
| `workerBackend` | `copilot-cli`（省略時）または `native`。変更は承認を失効させる |
| `nativeHarness` | native時に必須。`vscode-local` または `copilot`。現在のセッションと合わせる |
| `concurrency` | 同時AI呼び出し数。初期値2。レビューを含めてこの数以下 |
| `maxFixRounds`, `maxAgentCalls` | 1単位の修正回数、1回の実行のAI呼び出し数の上限 |
| `maxRunInputBytes` | 任意。1回の実行でワーカーへ送る入力の合計バイト数の上限。AI Creditsはトークン量で消費され、使い切ると利用が止まるため、区切って使用量を確認するための予算。runの要約の `usageEstimate` に実測バイト数と推定トークン数（バイト÷4、課金データではない）を残す |
| `timeoutSeconds` | 通常CLIの1ワーカー呼び出しの時間上限 |
| `commandTimeoutSeconds` | ビルド・比較コマンドの時間上限 |

`commands` は、シェル文字列ではなく引数配列です。パイプや複数コマンドは別スクリプトにまとめます。設定したコマンドは信頼できるものを指定してください。

manifestに明示した元ファイルと変換先は走査除外ディレクトリ内でも必ず追跡します。ルートの主要な依存・ビルド設定と、コマンド引数に直接指定したリポジトリ内のファイルも自動で追跡します。`migration/build.mjs` 等も対象です。間接的に読み込むスクリプトや入れ子の設定は `verificationInputs` に追加し、`doctor` の一覧で確認してください。`migration/build-settings.json` 等も明示できます。自動生成される `migration/state`、`results`、`gates`、`runs`、`run.lock` はコマンドの直接指定と `verificationInputs` に使えません。外部ツールや環境変数の変更は自動検出しません。環境変更時はjudgeから再検証します。

コマンド引数に出力先も含める場合、生成物のディレクトリを `buildArtifactRoots` へ指定します。たとえば `cc -c native/shim.c -o artifacts/shim.o` では `"buildArtifactRoots": ["artifacts"]` を設定します。これにより入力の `native/shim.c` は追跡し、生成物の作成・削除・再生成は入力の変更とみなしません。`-o` 等の意味はツールごとに違うため、出力オプションからの自動推測はしません。未指定の出力ファイルは、作成後に入力とみなされて検証が停止する可能性があります。

生成物のディレクトリは元ソース・変換後ソース・検証ルート・明示入力・キットの管理領域と重ねられません。実際に読み込む設定やスクリプトは生成物のディレクトリ外に置き、必要に応じて `verificationInputs` へ登録します。`doctor` に入力一覧と生成物のディレクトリを別々に表示します。生成物の内容は承認ハッシュで追跡しないため、build・smoke・parityの各コマンドでその正しさを検証してください。Node/Python/POSIX shellの認識したインラインコードはファイル扱いしませんが、`cc -c FILE` と `node -c FILE` のFILEは追跡します。

レビュー入力は対象の元ファイルと宣言した依存の推移的な閉包、当該候補ファイル、RULEBOOK全文、その範囲に一致するinventory行と全体注記、指定した診断です。同じ内容を両担当へ渡し、ツールを無効化します。inventoryは `file` を先頭列とし、リポジトリ相対パスの完全一致で選びます。ファイル先頭のUTF-8 BOMはコメント・空行・ヘッダーの判定前に一度だけ除去します。不正な行や未知の先頭列は停止します。入力ファイルはUTF-8のテキストに限定し、不正なUTF-8やNULを含むファイルは名前を示して停止します。静的な元資料は実装・修正担当の呼び出し前にも検査します。他の変換後ファイルとの統合はbuild/smoke/parityで確認します。CLI方式で上限を超えた単位は止めずに、**ツール付きレビュー**へ自動で切り替えます。両担当には本文の代わりに「対象ファイルの一覧とSHA-256」を同じ内容で渡し、読み取り専用の `reviewer-*-read` プロファイルが各ファイルを読みます。他の担当の記録（`migration/runs` 等）はhookで読めません。固定入力より独立性の保証が弱いため、実行記録の `reviewInputMode`、runの `toolAssistedReviews` と `warnings` に残り、工程報告にも表示されます。native方式はツールがないため停止します。変更追跡のための全ソース走査は維持します。

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

これは付属題材の例です。実案件のコマンドに置き換えてください。`mutation` は「意図的に壊した実装を比較器が検出できたとき」に終了0を返します。`typecheck` は全体の変換前でも有効な軽量検査だけにし、それが難しければ `null` にします。

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

## 工程を進める

03の前に、`templates/guardrails.json`（コピー導入では `migration-kit/templates/guardrails.json`）を `migration/guardrails.json` へコピーし、対象言語のビルド・テストコマンドに合わせて編集してください。上流の `.claude/settings.json` の deny ルールに相当し、hookがすべてのエージェントの該当シェルコマンドを拒否します。runnerが実行するbuild等は対象外です。`phase start 03` / `04` は、このファイル（または免除の記録）がないと停止します。エージェントは作成しません。コピー導入方式のhookは、Copilot CLIで信頼済みのフォルダでしか読み込まれません。`doctor` で確認してください。

Copilotに該当プロンプトを読ませ、各工程の成果物を確認します。VS Codeの **Local** では、対応する `/migrate-…` のprompt fileを使えます。

VS Codeの **Copilot（Agent Host）** はprompt filesを読み込みません。既存の共通スキル `/code-migration` を呼び出し、「比較器の設計を進める」など、下表の工程を指定してください。スキルは全工程のプロンプトへリンクしており、工程別スキルの追加は不要です。Local用の10個の `/migrate-…` コマンドは、この実行方式では登録されません。

開始・再開時には、親の調整エージェントがCopilotのTODOに下表の10工程を登録し、実行中・承認待ち・修正中・停止を表示します。初期設定は別枠です。工程末には「5/10工程完了、次は04の承認待ち」のように進捗を報告し、再開時は実際の成果物・検証記録に合わせて一覧を更新します。TODOが使えない環境では同じ一覧をチャットに表示します。詳細は [工程のTODO表示](docs/PHASE-HANDOFF.md#track-the-ten-phases-in-the-host-todo-list) を参照してください。

下表と続くCLI例は **runtime方式** です。[source-only方式](docs/SOURCE-ONLY.md) では00bにソース由来のjudge-planを準備し、05cを未検証・実行なしと表示、05bの成功後に06の引き継ぎを承認・記録します。

| 工程 | プロンプト | 主な成果物 |
|---|---|---|
| 適否・範囲の調査 | [00-feasibility](prompts/00-feasibility.md) | `migration/feasibility.md` |
| 比較器の設計 | [00b-judge-setup](prompts/00b-judge-setup.md) | 元テスト、比較器、mutation自己検証 |
| 依存関係 | [01-dependency-map](prompts/01-dependency-map.md) | depmap、`migration/manifest.tsv`、`review-dependencies.json` |
| 意味の差・方針 | [02-gap-inventory](prompts/02-gap-inventory.md) | `migration/RULEBOOK.md`、`inventory.tsv` |
| 事前試行 | [03-stress-test](prompts/03-stress-test.md) | `migration/stress-test/report.md` |
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

ビルドが失敗したら `repair-round` を実行します。同梱のパーサー（Python・Java/Maven・JavaScript/Node/ESLint/tsc・シェル/ShellCheck・Rust・汎用の `file:line:col: error` 形式）が記録済みのビルド出力からエラーを読み取り、manifestの変換先ごとの修正キューを作って修正まで実行します。manifestに対応しない行は推測せず一覧で報告します。ラウンドごとのエラー件数は `migration/build-rounds.tsv` に残ります。修正後のbuildには、従来どおり承認が必要です。

```bash
node migration-kit/scripts/run_migration.mjs repair-round
node migration-kit/scripts/run_migration.mjs approve build --note "修正結果を確認"
node migration-kit/scripts/run_migration.mjs build
```

未対応の形式などで個別に指定する場合は、問題の単位と診断の抜粋を指定します。

```bash
node migration-kit/scripts/run_migration.mjs repair \
  --target ported/example.mjs --evidence migration/diagnostic-slice.txt
```

修正はレビュー→裁定→確認された指摘の修正→再レビューを通ります。出力が変わると古いビルド以降の承認は無効になるため、改めて確認・承認してください。元ソース、設定、ルール、比較器が変わった場合は、judgeから再検証し、事前試行の更新を確認してtranslationを再承認します。

同じ入力であっても、build等の再実行を開始すると下流の結果と承認は失効します。再実行が成功した場合も、smoke以降を改めて確認・承認・実行してください。judgeを再実行した場合はtranslationの承認からやり直します。

中断後は `translate` を再実行します。通常の `translate` は開始時に完了していた単位も終了時に再確認し、全単位の有効なレビュー記録が揃わなければ失敗します。`repair` の成功条件は指定した単位の完了です。異常終了でロックが残った場合のみ、所有プロセスの終了を確認して `unlock --pid OWNER_PID` を使います。稼働中のPIDでは解除できません。

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

デモではワーカーの応答を用意済みコードに置き換え、Python/Nodeの比較・ビルドを実際に走らせます。モデルの生成品質を測るベンチマークではありません。詳しい記録は [TESTING.md](docs/TESTING.md) にあります。

- 運用ルールは言語共通ですが、各言語の依存解析・ビルド・同等性判定を自動で用意する万能変換器ではありません。
- 大規模実案件、巨大な1ファイル、複数ファイルを一体で書き換える単位、再設計の自動実行は未検証・未対応です。
- CLI応答は1つのJSONです。ワーカー応答の取り込み上限は16 MiB。モデル自体の出力上限にも制約されます。
- ログには要求モデルと時間を保存します。実測できないモデル・トークン・AI creditsは `null` です。呼び出し上限は料金上限ではありません。
- 権限制限とhooksは作業上の制御であり、OSの隔離境界ではありません。SDK拡張と設定コマンドはローカルコードとして動作します。
- Bashの旧 `build_daemon.sh` は互換用です。共通ランナーと同時実行せず、通常はNodeの `build` 工程を使ってください。

原版の記録は [UPSTREAM-README.md](docs/UPSTREAM-README.md)、[UPSTREAM-CLAUDE.md](docs/UPSTREAM-CLAUDE.md)、元の `RUN-NOTES.md` に残しています。権利表記は [LICENSE](LICENSE) / [NOTICE](NOTICE)、実行時の規則は [OPERATING-MANUAL.md](docs/OPERATING-MANUAL.md)、JSON形式は [CONTRACTS.md](docs/CONTRACTS.md) を参照してください。

<!-- Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE. -->

## VS Codeでの進め方と検証方式

親エージェントの役割（工程TODO・質問・nativeの仕事の配布）、読み取り専用の `status --format markdown`、source-only方式、Rubber Duckの扱いは [運用マニュアル](docs/OPERATING-MANUAL.md#vs-code-orchestration-and-verification-modes) にまとめています。

## 工程順序と利用量の記録

`/code-migration` は [10工程の順序チェック](docs/ORDERED-WORKFLOW.md) を有効にし、最初の未完了工程から進めます。新規設定はphasePolicy=strictです。00〜03のレビュー記録が不足していると、正式judgeや本実装へ進めません。既存案件は実際の成果物を順番に確認して工程記録を作成します。

mainと同じ [migration/cost-log.tsv](docs/COST-LOG.md) を出力します。取得できない利用量・実績モデルはunknownです。現在のmodels設定は5つのワーカー役割ごとにモデルを指定し、レビュー担当は独立2プロファイルです。01・02などの調査担当や任意のレビュープロファイルを工程別に選ぶ設定は、現在の自動runnerにはありません。
