# 実アカウントでの小規模確認

日本語 | [English](LIVE-SMOKE.en.md)

自動テストはCopilot認証やAI呼び出しを行いません。この手順は、自分の環境で通常CLI経路を確認するためのものです。モデルの呼び出しはアカウントの GitHub AI Credits を使います。

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

VS Code と GitHub Copilot アプリでは、入口とhooksの実動作を別途確認してください。

- **VS Code（Copilot 実行方式・既定）**：エージェント一覧にオーケストレーターだけが見え、指定した工程を起動できることを確認します。`code-migration`・`depmap-adapter` スキルが `/` メニューに出ないこと、ワーカーが一覧に出ないことも確認します。Agents window では **Folder** 分離で同じ確認をします（**New Worktree** は常に Allow all で確認が出ないため使いません）。
- **VS Code（Local 実行方式）**：1.144 では Local は既定で表示されず、Agents window では使えません。使う場合はコピー導入で `--harness vscode-local` を指定し、チャットの実行方式も Local にします。入口の確認に加え、Local 用hooksが実際に呼ばれることを確認します。導入時の `--harness` 指定だけではチャットの実行方式は変わりません。
- **GitHub Copilot アプリ**：Environment **This computer**、Workspace **Current checkout**、ツールの許可 **Ask every time** または **Assisted** で、エージェント選択または `/agent` からオーケストレーターを選べること、人の判断のコマンドで確認が出ることを確認します。

Dynamic Workflowsは [専用の確認事項](DYNAMIC-WORKFLOWS.md) を追加してから試してください。

結果の記録例：CLI版、OS、Node版、モデルID、工程、単位数、ケース数、差分数、所要時間、実測できた利用量、未確認事項。未実測の費用やモデル名を推定値で埋めないでください。

## 人間ゲートとワーカーセッションの実機確認（未実施）

自動テストとloopbackでの確認は、プロンプトモードのワーカーまでです。次の項目は実機で確認し、結果は下の各項目の名前（例：`liveCLIInteractiveAsk`）を付けて、キット本体のリポジトリの Issue または PR に記録してください。未実施の項目は未実施と書きます。

- **対話CLI（信頼済みフォルダ）**：`node migration-kit/scripts/run_migration.mjs approve translation --note test` をAIに実行させます。確認が出ること、「No」で実行されないこと、「Yes」の後にCLI自身の許可確認がもう一度出るか（[copilot-cli#3042](https://github.com/github/copilot-cli/issues/3042)）を記録します（`liveCLIInteractiveAsk`）。
- **autopilot**：同じコマンドが確認なしに拒否されることを確認します（CLI 1.0.97以降の仕様、`liveCLIAutopilot`）。`--allow-all` / `--yolo` のときに確認が出るかも記録します（公式の記載なし、`liveCLIAllowAll`）。
- **autopilotでの質問**：autopilotで選択が必要な場面（例：失敗時の選択）を作ります。`ask_user` に自動の応答（利用者は不在なので自律的に進めるよう求める文面）が返ったとき、AIが何も選ばず、保留の判断を伝えて止まるかを記録します。応答の文面も残します（CLI 1.0.98の変更履歴ではautopilotが `ask_user` を自動処理、`liveCLIAutopilotAskUser`）。
- **VS Code**：Copilot 実行方式（使う場合は Local も）で同じことを確認し（`liveVSCodeAsk`）、Copilot実行方式で `.github/hooks` が読み込まれるかを記録します（`liveVSCodeCopilotHarnessRepoHooks`）。権限レベル「Allow all」、Autopilot、`/yolo`、Agents window の New Worktree のときに確認が出るか、拒否されるか、確認なしに通るかも記録します（`liveVSCodeAllowAll`）。通る場合は、ゲートのコマンドを実行する間は「Manual permissions」に戻すよう案内します。
- **未信頼フォルダのhook**：未信頼のコピー導入で `node tests/verify_cli_transport.mjs` を再実行し、ツール付きレビュアーでhookが効くこと（`migration/runs` を読めない）と、他のロールが動くことを記録します（`liveRepoHooksAssistedReviewersOnly`）。疑似モデルでの同じ確認は `doctor --check-cli` の `tool-assisted reviewer hook loads in prompt mode` が毎回行います。
- **sandbox**：VS Code・Copilot CLIのローカルsandbox（2026-10-07 GA。既定はオフ）を有効にした状態で `doctor --check-cli` と1単位の `translate` を実行し、端末から起動したワーカーCLIが `~/.copilot`（`workerCopilotHome: "separate"` では作業用ホーム `~/.copilot-migration-kit-workers` も。どちらで動くかは `doctor --check-cli` の `worker Copilot CLI home` に表示）への書き込みとCopilot APIへの通信を行えるかを記録します（`liveSandboxWorkers`）。失敗する場合はsandboxの許可設定を見直すか、runnerをsandbox外で実行する承認を利用者に求めます。sandboxを回避する設定をAIが勝手に変えてはいけません。

## チャットだけで最後まで進める確認（未実施）

画面の動きは自動テストでは確かめられないため、VS Code または Copilot アプリの実機で確認します。

- 小さな検証用リポジトリを、チャットだけで最後まで進めます。AIがCopilot CLIの有無を確かめて導入し、`copilot login` を始めてコードを伝え、禁止リストを提案して `guardrails install` を実行すること、人の判断のコマンドの前に毎回確認が出ること（`models set`・`settings apply` は人の選んだ内容の記録なので出ません）を確認します。人がコマンドを打つ場面がないことも確認します。
- 最初の設定の質問（モデル・移行先・進め方・元のプログラムを動かせるか・仕様の有無）が `ask_user` で出て、答えが `migration/run-settings.json` に入ることを確認します。
- 長い処理の前に10工程の一覧と進み具合が見えること、長い処理（translate など）の間も進み具合が表示され、チャットが応答することを確認します。
- translate の実行中に、空いた枠に次の単位が入ること、レビュー担当の同時数の上限、実行の要約にCLIが報告したモデルが出ることを確認します。
- 実装中と2つのレビューの間でチャットの停止ボタンを押し、ランナーとワーカーのプロセスが残るかを確かめます。残る場合はランナーを止め、ロックが外れること、遅れて届いた結果が採用されないことを確認します。
- translate を再実行し、完了した単位は有効な記録を再利用し、足りないレビューだけを再実行すること、入力を変えたら承認がやり直しになることを確認します。
- source-only では、元のプログラムを一度も起動せずに比較器・承認・レビュー付きの実装・実際の build/smoke・引き継ぎまで進み、parity が合格扱いにならず、最終的な同等性が未検証と書かれることを確認します。

このリポジトリの自動テストは、これらの実機確認が済んだとは主張しません。
