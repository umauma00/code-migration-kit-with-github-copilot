# 実アカウントでの小規模確認

日本語 | [English](LIVE-SMOKE.en.md)

自動テストはCopilot認証やAI呼び出しを行いません。この手順は、自分の環境で通常CLI経路を確認するためのものです。モデル呼び出しには利用枠・料金が発生します。

VS Codeから進める場合も、ワーカーは同じCopilot CLIです。チャットだけで完遂できること（下の確認項目）も合わせて確認してください。

1. 報告の言語は `run_migration.mjs preferences --language ja|en` で設定するか、スキルの最初の質問で選びます。Copilot CLIのログインを自分の環境で済ませ、`copilot --version` と `/model` で利用可能なモデルIDを確認します。
2. キットのルートから、**まだ存在しない**検証用ディレクトリを作ります。

   ```bash
   node scripts/demo.mjs setup --target /tmp/copilot-migration-live --model MODEL_ID
   cd /tmp/copilot-migration-live
   node migration-kit/scripts/run_migration.mjs doctor --check-cli
   ```

   setupは元ソース3ファイル、比較器、設定のたたき台だけを配置し、strictとtodo-lines-v1を選びます。AI呼び出し・自動承認・03報告の作成はしません。`test-double` はテスト専用名で、実モデルIDではありません。

3. `phase init`、`phase next`に従い、00の対象範囲とmodel planを実際にレビューします。各工程の作業前にphase start、ユーザーの確認後にphase complete ID --noteを記録してください。`src/`、`tests/judge.py`、`migration/RULEBOOK.md`、manifest、inventory、`migration/review-dependencies.json`を確認し、[準備監査](PREPARATION-AUDITS.md)の適用対象を検証します。mainからmath_ops/text_opsへの依存宣言と独立ファイルの空配列を確認し、draft報告は実際の証拠で更新します。12ケースの範囲外は未検証です。
4. 00の確認後、00bで`judge-prepare`を実行します。originalは12ケース成功、mutationは意図的な負数・Unicodeの差分を検出し、いずれも終了0になることを確認します。00b/01/02の実レビュー後に正式`judge`を実行します。早期証拠の再利用が記録され、本番03前提は維持されることを確認します。
5. 03の前に、AIが提案する禁止リストに合意し、`guardrails install` の確認ダイアログで許可します。`phase start 03` がこのファイルなしでは停止すること、対話セッションで `git reset --hard` 等が拒否されることを確認します。コピー導入では、`copilot` を一度対話起動してフォルダを信頼済みにし、`doctor` の `repository hooks load in Copilot CLI` が失敗しないことを確認します。
   続いて[pilot手順](PILOT.md)に従い、別の新規ディレクトリへ明示的な使い捨て許可を作り、同じCLI profilesでpilot runを実行します。本番は03未承認でtranslationを拒否すること、pilot結果が本番doneにならないことを確認します。実際の試作・監査結果で03報告を作り、ユーザー確認後にphase complete 03と`approve translation --note "実際に確認した内容"`、続いて`translate`を実行します。Copilot API・権限・モデル・JSON形式で失敗した場合はエラーとして止まることを確認します。安易に権限を広げて回避しないでください。
6. 各単位について、独立した2レビュー、必要なら裁定と修正後の再レビュー、要求モデル、出力ハッシュを確認します。2レビューの `reviewInputHash` が同じこと、レビュー担当の `tools: []` が実際に適用されることを確認します。全CLIワーカーに `--no-custom-instructions` が指定され、AGENTSや個人指示が混入せず、指定した役割プロファイルが適用されることも確認します。案件方針はRULEBOOK/inventoryへ取り込みます。`status` が `3/3` に相当する結果を返すことを確認します。
7. 各前工程を確認してからbuild → smoke → parityを個別承認・実行します。parityは12ケース、差分0、skip 0であることを確認します。
8. `translate` の再実行でAI呼び出し0になること、レビュー記録を検証用に退避すると再レビューされること、中断した処理が再開できることを確認します。失敗した検証用ロックの解除は所有プロセス停止後だけにします。

9. buildを再実行し、古いsmoke結果でparityへ進めないことを確認します。失敗時の試行記録にコマンド、要求モデル、stderr、時刻が残ることを確認します。設定したビルドスクリプトや `verificationInputs` を変えたら再承認が必要になることも確認します。

権限確認は使い捨てディレクトリで実施します。レビュー担当がread/searchを含むツールを使えないこと、他のワーカーが編集・shellを使えないこと、通常セッションは役割環境変数なしで利用できることを確認してください。テストで確認したhookのJSON変換と、実際のCLI/IDEがそのhookを実行することは別の確認項目です。

VS Codeを使う場合は、選択した実行方式で入口とhooksの実動作を別途確認してください。

- **Copilot（Agent Host）**：エージェント一覧にオーケストレーターだけが見え、指定した工程を起動できることを確認します。`code-migration`・`depmap-adapter` スキルが `/` メニューに出ないこと、ワーカーが一覧に出ないことも確認します。
- **Local**：導入時に `--harness vscode-local` を指定し、VS Codeのチャットでも実行方式をLocalへ切り替えます。Copilot（Agent Host）と同じ入口の確認に加え、Local用hooksが実際に呼ばれることを確認します。導入時の `--harness` 指定だけではチャットの実行方式は変わりません。

Dynamic Workflowsは [専用の確認事項](DYNAMIC-WORKFLOWS.md) を追加してから試してください。

結果の記録例：CLI版、OS、Node版、モデルID、工程、単位数、ケース数、差分数、所要時間、実測できた利用量、未確認事項。未実測の費用やモデル名を推定値で埋めないでください。

## 人間ゲートとワーカーセッションの実機確認（未実施）

自動テストとloopbackでの確認は、プロンプトモードのワーカーまでです。次の項目は実機で確認し、結果をキット本体のリポジトリの `history/validation/copilot-cli-1.0.98-review-2026-10-18.json` の `liveChecks`（未実施は `null`）に記録してください。

- **対話CLI（信頼済みフォルダ）**：`node migration-kit/scripts/run_migration.mjs approve translation --note test` をAIに実行させます。確認が出ること、「No」で実行されないこと、「Yes」の後にCLI自身の許可確認がもう一度出るか（[copilot-cli#3042](https://github.com/github/copilot-cli/issues/3042)）を記録します（`liveCLIInteractiveAsk`）。
- **autopilot**：同じコマンドが確認なしに拒否されることを確認します（CLI 1.0.97以降の仕様、`liveCLIAutopilot`）。`--allow-all` / `--yolo` のときに確認が出るかも記録します（公式の記載なし、`liveCLIAllowAll`）。
- **autopilotでの質問**：autopilotで選択が必要な場面（例：失敗時の選択）を作ります。`ask_user` に自動の応答（利用者は不在なので自律的に進めるよう求める文面）が返ったとき、AIが何も選ばず、保留の判断を伝えて止まるかを記録します。応答の文面も残します（CLI 1.0.98の変更履歴ではautopilotが `ask_user` を自動処理、`liveCLIAutopilotAskUser`）。
- **VS Code**：LocalとCopilotの各実行方式で同じことを確認し（`liveVSCodeAsk`）、Copilot実行方式で `.github/hooks` が読み込まれるかを記録します（`liveVSCodeCopilotHarnessRepoHooks`）。権限レベル「Allow all」、Autopilot、`/yolo` のときに確認が出るか、拒否されるか、確認なしに通るかも記録します（`liveVSCodeAllowAll`）。通る場合は、ゲートのコマンドを実行する間は「Manual permissions」に戻すよう案内します。
- **未信頼フォルダのhook**：未信頼のコピー導入で `node tests/verify_cli_transport.mjs` を再実行し、ツール付きレビュアーでhookが効くこと（`migration/runs` を読めない）と、他のロールが動くことを記録します（`liveRepoHooksAssistedReviewersOnly`）。疑似モデルでの同じ確認は `doctor --check-cli` の `tool-assisted reviewer hook loads in prompt mode` が毎回行います。
- **sandbox**：VS Code・Copilot CLIのローカルsandbox（2026-10-07 GA。既定はオフ）を有効にした状態で `doctor --check-cli` と1単位の `translate` を実行し、端末から起動したワーカーCLIが `~/.copilot` への書き込みとCopilot APIへの通信を行えるかを記録します（`liveSandboxWorkers`）。失敗する場合はsandboxの許可設定を見直すか、runnerをsandbox外で実行する承認を利用者に求めます。sandboxを回避する設定をAIが勝手に変えてはいけません。

## VS Code orchestration checklist (pending live verification)

These checks require actual VS Code; offline fixtures do not establish UI behavior.

- Start via plugin skill, repository skill and Local prompt: user-facing parent
  shows all ten phases before long work; planning children return advice.
- Confirm actual exposed TODO tool/schema, response and rendered list separately.
  Preserve unrelated tasks, avoid duplicates; verify chat fallback on unavailable,
  failed or reported invisible TODO. Local children never use TODO/question tools.
- Drive the whole fixture from chat only: the agent checks/installs the Copilot CLI,
  starts `copilot login` and relays its code, proposes and runs `guardrails install`,
  and the host asks before every human-gate command (not for `models set` and `settings apply`, which record the person's choice). Nothing is typed by the person.
- During translate, confirm the background terminal and a responsive parent, slot
  refill, the reviewer cap and the CLI-reported models in the run summary.
- Invoke actual built-in Rubber Duck if exposed; record unavailable otherwise.
  Save adoption/rejection and actual fix/reverification references.
- Press VS Code Stop during implementation and between the two reviews. Inspect
  runner process, terminal and worker processes. If still active, Ctrl+C the runner;
  verify the lock release and that late results are rejected.
- Rerun translate: completed units reuse valid receipts, only missing reviews rerun,
  blocked/stopped status matches evidence. Confirm changed inputs require fresh approval.
- Walk source-only through judge, approval, reviewed implementation, actual build/smoke
  and handoff: no original invocation, no passed parity, final equivalence unverified.

Current repository automation does not claim these live checks have passed.
