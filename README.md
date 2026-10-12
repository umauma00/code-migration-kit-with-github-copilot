# Code Migration Kit with GitHub Copilot

Anthropicの[Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code)を、GitHub Copilot CLIを中心に使える形へ変更した非公式版です。言語間移植の「事前調査 → ルール固定 → 変換 → 独立レビュー → ビルド → 新旧比較」を扱います。

**0.2.0** はVS Code / Copilot CLIのAgent Plugins形式に対応しました。キット本体をプラグインとして導入し、案件側では設定と成果物を管理できます。[プラグイン導入手順](docs/PLUGIN.md)、[従来版の修正と再レビュー](docs/reviews/2026-10-10-copilot-rereview-fixes.md)、[既存版からの更新](docs/UPGRADING.md)を参照してください。

参照したCLIは **1.0.93**、VS Codeは **1.141.0** です。固定した元コミットとSDK参照版は [UPSTREAM.json](UPSTREAM.json) に記録しています。Anthropic/GitHubの公式配布物ではありません。

**検証状況：自動テスト、オフライン題材、macOSでの実CLIと疑似プロバイダー間の通信は検証済みです。実際のCopilot認証・AIによる移植品質、VS Code上の操作、Dynamic Workflowsの実セッションは未検証です。** 実案件の前に [LIVE-SMOKE.md](docs/LIVE-SMOKE.md) の小規模確認を実施してください。

## 主な変更

| 項目 | この版の動作 |
|---|---|
| 指示・スキル | プラグインの `skills/code-migration/SKILL.md`、またはコピー導入の `.github/skills/code-migration/SKILL.md`。自動ワーカーは暗黙の指示読み込みを無効化 |
| 役割分担 | orchestrator / implementer / 独立reviewer 2種 / arbiter / fixer の6プロファイル |
| モデル | 5種類のワーカーに明示指定。利用できるモデルIDをユーザーが設定 |
| 変換 | 実装・修正・裁定担当は `view,grep,glob` のみ。CLIのJSONLから応答を取り出し、Nodeの調整役が対象ファイルだけを書き込む |
| 独立レビュー | 2担当に同じ固定入力を渡す。レビュー担当はツールなし。全ワーカーに `--no-custom-instructions` を指定 |
| 完了判定 | 出力、入力、2件のレビュー、必要な裁定結果のハッシュを保存。ファイルが存在するだけでは完了にしない |
| 再開 | 中断した工程から再開。失われたレビューや変更された出力は再レビュー |
| 工程の承認 | 入力・出力・前工程の実行IDに結び付ける。上流の再実行で下流結果・承認は失効 |
| VS Code | Copilotは共通スキル、Localは10工程のprompt filesとLocal用hooksを利用 |
| Dynamic Workflows | 共通実行エンジンを使う任意の実験的アダプター |

## 必要なもの

- Node.js 22以上。ランナー本体は外部npm依存なし。
- 自分の環境でログイン済みのCopilot CLIと、指定モデルを利用できる契約・組織設定。
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
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID

# 確認した内容を導入
node scripts/install.mjs --target /path/to/your-project --model MODEL_ID --apply
```

スクリプト・文書は対象の `migration-kit/`、Copilotの入口は `.github/` に入ります。既存のCopilot指示には管理ブロックを追記します。内容が異なる既存ファイルは上書きせず停止し、既存の `migration/config.json` は保持します。同じ内容での再実行は変更を作りません。

VS Code **Local** のhooksを使う場合は、両方のコマンドに `--harness vscode-local` を付けます。標準の `copilot` 設定とはイベント形式が異なります。この指定は配置するhooksの形式を選ぶもので、VS Codeのセッションは切り替えません。チャットの実行方式の選択で **Local** を選んでください。CLIで実行するワーカーはコマンドラインでもツールを制限します。

以降は対象リポジトリのルートで実行してください。

```bash
node migration-kit/scripts/run_migration.mjs doctor --check-cli
```

`doctor` は設定、プロファイル、CLIバージョンと必要なオプションを確認します。新規導入直後はphase 01で作る依存宣言が不足と表示されます。作成・監査後に再実行してください。モデルの利用可否やhooksの実動作を保証するものではありません。

## 設定する

`migration/config.json` の最低限の設定は次のとおりです。

| 設定 | 内容 |
|---|---|
| `sourceRoots` | 保護する元ソース。例：`["src"]` |
| `outputRoots` | 変換後の**ソース**。例：`["ported"]`。ビルド生成物は別ディレクトリへ |
| `verificationRoots` | 比較器・テスト・テストデータ。例：`["tests"]` |
| `verificationInputs` | 追加で変更を追跡するビルド設定・依存設定等のファイル。例：`["build/config.json", "packages/api/tsconfig.json"]` |
| `buildArtifactRoots` | コマンドが生成するバイナリ・オブジェクト・レポートのディレクトリ。例：`["artifacts", "dist"]`。既定は空配列 |
| `maxReviewInputBytes` | 固定レビュー入力のJSONサイズ上限。既定65536 bytes。超過は省略せず停止 |
| `reviewDependencyMap` | 監査した依存宣言JSON。既定 `migration/review-dependencies.json`。phase 01で作成する必須成果物 |
| `sourceLanguage`, `targetLanguage` | 対象言語。テンプレートのPython/JavaScriptを変更可能 |
| `mode` | 自動ファイル変換は `preserve`。`redesign` は設計・試行プロンプトまで対応 |
| `models` | implementer、reviewer-semantics、reviewer-rules、arbiter、fixerの各ID |
| `concurrency` | 同時AI呼び出し数。初期値2。レビューを含めてこの数以下 |
| `maxFixRounds`, `maxAgentCalls` | 1単位の修正回数、1回の実行のAI呼び出し数の上限 |
| `timeoutSeconds` | 通常CLIの1ワーカー呼び出しの時間上限 |
| `commandTimeoutSeconds` | ビルド・比較コマンドの時間上限 |

`commands` は、シェル文字列ではなく引数配列です。パイプや複数コマンドは別スクリプトにまとめます。設定したコマンドは信頼できるものを指定してください。

manifestに明示した元ファイルと変換先は走査除外ディレクトリ内でも必ず追跡します。ルートの主要な依存・ビルド設定と、コマンド引数に直接指定したリポジトリ内のファイルも自動で追跡します。`migration/build.mjs` 等も対象です。間接的に読み込むスクリプトや入れ子の設定は `verificationInputs` に追加し、`doctor` の一覧で確認してください。`migration/build-settings.json` 等も明示できます。自動生成される `migration/state`、`results`、`gates`、`runs`、`run.lock` はコマンドの直接指定と `verificationInputs` に使えません。外部ツールや環境変数の変更は自動検出しません。環境変更時はjudgeから再検証します。

コマンド引数に出力先も含める場合、生成物のディレクトリを `buildArtifactRoots` へ指定します。たとえば `cc -c native/shim.c -o artifacts/shim.o` では `"buildArtifactRoots": ["artifacts"]` を設定します。これにより入力の `native/shim.c` は追跡し、生成物の作成・削除・再生成は入力の変更とみなしません。`-o` 等の意味はツールごとに違うため、出力オプションからの自動推測はしません。未指定の出力ファイルは、作成後に入力とみなされて検証が停止する可能性があります。

生成物のディレクトリは元ソース・変換後ソース・検証ルート・明示入力・キットの管理領域と重ねられません。実際に読み込む設定やスクリプトは生成物のディレクトリ外に置き、必要に応じて `verificationInputs` へ登録します。`doctor` に入力一覧と生成物のディレクトリを別々に表示します。生成物の内容は承認ハッシュで追跡しないため、build・smoke・parityの各コマンドでその正しさを検証してください。Node/Python/POSIX shellの認識したインラインコードはファイル扱いしませんが、`cc -c FILE` と `node -c FILE` のFILEは追跡します。

レビュー入力は対象の元ファイルと宣言した依存の推移的な閉包、当該候補ファイル、RULEBOOK全文、その範囲に一致するinventory行と全体注記、指定した診断です。同じ内容を両担当へ渡し、ツールを無効化します。inventoryは `file` を先頭列とし、リポジトリ相対パスの完全一致で選びます。ファイル先頭のUTF-8 BOMはコメント・空行・ヘッダーの判定前に一度だけ除去します。不正な行や未知の先頭列は停止します。入力ファイルはUTF-8のテキストに限定し、不正なUTF-8やNULを含むファイルは名前を示して停止します。静的な元資料は実装・修正担当の呼び出し前にも検査します。他の変換後ファイルとの統合はbuild/smoke/parityで確認します。必要な閉包が大きい場合はモデルの入力上限を確認して `maxReviewInputBytes` を調整するか、module adapterを用意してください。変更追跡のための全ソース走査は維持します。

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

## 工程を進める

Copilotに該当プロンプトを読ませ、各工程の成果物を確認します。VS Codeの **Local** では、対応する `/migrate-…` のprompt fileを使えます。

VS Codeの **Copilot（Agent Host）** はprompt filesを読み込みません。既存の共通スキル `/code-migration` を呼び出し、「比較器の設計を進める」など、下表の工程を指定してください。スキルは全工程のプロンプトへリンクしており、工程別スキルの追加は不要です。Local用の10個の `/migrate-…` コマンドは、この実行方式では登録されません。

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

準備した比較器・manifest・ルール・報告を確認してから、工程ごとに実行します。以下をまとめて自動実行せず、各結果を読んで次の承認へ進んでください。

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

ビルドエラーは言語横断で自動解析しません。問題の単位と診断の抜粋を指定します。

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
