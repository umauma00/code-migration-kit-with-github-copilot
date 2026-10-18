# 03 事前試行：1枚チェックリスト

日本語 | [English](STRESS-TEST-CHECKLIST.en.md)

03 は、RULEBOOK を本番の全ファイルに適用する前に、少数の難しいファイルで試す工程です。
残る成果物は**ルールの修正案だけ**で、ここで訳したコードは本番に使いません。
詳細は [03 のプロンプト](../prompts/03-stress-test.md) と [pilot](PILOT.md) にあります。この表は順番の確認用です。
プラグイン導入では `migration-kit/` をプラグインの絶対パスに読み替えます。

## 手順

| # | やること | 誰が | 確認方法 |
|---|---|---|---|
| 1 | 00〜02 の記録と judge の成功を確認する | AI | `status --format checklist` で「現在：03」 |
| 2 | AI が `guardrails show` を基に、対象のビルド・テストコマンドに合わせた禁止リスト（または免除の理由）をチャットで提案し、合意後に `guardrails install` を実行する | **人間**が合意し、ホストの確認で許可 | `doctor` の `command guardrails` が installed / waived |
| 3 | `phase start 03` | AI | 成功すれば開始記録が残る |
| 4 | RULEBOOK の危険な節と inventory の行を多く含むファイルを3つ選び、点数と根拠（file:line）を `migration/stress-test/report.md` に書く | AI | 報告に選定表がある |
| 5 | 比較試験 A：ルールに厳密に従って訳す（使い捨ての作業場所。本番には混ぜない） | AI（独立した文脈） | 訳の各判断にルールの節を引用 |
| 6 | 比較試験 B：リポジトリ外の空ディレクトリに元ファイルだけをコピーし、ルールを渡さずに「自然な書き方で」訳させる。下の「B の隔離コマンド」をそのディレクトリで実行する（VS Code でも同じコマンドをターミナルで使う） | AI（独立した文脈） | B にルール・inventory・会話・skill が渡っていない |
| 7 | 差分の検査：A と B を整形してから差分を1行ずつ判定（ルールが正しい／自然な訳が正しい／どちらも可／どちらも誤り） | AI（独立した文脈） | 判定ごとに根拠がある |
| 8 | pilot：`pilot prepare --target /外部の新しいディレクトリ --sources … --note …` → `pilot run --root …` | AI が実行、承認は**人間**（ホストが確認を求めます） | 本番と同じ担当・レビュー・修正の流れで、ルールが守られたか |
| 9 | 報告：ルールの修正案（RULEBOOK は編集しない）、ルール遵守の指摘、所要時間と使用量（runの要約の `usageEstimate`）、作業場所の削除確認、04 の所要時間の目安（`status`） | AI | `migration/stress-test/report.md` |
| 10 | 修正案を RULEBOOK に反映するか決める | **人間** | 反映したら `judge` をやり直し、変わった節を重点に新しいファイルで 5〜9 をもう一度 |
| 11 | 報告を確認して `phase complete 03 --note "確認した内容"` | 記録は AI、確認は**人間**（ホストが確認を求めます） | `status` で「現在：04【承認待ち】」 |

redesign 方式では 5〜7 の比較試験は行わず、設計文書への敵対的レビューと使い捨ての小さな試作に置き換えます。
同じ節を2回修正しても直らない場合は、3回目の言い換えをせず、人間に設計判断を求めます。

## B の隔離コマンド

`--no-custom-instructions` は AGENTS.md や Copilot 指示を止めますが、ユーザー／plugin の skill（本キットの `code-migration` skill を含む）の説明文は残ります。CLI 1.0.98 では `--available-tools` から `skill` を外すと、その説明文はモデルに届きませんでした。

```bash
mkdir /tmp/bakeoff-b && cp SOURCE_FILES /tmp/bakeoff-b/   # チェックアウトではなくコピーだけ
cd /tmp/bakeoff-b && copilot -p "Port these files to TARGET_LANGUAGE the way a fluent TARGET_LANGUAGE engineer would write them natively. Write each translation next to its source." \
  --model STRESS_B_MODEL --no-custom-instructions --disable-builtin-mcps --no-ask-user -s \
  --available-tools view,create,edit,glob,grep --allow-tool write
```

`STRESS_B_MODEL` は `phaseModels.stressB` です。B を移行チャットのサブエージェントとして動かさないでください。VS Code Local のサブエージェントは親の指示（キットの管理ブロックを含む `.github/copilot-instructions.md`）を受け継ぎます。終わったら `/tmp/bakeoff-b` を削除し、削除したことを報告に記録します。

## よくある止まり方

| 表示 | 原因 | 対処 |
|---|---|---|
| `Phase 03 requires human-installed command guardrails` | 手順2が未実施 | 禁止リストに合意し、`guardrails install` の確認で許可する。AI がファイルを直接作ることはできません（hook が拒否します） |
| `Phase 02 is not reviewed for current inputs` | RULEBOOK などを変えたため 02 の記録が失効 | 変更を確認して 02 を記録し直し、`judge` を再実行 |
| `Run judge successfully for these inputs` | 入力が変わり judge の結果が古い | `judge` を再実行 |
| `Pilot target must be a new directory` | pilot の作業場所が既に存在する | 新しい外部ディレクトリを指定 |
| `unable to ask user for confirmation` | 承認の確認を出せないセッション（非対話の実行など） | 表示されたコマンドを人間が自分のターミナルで実行 |
| `repository hooks load in Copilot CLI` が失敗 | フォルダが未信頼で hook が無効 | `copilot` を対話起動してフォルダを信頼する |

失敗したコマンドは、原因と選択肢（推奨付き）を自動で表示します。
