# review-candidate生成のTypeError調査

## 画像から分かることと確認範囲

画像は「parseTsvは行配列を返すが、追加したwriteReviewCandidateがparsed.notesを参照したためTypeError」と報告している。
この説明どおりなら、呼び出し側が配列と `{notes, rows}` 形式のオブジェクトを取り違えている。
配列で `.notes` を参照するだけなら値はundefinedになるため、例外の正確な発生式は後続の配列操作などを含む実装・stack traceとの照合が必要。

対象ブランチ・保存した旧作業・workspaceを検索したが、その関数名のコードはない。
接続先のGitHub検索でも対象の移行スクリプトは特定できなかった（検索は既定ブランチ対象）。
追加helperのファイルと実行ログは未入手で、画像内の原因説明を実コードで確定したとは扱わない。
キット同梱の `lib/preparation.mjs` の内部TSVパーサーは、変更前から `{notes, rows}` を返している。
今回の対策ではこの形式を維持し、共有パーサーの戻り値を配列へ変更していない。

JavaScriptの構文チェックでは戻り値の形の取り違えは検出できない。
shard検証だけを通しても、その後に追加した候補writerを実行しなければ例外は表面化しない。
そのため、候補生成からハッシュ照合・正式mergeまで実行する回帰テストを追加した。

## 対策

- `inventory-preview` を標準機能として追加し、候補作成と正式mergeで同じパーサー・検証・整形処理を使う。プロジェクトごとに別のTSV helperを生成する必要を減らす。
- コメント行も保持する。単にundefinedを空配列へ置換するだけでは、全レビューに必要なinventory notesを落とす可能性がある。
- 全censusの網羅、行形状、UNKNOWN要件、矛盾する回答を検証してから候補を原子的に書く。失敗時は既存候補、shard、正式inventory、正式merge receiptを保持する。
- 正式mergeの `--expected-hash` で、レビューした候補と最終出力のbytesを照合する。不一致では正式ファイルへ書かない。
- 検証済みshardと元入力が現行なら候補生成から再開する。再survey、検証省略、証拠の書き換えは不要。
- coordinator所有の準備・報告helperのTypeError/SyntaxErrorは、実装と呼び出しの契約を確認して修正・検証し、同じ許可範囲で再開する。ルール・元ソース・judge・inventory判断の変更は従来のgateで扱う。
- helperを追加・変更した際は、コメント付きTSVと通常行を含む小さな入力で、解析だけでなく候補の書き出しまで確認する。既存shardを使える場合、これらのチェックに新しいモデル呼び出しは不要。

使い方・ハッシュの意味は [準備監査](../../docs/PREPARATION-AUDITS.md#inventory-02) を参照。

## 検証

全テストは388件中386成功・失敗0・Windows専用skip 2。demoもcontinuousモードで成功し、12ケースの比較差分・skipとも0。

`tests/inventory-preview.test.mjs` は、BOM/CRLF・コメント保持・重複排除・正式出力との同一性、
検証失敗・ハッシュ不一致時の非更新、出力先の衝突・hardlink拒否、承認前のpreviewと正式merge gateの分離、
628箇所の合成データ、導入済みCLIの往復を確認する。
628箇所は画像の実データではなく、欠落・重複・型エラーを検出するテスト用データ。
画像の移行先helper自体への適用・再実行はまだ行っていない。
