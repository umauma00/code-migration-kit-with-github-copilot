# 実アカウントでの小規模確認

自動テストはCopilot認証やAI呼び出しを行いません。この手順は、自分の環境で通常CLI経路を確認するためのものです。モデル呼び出しには利用枠・料金が発生します。

VS Codeのnative方式は [専用手順](NATIVE-WORKERS.md) を使います。下記の題材を準備した後、
judge・承認の前に `workerBackend: "native"` と `nativeHarness` を設定し、モデルをホストで
利用可能なものへ合わせます。runnerは継続実行し、親エージェントがlist/claim/submitを
処理してください。全5役のnativeプロファイル解決・モデル指定・ツールなしの実動作と、
キャンセル・再開を確認します。CLIの暗黙指示遮断と同じ保証があるとは扱いません。

1. Copilot CLIのログインを自分の環境で済ませ、`copilot --version` と `/model` で利用可能なモデルIDを確認します。
2. キットのルートから、**まだ存在しない**検証用ディレクトリを作ります。

   ```bash
   node scripts/demo.mjs setup --target /tmp/copilot-migration-live --model MODEL_ID
   cd /tmp/copilot-migration-live
   node migration-kit/scripts/run_migration.mjs doctor --check-cli
   ```

   setupは元ソース3ファイル、比較器、設定のたたき台だけを配置します。AI呼び出し・自動承認はしません。`test-double` はテスト専用名で、実モデルIDではありません。

3. `src/`、`tests/judge.py`、`migration/RULEBOOK.md`、manifest、inventory、`migration/review-dependencies.json` を確認します。mainからmath_ops/text_opsへの依存宣言と、独立ファイルの空配列を確認してください。事前試行報告のテンプレートを実際の試行結果で置き換えます。12ケースの範囲外は未検証です。
4. `judge` を実行します。originalは12ケース成功、mutationは意図的な負数・Unicodeの差分を検出し、いずれも終了0になることを確認します。
5. 確認後に `approve translation --note "実際に確認した内容"`、続いて `translate` を実行します。Copilot API・権限・モデル・JSON形式で失敗した場合はエラーとして止まることを確認します。安易に権限を広げて回避しないでください。
6. 各単位について、独立した2レビュー、必要なら裁定と修正後の再レビュー、要求モデル、出力ハッシュを確認します。2レビューの `reviewInputHash` が同じこと、レビュー担当の `tools: []` が実際に適用されることを確認します。全CLIワーカーに `--no-custom-instructions` が指定され、AGENTSや個人指示が混入せず、指定した役割プロファイルが適用されることも確認します。案件方針はRULEBOOK/inventoryへ取り込みます。`status` が `3/3` に相当する結果を返すことを確認します。
7. 各前工程を確認してからbuild → smoke → parityを個別承認・実行します。parityは12ケース、差分0、skip 0であることを確認します。
8. `translate` の再実行でAI呼び出し0になること、レビュー記録を検証用に退避すると再レビューされること、中断した処理が再開できることを確認します。失敗した検証用ロックの解除は所有プロセス停止後だけにします。

9. buildを再実行し、古いsmoke結果でparityへ進めないことを確認します。失敗時の試行記録にコマンド、要求モデル、stderr、時刻が残ることを確認します。設定したビルドスクリプトや `verificationInputs` を変えたら再承認が必要になることも確認します。

権限確認は使い捨てディレクトリで実施します。レビュー担当がread/searchを含むツールを使えないこと、他のワーカーが編集・shellを使えないこと、通常セッションは役割環境変数なしで利用できることを確認してください。テストで確認したhookのJSON変換と、実際のCLI/IDEがそのhookを実行することは別の確認項目です。

VS Codeを使う場合は、選択した実行方式で入口とhooksの実動作を別途確認してください。

- **Copilot（Agent Host）**：agentと共通の `/code-migration` スキルが見え、指定した工程を起動できることを確認します。prompt filesは読み込まれないため、10個の `/migrate-…` が登録されることは期待しません。
- **Local**：導入時に `--harness vscode-local` を指定し、VS Codeのチャットでも実行方式をLocalへ切り替えます。agent/skillに加え、工程の `/migrate-…` prompt filesが見えて起動できること、Local用hooksが実際に呼ばれることを確認します。導入時の `--harness` 指定だけではチャットの実行方式は変わりません。

Dynamic Workflowsは [専用の確認事項](DYNAMIC-WORKFLOWS.md) を追加してから試してください。

結果の記録例：CLI版、OS、Node版、モデルID、工程、単位数、ケース数、差分数、所要時間、実測できた利用量、未確認事項。未実測の費用やモデル名を推定値で埋めないでください。
