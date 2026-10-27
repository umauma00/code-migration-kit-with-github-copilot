# オーケストレーターから10工程を順番に進める

日本語 | [English](ORDERED-WORKFLOW.en.md)

[6大段階と内部工程の対応](EXECUTION-SCOPES.md)に沿って、以下の10工程を維持します。
00bは十分な既存judgeを再利用し、早期検証の記録を通す軽量な経路を持ちます。
[準備監査](PREPARATION-AUDITS.md)と[隔離pilot](PILOT.md)を参照してください。
pilotは本番03の完了ではなく、専用の限定許可で実行します。

工程は `00 → 00b → 01 → 02 → 03 → 04 → 05 → 05b → 05c → 06`。
新規設定のphasePolicyはstrict。既存設定は保持し、スキル開始時に次を実行して
工程記録を有効にする。プラグイン導入ではmigration-kit/を実際のプラグインルートに置換する。

```sh
node migration-kit/scripts/run_migration.mjs phase init
node migration-kit/scripts/run_migration.mjs phase next
node migration-kit/scripts/run_migration.mjs phase start 00
```

親は最初の未完了工程だけを実行する。利用者が後の工程を指定しても、未完了の前提を示して
その工程へ戻る。`phase check ID`は読み取り専用の前提確認。00〜03では `phase complete` と同じ内容（成果物、RULEBOOKの下書き、依存マップ）も確認する。`phase start ID`も前提を確認する。
00〜03の完了は、実際の成果物をレビューした利用者の指示に基づいて記録する。
既に承認された作業は再質問せず、具体的な判断理由をnoteに保存する。

```sh
node migration-kit/scripts/run_migration.mjs phase complete 00 --note "対象範囲と移行判断をレビュー済み"
```

| 工程 | 必要な証拠と通過条件 |
|---|---|
| 00 | feasibility.mdと具体的なレビュー記録 |
| 00b | judge-report.md。runtimeは比較入力とoriginal/mutation/parityの設定、source-onlyは実在するjudge-plan入力。正式judgeは02後 |
| 01 | depmap/report.md、manifest、監査した依存宣言 |
| 02 | gap-report.md、RULEBOOK、inventory、manifest、依存宣言 |
| 03 | 現在のjudge成功とstress-test/report.md、試作結果のレビュー。`phase start 03` には人間が設置した `migration/guardrails.json` も必要 |
| 04 | 実装承認と全単位の有効な独立2レビュー。runnerの記録で判定。`phase start 04` にもガードレールが必要 |
| 05 | 現在の承認付きbuild成功 |
| 05b | 現在の承認付きsmoke成功 |
| 05c | runtimeは実際のparity成功。source-onlyは現在のsmokeを確認し、対象外・同等性未検証の記録を残す |
| 06 | runtimeは現在のpost-parity承認、整理後のhandoff.mdとphase complete 06。source-onlyは実際のhandoff成功 |

工程記録はmigration/phases/に保存する。テンプレートや成果物の存在だけでは完了にならない。
ソース・方式・根拠・前工程の記録が変われば、影響する工程は未完了に戻る。
02の監査で01の依存宣言やmanifestを変更した場合は、01の報告も更新して再確認してから進める。
既存案件は実際の報告を点検し、順番に完了記録を残す。以前の作業を再実行するためだけに
報告を作り直す必要はないが、未検証の工程を通過済みとは記録しない。

正式judgeは02の通過前に拒否され、実装承認とrunnerは03の通過前に拒否される。
build以降は既存の承認・前工程・出力ハッシュの検査を併用する。
source-onlyではsmoke後に次を記録してから06へ進む。

```sh
node migration-kit/scripts/run_migration.mjs phase start 05c
node migration-kit/scripts/run_migration.mjs phase complete 05c --note "source-onlyのため比較は対象外。動作同等性は未検証"
```

この制御はキットの入口とrunnerに適用する。VS Code自体の任意の編集を禁止する機能ではない。
工程TODOも現在の記録に合わせ、完了を確認できない工程をチェック済みにしない。
利用量の記録は[main形式のcost-log](COST-LOG.md)を参照。
