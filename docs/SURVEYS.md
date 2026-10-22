# 準備工程の調査を範囲ごとに任せる（survey）

日本語 | [English](SURVEYS.en.md)

00・00b・02 では、親エージェントがコードベース全体を自分の会話に読み込むと、
大きなリポジトリでは文脈が足りなくなります。`survey` はソースを**範囲（scope）**に分け、
範囲ごとに新しい調査担当（surveyor）へ任せ、**結果をファイルで受け取ります**。
親が読むのは、まとめた下書き（数件〜数十件の要約）だけです。
00 は移行するかの判断なので、既定では親が一部を抜き出して読み、読まなかった範囲を報告します（上流と同じ）。survey は全ファイルを扱う 00b・02 で使い、00 では任意です。

- 範囲ごとに新しい `copilot` プロセスを起動します（`--agent migration-surveyor`、ツールなし、`--no-custom-instructions`）。VS Code から進める場合も同じです。
- 範囲内のソース本文を固定入力として渡します。担当は他のファイルや他の範囲の結果を読みません。
- 結果は `migration/surveys/<種類>/<範囲ID>.json` に、範囲の入力ハッシュと一緒に保存します。ファイルがあり、入力が変わっていなければ完了扱いです。中断しても、再実行すれば残りの範囲だけが動きます。
- 1つの範囲の失敗は他の範囲を止めません。一時的な失敗は再試行し、サインイン切れなどは全体を止めます（翻訳と同じ規則）。
- モデルは `phaseModels.survey`、未指定なら実装担当のモデルです。同時実行数・呼び出し上限は `concurrency`・`maxAgentCalls` です。

## 種類と使う工程

| 種類 | 工程 | 担当が返すもの | まとめ先 |
|---|---|---|---|
| `facts` | 00 事前調査（任意。既定は親が一部を抜き出して読む） | 公開入口・データ形式・外部依存・環境依存・生成コード・移行理由になる問題・危険な構文・テスト（すべて PATH:LINE 付き） | `migration/surveys/facts.md`（feasibility.md を書く材料） |
| `contracts` | 00b（source-as-spec） | ファイルごとの公開インターフェース・入出力とエラー・境界条件・根拠・不明点 | `migration/source-spec/contracts.md`（未編集の雛形の場合だけ。編集済みなら `migration/surveys/contracts.draft.md`） |
| `inventory` | 02 意味の差 | 機械的に作った箇所一覧（census）の各箇所の分類・訳し方・根拠・confirmed/unknown | 範囲ごとのシャード → 既存の inventory マージで `migration/inventory.tsv` |

## コマンド

```bash
R="node migration-kit/scripts/run_migration.mjs"   # プラグイン導入ではプラグインの絶対パス
$R survey plan   --kind facts [--max-files 20]     # 範囲の分け方を確認（AIは呼ばない）
$R survey run    --kind facts                      # 未完了の範囲を実行（中断後も同じコマンドで続き）
$R survey status --kind facts                      # 範囲ごとの done / pending
$R survey merge  --kind facts                      # 全範囲がそろったら下書きにまとめる

# inventory は、先に grep やスクリプトで箇所一覧を作る（判断ではなく機械的に）
$R survey run   --kind inventory --sites migration/inventory-sites.tsv
$R survey merge --kind inventory --sites migration/inventory-sites.tsv
```

範囲は「同じディレクトリのファイルをまとめ、`--max-files` 件ごと、かつ固定入力の上限（`maxReviewInputBytes`）以内」で機械的に決まります。
1ファイルだけで上限を超える場合、その範囲は実行せずに理由を表示します。

## 品質の扱い

- 担当の答えは、保存する前に検査します：範囲外のファイルを含む、PATH:LINE の引用がない、対象の取りこぼしがある（contracts は全ファイル、inventory は census の全箇所）といった答えは保存しません。
- まとめた結果は**下書き**です。工程の独立監査（[準備監査](PREPARATION-AUDITS.md)、source-as-spec では仕様一式の独立レビュー）と人間の確認は従来どおり必要で、`survey merge` は工程を記録しません。
- 親は、まとめた下書きと担当が引用した行を確かめてから報告します。担当の答えは「事実の候補」で、判断の根拠ではありません。
