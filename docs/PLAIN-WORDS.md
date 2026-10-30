# Plain words for questions and reports

The person answering knows nothing about the kit. Use the everyday words on the
right in every question, choice and reply example. When a kit term cannot be
avoided, put the everyday words first and the term in parentheses.
Phase numbers (00 to 06) and the model-change answer format stay as they are.

| Kit term | 日本語で言うとき | In English |
| --- | --- | --- |
| pilot | 試運転（プロジェクトの外のコピーで、本番と同じ手順を少数のファイルで試す） | trial run on a copy outside the project |
| grant | 試運転の許可記録 | the trial run's permission record |
| target (pilot) | 試運転のコピー先フォルダー | the trial run's copy folder |
| target (unit) | 変換後のファイル | the translated file |
| translation-only | 変換とAIの確認まで（変換後のビルドや動作確認はしない） | translate and AI-check only, no build or run |
| through build / smoke / parity | 変換後のビルド／簡単な動作確認／新旧の動作比較まで | up to build / a quick run / comparing old and new |
| revoke the grant, clean the target | 許可記録とコピー先フォルダーを消す | delete the permission record and the copy folder |
| dependency expansion | 選んだファイルが使っているファイルも自動で加わる | files the chosen ones use are added automatically |
| judge | 新旧を比べるテストの判定 | the old-versus-new test check |
| manifest | 変換するファイルの一覧 | the list of files to translate |
| inventory | 要注意箇所の一覧 | the list of tricky spots |
| RULEBOOK | 変換ルール | the translation rules |
| depmap / review dependencies | ファイル同士のつながり | how files depend on each other |
| receipt | 完了の記録 | the completion record |
| gate / approve | 承認ポイント／承認する | approval point / approve |
| waive | 見送って先へ進む（記録が残る） | skip and go on (recorded) |
| guardrails | AI に実行させないコマンドの禁止リスト | the list of commands the AI must not run |
| hook | キットの安全チェック | the kit's safety check |
| source-as-spec | 元のコードだけを仕様として準備する方式（仕様書も動く元のコードもないとき） | prepare with the original code as the only specification |
| source-only | 元のコードを動かさない確認方式（新旧の動作比較はしない） | checking without running the original (no old-versus-new comparison) |
| judge-plan.json | 新旧を比べるテストの計画ファイル | the plan file for the old-versus-new tests |
| runtime mode | 元のコードを動かして新旧を比べる方式 | run the original and compare old and new |
| concurrency | 同時に動かすAIの数 | how many AI workers run at once |
| survey | 元のコードの調査 | the survey of the original code |
| sandbox | サンドボックス（このセッションのコマンドにかかる制限） | the sandbox limiting this session's commands |
| autopilot / auto mode | 自動で進めるモード | the mode that proceeds by itself |
