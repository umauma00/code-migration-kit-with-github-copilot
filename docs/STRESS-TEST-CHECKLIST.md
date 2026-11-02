# 03 事前試行：1枚チェックリスト

日本語 | [English](STRESS-TEST-CHECKLIST.en.md)

03 は、RULEBOOK を本番の全ファイルに適用する前に、少数の難しいファイルで試す工程です。
残る成果物は**ルールの修正案だけ**で、ここで訳したコードは本番に使いません。
詳細は [03 のプロンプト](../prompts/03-stress-test.md) と [pilot](PILOT.md) にあります。この表は順番の確認用です。
プラグイン導入では `migration-kit/` をプラグインの絶対パスに読み替えます。

## 手順

| # | やること | 誰が | 確認方法 |
|---|---|---|---|
| 1 | 00〜02 の記録と judge の成功を確認する。judge の結果は 03 の報告に書き、00〜02 の報告（feasibility.md・judge-report.md・depmap/report.md・gap-report.md）はメモのために書き換えない（書き換えるとその工程から先が記録し直しになり、元に戻すまで準備済みの pilot も動かない） | AI | `status --format checklist` で「現在：03」 |
| 2 | AI が `guardrails show` を基に、対象のビルド・テストコマンドに合わせた禁止リスト（または免除の理由）をチャットで提案し、合意後に `guardrails install` を実行する | **人間**が合意し、ホストの確認で許可 | `doctor` の `command guardrails` が installed / waived |
| 3 | `phase start 03` | AI | 成功すれば開始記録が残る |
| 4 | RULEBOOK の危険な節と inventory の行を多く含むファイルを3つ選び、点数と根拠（file:line）を `migration/stress-test/report.md` に書く | AI | 報告に選定表がある |
| 5 | 比較試験 A：ルールに厳密に従って訳す（使い捨ての作業場所。本番には混ぜない） | AI（独立した文脈） | 訳の各判断にルールの節を引用 |
| 6 | 比較試験 B：リポジトリ外の空ディレクトリに元ファイルだけをコピーし、ルールを渡さずに「自然な書き方で」訳させる。下の「B の隔離コマンド」（`stress-b command` が作ります）をそのディレクトリで実行する（VS Code でも同じコマンドをターミナルで使う） | AI（独立した文脈） | B にルール・inventory・会話・skill が渡っていない |
| 7 | 差分の検査：A と B を整形してから差分を1行ずつ判定（ルールが正しい／自然な訳が正しい／どちらも可／どちらも誤り） | AI（独立した文脈） | 判定ごとに根拠がある |
| 8 | pilot：先に `pilot plan --sources … --through translation`（書き込みなし）で最終のファイル数（選んだファイル＋それらが使っているファイル）を出し、その数で1回だけ許可を聞く → 同じ `--sources`・`--through` で `pilot prepare --target /外部の新しいディレクトリ --sources … --through translation --expect-total 26 --note …` → `pilot run --root …` | AI が実行、承認は**人間**（ホストが確認を求めます） | 本番と同じ担当・レビュー・修正の流れで、ルールが守られたか |
| 9 | 報告：ルールの修正案（RULEBOOK は編集しない）、ルール遵守の指摘、所要時間と使用量（runの要約の `usageEstimate`）、作業場所の削除確認、04 の所要時間の目安（`status`） | AI | `migration/stress-test/report.md` |
| 10 | 修正案を RULEBOOK に反映するか決める | **人間** | 反映したら `judge` をやり直し、変わった節を重点に新しいファイルで 5〜9 をもう一度 |
| 11 | 報告を確認し、変換を始めてよければ `approve translation --complete-phase 03 --note "確認した内容"`（03の完了と変換の承認を1回の確認で記録。完了だけなら `phase complete 03 --note …`） | 記録は AI、確認は**人間**（ホストが1回確認を求めます） | `status` で「現在：04」（完了だけなら「04【承認待ち】」） |

redesign 方式では 5〜7 の比較試験は行わず、設計文書への敵対的レビューと使い捨ての小さな試作に置き換えます。
同じ節を2回修正しても直らない場合は、3回目の言い換えをせず、人間に設計判断を求めます。

## B の隔離コマンド

`--no-custom-instructions` は AGENTS.md や Copilot 指示を止めますが、ユーザー／plugin の skill（本キットの `code-migration` skill を含む）の説明文は残ります。CLI 1.0.98 では `--available-tools` から `skill` を外すと、その説明文はモデルに届きませんでした。

まず作業場所を作って元ファイルだけをコピーし、runner に正確なコマンドを作らせます。runner は、そのモデルがこの CLI で持つファイル操作ツールを AI を使わずに CLI から読み取り、それだけを並べます（書き込みツールが無いモデルなら理由と選択肢を出して止まります。CLI に聞けない環境では `verified: false` と表示し、知られている全系統のツールを並べます）。表示された `bash` か `powershell` の行を、そのまま端末で実行します。

```bash
mkdir /tmp/bakeoff-b && cp SOURCE_FILES /tmp/bakeoff-b/   # チェックアウトではなくコピーだけ
node migration-kit/scripts/run_migration.mjs stress-b command --dir /tmp/bakeoff-b
```

runner を使えないときだけ、次の固定コマンドを使います。

```bash
cd /tmp/bakeoff-b && copilot -p "Port these files to TARGET_LANGUAGE the way a fluent TARGET_LANGUAGE engineer would write them natively. Write each translation next to its source." \
  --model STRESS_B_MODEL --no-custom-instructions --disable-builtin-mcps -s \
  --available-tools view,create,edit,apply_patch,glob,grep,rg --allow-tool write
```

`STRESS_B_MODEL` は `phaseModels.stressB` です。`apply_patch` は消せません。GPT 系の一部のモデル（CLI 1.0.105 の gpt-6-luna で確認）は `create` / `edit` を持たず、書き込みは `apply_patch` だけなので、これが無いと B は読み取り専用ツールだけになり何も書けません。B を移行チャットのサブエージェントとして動かさないでください。VS Code Local のサブエージェントは親の指示（キットの管理ブロックを含む `.github/copilot-instructions.md`）を受け継ぎます。終わったら `/tmp/bakeoff-b` を削除し、削除したことを報告に記録します。

## よくある止まり方

| 表示 | 原因 | 対処 |
|---|---|---|
| `Phase 03 requires human-installed command guardrails` | 手順2が未実施 | 禁止リストに合意し、`guardrails install` の確認で許可する。AI がファイルを直接作ることはできません（hook が拒否します） |
| `Phase 02 is not reviewed for current inputs` / `Phase 02's record is out of date` | RULEBOOK などを変えたため 02 の記録が失効（後者は変わったものと次の一手を示す） | 表示された次の一手に従う（報告に足したメモを取り除く、変更を確認して 02 を記録し直す、またはやり直す）。`judge` の再実行は、その後 `Run judge successfully for these inputs` と出たときだけ（再実行すると準備済みの pilot は使えなくなる） |
| `Run judge successfully for these inputs` | 入力が変わり judge の結果が古い | `judge` を再実行 |
| `Phase 02's record is out of date because phase 00b's record is`・`Phase 00b's record is out of date`（`judge-report.md changed` など報告の変更）／`Pilot parent phase 02 is out of date` | 記録済みの報告（judge の結果のメモなど）を書き換えた | メモを足しただけなら、足した部分をファイル編集でバイト単位のまま（改行コードも含めて）取り除く。git restore などは使わない（guardrails で禁止されていることがある）。記録し直しも judge の再実行も不要で、pilot もそのまま使える。誤りを直した変更や、取り除いても `phase next` が古いと示すときは、表示どおり確認して記録し直す（pilot は準備し直し） |
| `Pilot target must be a new directory` | pilot の作業場所が既に存在する | 新しい外部ディレクトリを指定 |
| `unable to ask user for confirmation` | 承認の確認を出せないセッション（非対話の実行など） | 表示されたコマンドを人間が自分のターミナルで実行 |
| `repository hooks load in Copilot CLI` が失敗 | フォルダが未信頼で hook が無効 | `copilot` を対話起動してフォルダを信頼する |
| `commands can write outside the project and use loopback` が失敗 | ローカル sandbox が有効で、リポジトリ外への書き込み（B・pilot）とローカル通信（hook 検査）ができない | そのセッションで人が `/sandbox off` にするか、sandbox の設定で書き込み先とローカル通信を許可する。AI は設定を変えません（初期設定中の `settings apply` でも聞きます） |

失敗したコマンドは、原因と選択肢（推奨付き）を自動で表示します。
