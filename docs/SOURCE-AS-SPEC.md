# ソースを唯一の仕様として移行する（source-as-spec）

日本語 | [English](SOURCE-AS-SPEC.en.md)

現行の実行環境が残っていない、仕様書や設計書がない案件向けの準備方式です。
**ソースコードだけを唯一の仕様・設計書**として、比較テストの準備（00b）・依存関係（01）・
意味の差とルール（02）をAIが一括で作成し、**ユーザーが一度確認してOKすれば**移行（03以降）へ進みます。
[source-only方式](SOURCE-ONLY.md)の上に作る準備手順で、動作同等性は最後まで「未検証」として引き継ぎます。

## いつ選ぶか

| 状況 | 推奨 |
|---|---|
| 現行を動かせない／仕様書がない | **source-as-spec**（この文書） |
| 現行を動かせる | 既定のruntime方式。新旧比較で同等性を実際に検証できる |
| 現行は動かないが仕様書・既存テストがある | source-only。仕様書由来のシナリオを `judge-plan.json` に登録 |

初期設定（`settings init`）で「現行を動かせますか」を聞き、「いいえ」のときだけ
続けて「仕様書や移行先でも使える自動テストはありますか」を聞きます。これも「いいえ」なら、
`settings apply` の後、工程 00 より前に `source-spec init` で変更内容を示し、
`source-spec init --apply`（ホストが1回確認します。自動モードでは確認なし）でこの方式に切り替えます。

## 始め方

新規案件：

```bash
node /path/to/code-migration-kit/scripts/install.mjs --target . --model MODEL_ID --preparation-profile source-as-spec --apply
```

既存案件（runtime方式で00bが止まった場合など）：

```bash
node migration-kit/scripts/run_migration.mjs source-spec init          # 変更内容の確認だけ
node migration-kit/scripts/run_migration.mjs source-spec init --apply  # ユーザーの同意後に適用
```

`init --apply` は、`migration/config.json` を `verificationMode: "source-only"`・
`preparationProfile: "source-as-spec"` に切り替え、まだないファイルだけを作ります。

- `migration/judge-plan.json`：sourceRoots配下の全ソースを列挙した準備記録
- `migration/source-spec/sources.md`：仕様となるソースファイルの一覧（機械生成。記入は不要）

0.10.0 から、ファイルごとの契約メモ（`contracts.md`）は作りません。ソースそのものが仕様なので、
メモを作る調査とメモの正しさの確認の両方に時間がかかるだけだったためです。レビュー担当はソースの行を直接読みます。

方式の切り替えは設定変更なので、以前の承認・記録は失効します（00bから確認し直し）。

最初から source-as-spec で導入した案件では、設定は変わらないので `source-spec init`（`--apply` なし）がそのまま下書きを作ります。キットが用意する下書きのために利用者へ同意を求めることはありません。
00b〜02 は一括で記録するので、00b の記録前でも `phase start 01`・`phase start 02` を実行でき、`phase check 00b,01,02` でまとめて確認できます（記録は `phase complete 00b,01,02` で順番どおりに行います）。

## AIが作るもの（00b〜02を一括）

`source-spec check` が、残っている成果物と推奨コマンド（依存解析・manifest・依存宣言）を表示します。

| 工程 | 成果物 | 作り方 |
|---|---|---|
| 00b | `judge-report.md` | 対象範囲、方式、未検証の範囲（ファイルごとの契約メモは不要） |
| 01 | `depmap/`、`manifest.tsv`、`review-dependencies.json`、`depmap/report.md` | 同梱の解析器で機械的に生成（推測しない）。ソースを読むだけで元のアプリは実行しない。同梱版のない言語は[アダプタを自作](DEPENDENCY-MAPPERS.md) |
| 02 | `RULEBOOK.md`、`inventory.tsv`、`gap-report.md` | ソースの実際の使われ方から方針を決める。判断できない箇所はinventoryにUNKNOWNとして残し、最も保守的な訳とTODO(port)を指定 |

02 の inventory 調査の前に、生成コードの検出（`generated-files --write`、件数だけ報告）、ソースから作った方針の質問（`policy-questions` を ask_user でまとめて1回、答えは `policy-record` で RULEBOOK に記録。自動モードは最も保守的な案）、規則のない構文の確認（`rulebook-coverage`）と構文ごとの試し調査（`survey run --trial 3`）を行います。詳しくは [調査](SURVEYS.md) と prompts/02 を参照してください。

0.10.0 より前に作った judge-plan が `contracts.md` を指している場合は、従来どおり `TODO(spec)` が残っている間は00bを記録できません。
新しい方式に移るには、`migration/judge-plan.json` を削除してから `source-spec init` をやり直します（設定は変わらないので00の記録は残り、00b〜02は一括確認をやり直します）。

### 準備監査を軽くする

標準の[準備監査](PREPARATION-AUDITS.md)（01の依存監査、02の最初の20行での停止や2名の分割監査など）は行いません。
代わりに、**仕様一式に対する独立レビューを1回**行います。

- 作成者とは別の文脈のレビュー担当1名が、ソース・RULEBOOK・inventory・依存マップを一緒に読み、
  ソースと食い違う記述、根拠の行番号がない記述、ルールとinventoryの矛盾を挙げる
- 指摘はソースで確かめ、確かめられたものだけを修正し、**直した箇所だけを1回だけ**新しい依頼で再レビューする（フォーク元と同じく修正は1回まで。どのモードでも同じ）。それでも残った指摘はもう直さず、inventory の行は UNKNOWN（最も保守的な訳と TODO(port)）にする
- **修正済みの指摘・残った論点（根拠つき）・この方法で UNKNOWN にした行（件数つき）**をユーザーへの報告に含める。進むか直すかはユーザーが一括確認で決める（自動モードでは同じ一覧を記録の note に書いて先へ進む）
- 依存解析は機械的に作るため、エージェントによる辺のサンプリング監査は省略する。解析器の未対応構文・除外は `depmap/report.md` に書く

## ユーザーの確認は1回

仕様一式がそろったら、AIは1つの報告にまとめて表示します。

1. 生成した成果物へのリンク（上表のすべて）
2. 確認してほしい点：影響が大きい推定、UNKNOWNの一覧（引用を確かめられず UNKNOWN にした行の数を含む）、独立レビューで残った論点
3. 選択肢（推奨付き、理由つき）：「この仕様一式で移行へ進む（推奨）」「指摘箇所を修正する」「中断する」

ユーザーがOKと答えた場合だけ、AIは次のコマンドで3工程をまとめて記録します。

```bash
node migration-kit/scripts/run_migration.mjs phase complete 00b,01,02 --note "ユーザーが仕様一式を確認：（確認した内容）"
node migration-kit/scripts/run_migration.mjs judge
```

記録の前に3工程すべての成果物を検査し、1つでも不足があれば**どの工程も記録せず**、原因と選択肢を表示します。
00（事前調査）は別に確認します。

## その後

03（事前試行）以降は通常どおりです。03は3ファイル程度で、本番と同じ変換・2人レビュー・修正の流れが
ルールどおりに動くかを確かめる工程で、生成したルールの誤りを本番の全ファイルに広げないために残しています。
05c（新旧比較）は「この方式では未検証」と表示し、05bのsmoke成功後に[06の引き継ぎ](SOURCE-ONLY.md)へ進みます。
最終結果は **ソース基準の移植完了・動作同等性未検証** です。
