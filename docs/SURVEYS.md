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
- モデルは `phaseModels.survey`、未指定なら実装担当のモデルです。同時実行数は `concurrency` で、範囲どうしだけでなく、1つの範囲を分けた部分も同じ上限の中で並列に動きます（大きいディレクトリ1つが最後に残っても、空いた枠を使います）。通常実行はcontinuousで、旧設定の時間・呼び出し上限では打ち切りません。有限の上限は利用者がboundedモードを選んだ場合だけ適用します。

## 種類と使う工程

| 種類 | 工程 | 担当が返すもの | まとめ先 |
|---|---|---|---|
| `facts` | 00 事前調査（任意。既定は親が一部を抜き出して読む） | 公開入口・データ形式・外部依存・環境依存・生成コード・移行理由になる問題・危険な構文・テスト（すべて PATH:LINE 付き） | `migration/surveys/facts.md`（feasibility.md を書く材料） |
| `contracts` | 使わない（0.10.0 より前の source-as-spec 計画の互換用） | ファイルごとの公開インターフェース・入出力とエラー・境界条件・根拠・不明点 | 旧計画の未編集の `migration/source-spec/contracts.md` だけ。それ以外は `migration/surveys/contracts.draft.md` |
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
1ファイルの本文が上限を超えると、facts / contractsは元の行範囲を保った断片に分割します。inventoryでは、RULEBOOKと1箇所と一緒に1回の入力に収まらないファイルの箇所を、モデルを呼ばずにUNKNOWN / TODO(port)として記録します（断片ごとの答えは結合時に必ずUNKNOWNになり、数時間かけて同じ結果になっていたため）。scope記録の `unsurveyedOversizedFiles` に一覧が残ります。1行自体が大きい場合も文字位置で分け、Unicodeのペアや本文を欠落させません。

ファイル集合・census集合も分割し、全要求を実際のJSON化後bytesで検査します。検証済みの断片は `<scope-id>.parts/` に入力ハッシュ付きで保存し、同じ条件で再開すると再調査しません。scope IDは変えず、全断片・全ファイル・全箇所が揃うまでscopeはdoneにしません。contractsは断片ごとの観測と引用を機械的に結合し、断片をまたぐ未確定関係を明示します。inventoryの大きすぎるファイルの箇所は、既存のinventoryレビューで追跡します。必須メタデータ（rulebookやcensusの1項目）だけで容量を超える場合は、その原因を具体的に報告します。

大きい本文と多数のcensus箇所が重なるときは、入力容量を本文と箇所に配分し、同じ断片を箇所ごとに繰り返し送る回数を減らします。UTF-8以外の古い文字コード（Shift_JIS・EUC-JP・Latin-1・UTF-16）は、同梱の依存解析器と同じ規則で読み替えて渡し、入力の各ファイルに `encoding` を書きます（元ファイルは変更しません。0.11.1 から、変換を求めて止まることはありません）。かなを含まない漢字だけの Shift_JIS・EUC-JP は Latin-1 と区別しにくいため、`migration/config.json` の `sourceEncoding`（例 `"shift_jis"`）で指定できます。sourceRoots 配下の画像などのバイナリは調査対象から外し、件数を `binaryFilesLeftOut` に残します。censusの欠落ファイルや、census が指すバイナリは `skipped` に理由を記録し、読める範囲は先に保存します。その場合survey全体は未完了でmergeできません。censusを直して再開すると、既存の正常scopeは再利用します。

CPU 100%・低CPU・無出力・600秒経過・ログ量を理由に実行中の仕事を中断しません。[全停止条件と継続方針](INTERRUPTION-POLICY.md)を参照してください。

## 品質の扱い

- 固定入力には元ファイルの行番号と最終行を付けます。担当はその番号を引用し、検査では開始・終了行と範囲外の参照も確認します。
- contracts / inventoryの検証失敗は、同じ呼び出し上限内で1回だけ自動修復します。検証済みの行を保存し、未完了のファイル・箇所だけを次の固定入力へ渡します。引用を書き換えて通す処理はしません。失敗した回答も実行記録に残します。
- 修復後も引用を確かめられない行は、止めずに `uncited` 付きのUNKNOWN / TODO(port)として記録し、scopeを完了します（facts では不正な項目だけを捨てます）。根拠欄には元ファイルの範囲と却下した回答の記録だけを書き、担当が示した引用は残しません。件数はscope記録と `survey merge` の結果の `uncited`（facts で捨てた項目は `droppedFacts`、対象の取り違えで丸ごと捨てた答えは `droppedAnswers`）で確認でき（実行記録はその実行で完了したscopeだけを数えます）、レビュー報告に含めます。
- 中断した場合も、入力が同じなら保存した正常行と完了済みscopeを再利用します。以前の入力形式で作った結果も、現在のソースと引用行が検証できれば保持します。再開時に `--max-files` を省略しても保存済みの分割設定を使います。
- 長い実行は既存のターミナルを待ち、無出力だけを理由に中断しません。`status --fast --format markdown` はソースを再走査せず、surveyの完了数・実行中scope・起動数を表示します。`--wait 600` を付けると変化を待ちます。表示は記録上の進捗で、工程の承認・完了判定は従来の検証を行います。
- 担当の答えは、保存する前に検査します：範囲外のファイルを含む、PATH:LINE の引用がない、対象の取りこぼしがある（contracts は全ファイル、inventory は census の全箇所）といった答えは、そのまま保存しません（1回の修復後は上記のとおりUNKNOWNになります）。
- まとめた結果は**下書き**です。工程の独立監査（[準備監査](PREPARATION-AUDITS.md)、source-as-spec では仕様一式の独立レビュー）と人間の確認は従来どおり必要で、`survey merge` は工程を記録しません。
- 親は、まとめた下書きと担当が引用した行を確かめてから報告します。担当の答えは「事実の候補」で、判断の根拠ではありません。
