# main形式の利用量記録

日本語 | [English](COST-LOG.en.md)

要求modelと実modelを分けます。native submitのhostReportedModelは親からの入力であり、
それだけでは実測として集計しません。正式adapterの観測がない間はunknownです。
pilotのAI呼出しは03、production repairは05、通常翻訳は04として記録します。
judge-prepareと正式judgeの再利用は別の実行行ですが、再利用時に新しいAI呼出しは計上しません。

mainと同じ `migration/cost-log.tsv` を出力する。ヘッダーは次の6列。

```text
step	timestamp	wall_clock_min	tokens	subagents	model
```

00〜03とruntimeの06は、phase startからphase completeまでの時間を記録する。
開始記録がない場合、所要時間はunknown。取得できたホストの実測値だけを、完了時に渡す。

```sh
node migration-kit/scripts/run_migration.mjs phase complete 01 --note "依存解析とレビューを確認" --tokens 12345 --subagents 2 --model ACTUAL_MODEL_ID
```

値が不明ならオプションを省略する。モデルは実際のホスト実行情報で確認し、設定値や
ワーカーの自己申告を実績として転記しない。料金・トークン数は推計しない。

runnerはjudge、translate/repair、build、smoke、parity、handoffの各実行を自動記録する。
失敗・中断も、回収と実行要約の保存まで到達した場合は記録する。04のsubagentsは実際に
呼んだアダプター数で、呼ぶ前に中止した予約は含めない。1件でも使用量不明なら合計tokensも
unknownとする。CLI方式の model 列には、CLIがJSONLの `model.call_final_result` で報告した実行モデルを記録する（全呼び出しで取れた場合のみ。要求と違えばrunの警告）。取得できない場合と、CLIが出さないトークン数はunknown。

自動記録の時間・使用量はrunner内の活動を対象とし、親の会話やRubber Duckの使用量を
含めた総課金額ではない。AIを呼ばない検証コマンドはtokens=0、subagents=0、model=none。
正式judgeは00bの検証活動として追加記録する。複数行は別の実行・再試行であり、工程完了数ではない。

mainの既存TSV行は保持する。イベントIDをmigration/phases/cost-index.jsonで管理し、
同じ完了記録の再出力では重複させない。TSVの削除や保存途中の停止はインデックスから再出力できる。
管理済みの行を手で編集した場合は、不一致を知らせて停止する。新しい行の追記は保持する。

runの要約 `migration/runs/RUN_ID/summary.json` の `usageEstimate` は、ワーカーへ送った入力と応答の実測バイト数と、バイト÷4による推定トークン数です。AI Creditsの課金データではないため、cost-log.tsvの `tokens` には入れず、unknownのままにします。
