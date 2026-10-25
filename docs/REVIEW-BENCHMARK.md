# ワーカーを統合する前に測る（レビュアー数・fixer）

日本語 | [English](REVIEW-BENCHMARK.en.md)

翻訳ループのワーカーを減らすと、呼び出し回数と時間は減ります。ただし品質が落ちるかどうかは、測らないと分かりません。このベンチマークは、次の2つの統合案を、欠陥を埋め込んだ同じ題材と同じ Copilot CLI ワーカーで比べます。

| 比較 | 現行 | 統合案 | 見る数字 |
|---|---|---|---|
| レビュー | 独立した2レビュー＋裁定 | 1レビュー（両観点）＋裁定 | 裁定後の見逃し率、欠陥なし題材での誤検出 |
| 修正 | fixer | implementer に確定指摘を渡す | 修正後の動作チェック合格率 |

翻訳ループの動作は変えません。結果を見て、統合するかどうかは人が決めます。

## 背景

Anthropic の記事「[Building agents: When to fold subagents into your main agent loop](https://claude.com/ja/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)」（2026-10-22）は、サブエージェントを畳むときの進め方として次を勧めています。

- 先に小さな評価を作り、畳むのは一度に1つだけにする。スコアが下がったら分けたままにする。
- スコアだけでなく、どのタスクの結果が変わったかを見る。
- 壊れ方は毎回出るとは限らない（記事の例では2回に1回）。各タスクを複数回実行する。

記事の判断基準では、「出力を順に受け渡す」「同じデータを触る」役は統合の候補です。fixer は implementer と同じツール・同じ出力形式で、この条件に当てはまります。2つのレビューは、作った側に採点させないための分離で、記事の基準とは別の理由で分けています。どちらも、ここで測ってから決めます。

## 手順

モデル呼び出しには利用枠・料金が発生します。題材は `fixtures/mini` の3ファイルです。

1. キットのルートで、まだ存在しないディレクトリを指定して検証用のルートを作ります。

   ```bash
   node scripts/review_benchmark.mjs setup --target /tmp/review-bench --model MODEL_ID
   ```

   全担当に同じモデルが入ります。担当ごとに変える場合は `/tmp/review-bench/migration/config.json` の `models` と `reasoningEfforts` を編集します。レビューの観点は `reviewFocus: "shared"` に設定されます（1人のレビューでも両方の観点を見るため）。

2. 呼び出し回数の上限を確認します。

   ```bash
   node scripts/review_benchmark.mjs plan --root /tmp/review-bench --runs 3
   ```

   既定（9題材×3回）では最大177回です。内訳は、レビュー2人が81回、レビュー1人が54回、修正が42回です。裁定は指摘があったときだけ呼ぶので、実際の回数は上限以下になります。`--part review|fix` で片方だけ、`--cases math-trunc,text-trailer` で題材を絞れます。

3. plan で表示された `total` を `--max-calls` に指定して実行します。

   ```bash
   node scripts/review_benchmark.mjs run --root /tmp/review-bench --runs 3 --max-calls 177
   ```

   結果は `/tmp/review-bench/bench-results/<時刻>/` に出ます。

   | ファイル | 内容 |
   |---|---|
   | `report.md` | 比較表と、結果が変わった題材の一覧 |
   | `summary.json` | 集計 |
   | `results.jsonl` | 1回ごとの全指摘・照合結果・トークン |
   | `fixes/` | 修正結果のファイル |

   最初の呼び出しが失敗したとき（ログインやモデルIDの誤り）は、何も測らずに止まります。

## 題材と照合

| 題材 | 欠陥 | 種類 |
|---|---|---|
| math-trunc | 商を `Math.trunc` で切り捨て（Python は floor） | 意味 |
| math-remainder | 剰余に JS の `%` を使用（符号が違う） | 意味 |
| math-zero | ゼロ除算の例外がない | 意味 |
| math-double | trunc とゼロ除算の2件 | 意味 |
| text-length | `name.length`（UTF-16 単位で数える） | 意味 |
| text-trailer | PORT STATUS の末尾行がない | 規則 |
| main-import | `./math_ops.js` を import（規則は .mjs） | 規則 |
| control-math / control-text | 欠陥なし（指摘はすべて誤検出） | — |

- 指摘が欠陥の行（前後1行まで）を `パス:行` で挙げているか、欠陥ごとの語句（`pattern`）に当てはまれば、見つけたと数えます。機械的な照合なので、判断の前に `results.jsonl` の指摘を目で確かめてください。
- 修正の比較では、両方に同じ正解の指摘を渡します。レビューのばらつきを修正の比較に混ぜないためです。修正後のファイルは `fixtures/review-bench/checks/` の動作チェックで判定します。未変更で返したときは不合格です。チェックはモデルが返したコードを Node で import するので、検証用のディレクトリで実行してください。
- 題材を足すときは `fixtures/review-bench/cases.json` に書きます。欠陥ありの題材はチェックに落ち、欠陥なしの題材は通ることを `tests/review-benchmark.test.mjs` が確かめます。

## 判断の目安

記事の原則（スコアが下がったら分けたまま）に沿って、次をすべて満たすときだけ統合を検討します。

- **レビュー**：レビュー1人の裁定後の見逃し率がレビュー2人以下で、「Cases that changed」にレビュー1人が少なく見つけた欠陥がない。欠陥なし題材での確定した誤検出も増えていない。
- **修正**：implementer の合格率が fixer 以上で、合格回数が減った題材がない。

差がなくても、統合して安全だという証明にはなりません。題材は小さな3ファイルで、欠陥は8件だけです。実案件に近い難しい題材を足してから判断することを勧めます。統合すると決めた場合も、翻訳ループの変更は別の変更として入れ、同じベンチマークで確かめ直します。
