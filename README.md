# Code Migration Kit with GitHub Copilot

日本語 | [English](README.en.md)

Anthropic の [Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code)（Claude Code 用）を、GitHub Copilot で使えるようにした非公式版です。あるプログラミング言語で書かれたコードベースを、動きを変えずに別の言語へ移します。

進め方は元のキットと同じです。**事前調査 → ルールを固める → 少数で試す → 全体を変換して2人で独立レビュー → ビルド → 起動確認 → 新旧の動作比較**。違いは、AI を動かす部分を Copilot 向けに作り直し、承認や完了を記録で確かめるようにした点です（[元のキットとの違い](guides/migration-guide.html#upstream)）。

Anthropic・GitHub の公式配布物ではありません。

## 対応アプリ

次の3つから使えます。どれでも入口は **移行オーケストレーター** というエージェント1つで、チャットで話しながら進めます。

| アプリ | 入れ方 | オーケストレーターの選び方 |
|---|---|---|
| GitHub Copilot CLI | `copilot plugin install` | `/agent` |
| GitHub Copilot app | Customize からプラグインを入れる | エージェントの選択欄か `/agent` |
| VS Code（チャットと Agents window） | Chat: Open Customizations からプラグインを入れる | エージェントの選択欄 |

どのアプリから使っても、実際に変換やレビューをする AI（ワーカー）は、キットが手元の **Copilot CLI** を別に起動して動かします。そのため app と VS Code でも Copilot CLI が必要です（未導入なら AI が同意を得て入れ、サインインを始めます）。

アプリごとのセッションの設定は次のとおりです。

- **Copilot app**：Environment は **This computer**、Workspace は **Current checkout** にします。ツールの権限は **Ask every time** か **Assisted** にします。
- **VS Code**：実行方式（harness）は **Copilot**（既定）を使います。Agents window では、分離方法を **Folder** にします。**New Worktree** は確認が一切出ない「Allow all」になり、まだコミットしていない `migration/` も引き継がれません。権限は **Manual permissions**（既定）か **Assisted permissions** にします。
- **全アプリ共通**：承認が必要なコマンドは、アプリの確認ダイアログで人が許可する前提です。最初から通しで自動に進めたい場合は、初期設定で「自動」モードを選び、初期設定が終わったところで autopilot モードに切り替えて「続けて」と送ります。

詳しい手順は [プラグインとして使う](docs/PLUGIN.md) にあります。

## 必要なもの

- Node.js 22 以上（キットは外部の npm パッケージを使いません）
- GitHub Copilot CLI と、使いたいモデルが使える Copilot の契約・組織設定
- 移行元・移行先の言語の実行環境とビルドツール（同梱の Python 用依存解析器と付属デモには Python 3）
- Windows・macOS・Linux。GitHub Actions の Windows と Ubuntu で毎回テストしています。Windows の注意点は [Windows で使う](docs/WINDOWS.md)

## 導入する

### プラグインとして入れる（おすすめ）

移行したいリポジトリに何も置かずに使えます。Copilot CLI では次のとおりです。

```bash
copilot plugin marketplace add umauma00/code-migration-kit-with-github-copilot
copilot plugin install code-migration-kit@code-migration-kit-marketplace
```

VS Code と GitHub Copilot app でも、同じ登録元（`umauma00/code-migration-kit-with-github-copilot`）をマーケットプレイスとして追加し、`code-migration-kit` を入れます。VS Code は CLI で入れたプラグインも自動で見つけます。画面ごとの手順・更新・社内 Git サーバーからの導入は [PLUGIN.md](docs/PLUGIN.md) を参照してください。

### リポジトリにコピーして入れる

キットを手元に clone し、移行したいリポジトリへコピーします。チャットで「このキットを clone して、`scripts/install.mjs` でこのリポジトリに入れて」と頼めば AI が実行します。手で行う場合は、まず確認してから `--apply` で反映します。

```bash
node scripts/install.mjs --target /path/to/your-project --language ja
node scripts/install.mjs --target /path/to/your-project --language ja --apply
```

キットは `migration-kit/` に、エージェントとフックは `.github/` に入ります。内容の違う既存ファイルは上書きせずに止まります。VS Code の Local 実行方式で使うときだけ `--harness vscode-local` を付けます（[詳しい使い方](docs/REFERENCE.md#コピー導入で置かれるもの)）。

## 移行を始める

移行したいリポジトリを開き、エージェントの選択欄で **`code-migration-plugin-orchestrator`**（コピー導入では `migration-orchestrator`）を選んで、「C# から TypeScript への移行を始めて」「移行の続きを進めて」のように頼みます。ほかのエージェントでは工程を始めず、オーケストレーターへの切り替えを案内します。

利用者はコマンドを打ちません。AI がコマンドを実行し、結果をチャットで報告します。利用者がするのは次の3つだけです。

1. チャットでの質問に答える（言語・モデル・方針・各工程の判断）
2. 人が決める操作（承認・工程の完了・試運転の準備・ガードレールの設置など）で出る、アプリの確認ダイアログを許可する（自動モードでは出ません）
3. 初回だけ、Copilot CLI のサインインをブラウザーで許可する

### 最初に聞かれること

最初に報告の言語（日本語・英語）を聞かれ、導入のあとに次を1問ずつ聞かれます。答えは `migration/run-settings.json` に記録され、後から変えるときや別のセッションで再開するときに使います。

1. 全担当のモデル（アカウントで使えるモデルの一覧から選ぶ）
2. 移行先の言語（移行元はキットがファイルから判定）
3. 工程の進め方：**普通**（推奨）／**緩和**（足りない前提を警告して、直すか進むかを聞く）／**自動**（緩和を人に聞かずに進める）
4. 元のプログラムをこの環境でビルドして動かせるか
5. （動かせないときだけ）仕様書や、移行先でも使えるテストがあるか

担当ごとのモデル・エフォート、出力先のフォルダー、ビルドやテストのコマンドなどは、このファイルで変えます。各項目は [詳しい使い方](docs/REFERENCE.md) にあります。

## 10の工程

工程は `00 → 00b → 01 → 02 → 03 → 04 → 05 → 05b → 05c → 06` の順に進み、前の工程の記録が揃うまで次に進みません。各工程の最後に、成果物・確認してほしい点・次の工程を報告します。工程ごとに AI を誰が何回呼ぶかは、[図解ガイド](guides/migration-guide.html) にまとめています。

| 工程 | やること | 主な成果物 |
|---|---|---|
| [00](prompts/00-feasibility.md) | 移行に向くか・範囲を調べる | `migration/feasibility.md` |
| [00b](prompts/00b-judge-setup.md) | 新旧を比べる仕組み（比較器）を作り、壊した実装を見分けられるか確かめる | 比較器、元のテスト |
| [01](prompts/01-dependency-map.md) | ファイルの依存関係を解析し、変換の順番と対応表を作る | `migration/manifest.tsv`、依存宣言 |
| [02](prompts/02-gap-inventory.md) | 言語の意味の違いを洗い出し、変換ルールを決める | `migration/RULEBOOK.md`、`inventory.tsv` |
| [03](prompts/03-stress-test.md) | 難しい数ファイルでルールを試し、ルールを直す | `migration/stress-test/report.md` |
| [04](prompts/04-translation-kickoff.md) | 全ファイルを変換し、1ファイルずつ2人で独立レビュー | 変換後のソース、レビュー記録 |
| [05](prompts/05-survey-build.md) | 全体をビルドし、エラーをレビュー付きで直す | ビルド結果、修正記録 |
| [05b](prompts/05b-smoke.md) | 実際に起動・操作して基本動作を確かめる | smoke の結果 |
| [05c](prompts/05c-parity.md) | 同じ入力で新旧を動かし、結果を比べる | 比較の件数・差分 |
| [06](prompts/06-post-parity.md) | 残った課題を整理して引き継ぐ | 残課題・引き継ぎ |

03 の前には、ガードレール（`migration/guardrails.json`）を利用者の確認のうえで置きます。AI のセッションが git の履歴を書き換えるコマンドや、ビルド・テストのコマンドを直接実行するのを止めるものです（ビルドやテストはキットが記録付きで実行します）。

### 元のプログラムが動かない・仕様書がない場合

- 元のプログラムを動かせない場合は、新旧の動作比較（05c）を「未検証」として引き継ぐ [source-only 方式](docs/SOURCE-ONLY.md) になります。
- さらに仕様書もない場合は、ソースコードだけを仕様とする [source-as-spec 方式](docs/SOURCE-AS-SPEC.md) に初期設定のうちに切り替わります。00b・01・02 の成果物を AI がまとめて作り、利用者が一度確認すれば 03 へ進みます。

## 安全のための仕組み

- **元のソースは書き換えません。** ワーカーはファイルを読むだけで、書き込みはキットが変換先のファイルにだけ行います。
- **レビューは独立しています。** 2人のレビュー担当は同じ固定の入力を受け取り、互いの結果を見ません。入力が大きすぎる場合だけ、ファイル一覧とハッシュを渡して読み取り専用で読ませ、その旨を記録します。入力の上限 `maxReviewInputBytes` は新規導入で 1048576 bytes（1 MiB）です。
- **「完了」は記録で確かめます。** ファイルがあるだけでは完了にせず、入力・出力・レビューのハッシュを残します。元のソースやルールが変わると、関係する承認と完了は自動で失効します。
- **途中で打ち切りません。** 通常は時間や呼び出し回数で止めず、一時的な通信エラーは待ってやり直します（[止まる条件の一覧](docs/INTERRUPTION-POLICY.md)）。

## AI の使用量と課金

Copilot の課金は、使ったトークン量に応じた **GitHub AI Credits** です。キットの各ワーカー呼び出しは Copilot CLI の呼び出し1回として、利用者のアカウントの AI Credits を使います。チャットで話しているオーケストレーター自身の使用量も別にかかります。

キットが動かしたワーカーの使用量（トークン数と AI unit）は、`usage` コマンドで合計・担当・モデルごとに見られます。CLI は AI Credits への換算値を返さないため、金額は表示しません（[使用量の記録](docs/COST-LOG.md)）。上の工程表のとおり、04 の変換とレビューが最も多く AI を呼びます。

## 検証状況

| 項目 | 状況 |
|---|---|
| 自動テスト・付属デモ（AI を呼ばない） | Windows・Ubuntu で毎回実行 |
| 実際の Copilot CLI との接続（疑似のモデルで） | macOS で確認 |
| サインインした実モデルでの実行 | メンテナーの Windows PC で 03 の試運転まで実行（2026-10-31 時点） |
| 最後の工程まで通した移植品質 | 未評価 |
| VS Code・Copilot app の画面での操作 | エージェントの選択欄に出ることなど一部を確認。網羅的な確認はまだ |

実案件の前に [実アカウントでの小規模確認](docs/LIVE-SMOKE.md) を行ってください。

## 文書の案内

| 読みたいこと | 文書 |
|---|---|
| 仕組みと AI 呼び出しの図解、元のキットとの違い | [図解ガイド](guides/README.md) |
| 設定項目とコマンドの詳細 | [詳しい使い方](docs/REFERENCE.md) |
| プラグインの導入と更新 | [PLUGIN.md](docs/PLUGIN.md)、[UPGRADING.md](docs/UPGRADING.md) |
| 工程の順番とモード（普通・緩和・自動） | [ORDERED-WORKFLOW.md](docs/ORDERED-WORKFLOW.md) |
| 準備工程の調査の分担（survey） | [SURVEYS.md](docs/SURVEYS.md) |
| 依存解析器（Python・JS/TS・C/C++・C#・Java・VB.NET・PHP・COBOL） | [DEPENDENCY-MAPPERS.md](docs/DEPENDENCY-MAPPERS.md) |
| 03 の手順 | [STRESS-TEST-CHECKLIST.md](docs/STRESS-TEST-CHECKLIST.md) |
| 変更履歴 | [CHANGELOG.md](CHANGELOG.md) |

オーケストレーターが読む規則（英語）は [OPERATING-MANUAL.md](docs/OPERATING-MANUAL.md) から始まります。元のキットの文書は [UPSTREAM-README.md](docs/UPSTREAM-README.md)・[UPSTREAM-CLAUDE.md](docs/UPSTREAM-CLAUDE.md)・[RUN-NOTES.md](RUN-NOTES.md) に、固定した元のコミットは [UPSTREAM.json](UPSTREAM.json) に残しています。

## キットを開発する人へ

キットのリポジトリで次を実行します。AI の利用料もサインインも不要です。手順は [CONTRIBUTING.md](CONTRIBUTING.md) にあります。

```bash
npm test
npm run demo
```

権利表記は [LICENSE](LICENSE)・[NOTICE](NOTICE) を参照してください。
