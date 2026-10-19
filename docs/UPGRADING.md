# 更新手順（0.3.0 と以前の版）

日本語 | [English](UPGRADING.en.md)

## 2026-10-19の更新（再開時の失効範囲、使用量、監査、parity修正）

キットのファイルが変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持され、再実行時はレビューだけが行われます（1単位2回）。この更新以降は、実行上限（`concurrency`・`maxAgentCalls` など）、文書・工程プロンプト・スキル・`.github/copilot-instructions.md` を変えても失効しません。

1. `doctor --check-cli` に、ツール付きレビューのhookを実CLIで確かめる項目が加わります（loopback、AI利用なし）。
2. 準備監査は `audit_inputs.mjs run --directory migration/audits/ID` でCLIワーカーとして実行できます。既存の未提出requestは設定のハッシュ方式が変わるため、freezeからやり直します。
3. `maxAiCreditsPerCall` は任意です。既存設定には追加しません。

## 0.3.0（native方式の削除・チャットだけで完遂）

0.3.0ではVS Codeのサブエージェント方式（native）を削除しました。ワーカーは常にCopilot CLIで動きます。以下はすべてAIがチャットで提案し、同意を得て実行します。

1. `workerBackend: "native"`、`nativeHarness`、`nativeModelVerification`、`nativeInput` を含む設定は、移行方法を表示して停止します。`"workerBackend": "copilot-cli"` に直し、これらのキーを削除してから、judgeと翻訳の承認をやり直します。
2. コピー導入の案件に残る `.github/agents/migration-native-*.agent.md` は使われません。installerは削除しないので、AIが同意を得て削除します。
3. Copilot CLIが未導入、または未サインインの場合、AIが `npm install -g @github/copilot` と `copilot login` を実行します。利用者はブラウザでサインインを承認するだけです。
4. `migration/guardrails.json` は、AIが `guardrails show` を基に提案し、合意後に `guardrails install` で設置します。ホストが確認を求め、その許可が人間の設置行為になります。
5. 既存の設定には `fixPolicy`・`dependencyOrder`・`reviewFocus` を自動で追加しません。採用する場合は承認をやり直します。
6. `.github/copilot-instructions.md` の管理ブロックを短くしました（詳細はスキルにあります）。コピー導入で再インストールすると「Existing managed instructions differ」で止まるので、AIが同意を得て `<!-- code-migration-kit:start -->`〜`end` の間を新しい内容に置き換えます。ブロック外の利用者の記述は変えません。
7. ワーカーはローカル専用（`--no-remote-export`）の名前付きセッションで動き、IDを実行記録に残します。0.3.0より前のワーカーのセッションはIDが記録されていないため `sessions prune` の対象外です。GitHubアカウントに同期済みのものは、Copilot CLIの `/session` から整理してください。
8. ビルド修正の反復は、合意のうえで `build-loop` 1回の許可にまとめられます。

## 2026-10-17の更新（CLI版の追従・ガードレール・ツール付きレビュー・診断・言語）

既存の承認・完了記録は、キットのファイルが変わるため失効します。judgeから再検証してください。

1. ワーカーは `--no-auto-update` を付けずに起動し、普段使っているCLIの版で動きます。実行中に版が変わると警告し、runの `cliVersions` と `warnings` に残します。`doctor --check-cli` で全担当IDが解決できることを確認してください。
2. コピー導入では、新しいプロファイル `.github/agents/migration-reviewer-semantics-read.agent.md` と `migration-reviewer-rules-read.agent.md` を一時導入先から取り込みます（ツール付きレビュー用）。プラグインは更新だけで入ります。
3. 03・04の開始には `migration/guardrails.json` が必要です。`templates/guardrails.json` をコピーし、対象のビルド・テストコマンドに合わせて編集してください（エージェントは作成しません）。0.3.0以降は、AIが `guardrails show` で提案し、合意後に `guardrails install`（ホストが確認を求める）で設置します。コピー導入ではCopilot CLIでフォルダを信頼済みにしてください。
4. ビルド失敗時は `repair-round` で診断・修正キュー・修正をまとめて実行できます。
5. 報告の言語は `run_migration.mjs preferences --language ja|en` で設定します。設定は `migration/preferences.json` に保存され、承認には影響しません。
6. VS Codeでもnative方式ではなく、既定のCLIワーカー方式を使ってください。native方式は実験的です。

## 2026-10-15のレビュー反映

既存configを保持します。markerPolicy、phaseModels、designInputs、packageMapは
既存案件へ自動追加しません。新規テンプレートはtodo-lines-v1を選びます。
既存案件で採用する場合はRULEBOOKの件数規則を確認し、設定変更後にjudge/承認を取り直します。
batch指定のない既存translation gateは全manifestとして扱い、古いreceiptのpurpose省略はproductionです。
新しい00b記録はjudge入力にも結び付きます。runtime更新で既存の承認/完了は失効するため再検証します。
native doctorは実host能力をunknownとして非ゼロ終了する仕様へ変更しています。
inventory-merge.jsonは生成receiptとして予約し、保護入力への登録を拒否します。
衝突する既存の入力は別のパスへ移して設定を更新してください。自動上書きはしません。
repair queueは全jobのjournalとレビューbindingを保持します。中断後はtranslateで再開し、
未着手jobを含む全診断のレビュー完了までbuild承認は通りません。
詳細は[今回の対応表](plans/2026-10-15-review-implementation.md)を参照してください。

新規導入はREADMEの手順を使います。既存の導入先に0.1.5のinstallerを実行すると、内容が違うファイルは上書きせず停止します。これは意図した動作です。

既に案件へ導入している場合は、作業をコミットまたはバックアップしてから、次の差分を確認して取り込んでください。旧配布物のpatchは0.1.5の差分を含みません。一時導入先との比較で更新してください。

1. 0.1.5を別の場所へ展開し、空の一時プロジェクトへREADMEのinstallerで導入します。元の導入と同じ `--harness`、必要なら `--with-workflow` を使います。`MODEL_ID` は自分の値を指定します。
2. 一時プロジェクトの `migration-kit/` を既存導入の同ディレクトリと比較し、独自変更を確認して更新します。lib/core.mjs、review.mjs、text.mjs、pipeline.mjs、workflow.mjs、scripts/copilot_adapter.mjs、run_migration.mjs、make_review_dependencies.mjsを含めてください。
3. `.github/agents/migration-reviewer-*.agent.md` は `tools: []`、implementer/fixer/arbiterは `tools: ["view", "grep", "glob"]` へ更新します。CLIでsearch aliasが検索ツールを落とすため、旧read/search表記は拒否します。orchestratorは既存のaliasを維持します。その他の管理対象ファイルも一時導入先と比較し、チーム向けCopilot指示は保持してください。
4. 既存の `migration/config.json`、RULEBOOK、inventory、manifest、移行したソースと記録は保持します。`verificationInputs` を設定し、必要なら `maxReviewInputBytes` を調整します。省略時はそれぞれ空配列、65536 bytesです。
   - 0.1.2ではmigration内のスクリプトと追加設定も追跡できます。state/results/gates/runs/run.lockをコマンドで直接指定したりverificationInputsへ登録していた場合は、スクリプト・設定を生成領域外へ移してください。
   - 0.1.3では `cc -c FILE`、`node -c FILE` 等の直接入力も追跡します。コマンドで出力ファイルを直接指定する場合は、そのディレクトリを `buildArtifactRoots` へ追加します。例：`cc -c native/shim.c -o artifacts/shim.o` なら `["artifacts"]`。省略時は `[]` です。元ソース・テスト・変換後ソース・明示入力・管理領域と重なる指定は拒否します。生成物に実際の入力を混在させず、内容の検証は各コマンドで行います。
   - 固定レビュー入力はUTF-8に限定します。非UTF-8の元ソース等がある場合、文字コードと意味を確認して対応方針を決めてください。未対応のまま文字化けしたレビューへ進めることはできません。
   - 0.1.4以降では監査した依存宣言が必須です。README/phase 01の生成器で `migration/review-dependencies.json` を作り、解析器の対応範囲・未解決import・inventoryの意味上の参照を監査します。別パスは `reviewDependencyMap` に指定します。独立ファイルにも `[]` を明示してください。省略した設定キーは既定パスを選びますが、成果物の欠落はエラーです。inventoryの先頭列はテンプレートどおり `file` とし、パスをリポジトリ相対へ統一します。先頭BOM付きのコメント・空行・ヘッダーを受け付けます。
   - 0.1.5では解析器の `--root` を生成器の `--depmap-root` に指定できます。リポジトリルートで解析した `pkg/...` の辺には `--source-root pkg --depmap-root .` を使います。複数ソースルートは `--source-roots pkg,shared --depmap-root .` とし、config.sourceRootsも合わせます。対象外から始まる辺は `ignoredEdges` として報告されます。対象から範囲外へ出る依存は停止するため、必要なソースルートを追加してください。
   - 全CLIワーカーが `--no-custom-instructions` を必須指定します。AGENTSや個人指示から適用していた移植方針はRULEBOOK/inventoryへ取り込み、レビュー・再承認してください。doctorでCLIが必須フラグに対応していることを確認します。指定した役割プロファイルは引き続き読み込みます。
   - workflowを導入している場合はlib/workflow.mjsも更新します。工程の登録はSDKを使い、ワーカーは通常CLIと同じアダプターを使います。旧ctx.agentのdurable result/schema retryは使わず、ランナーの記録から再開します。任意のCLI実行ファイルはworkflow argsの `copilot` に指定できます。
   - CLI通信は `--output-format json` を使うJSONLへ変わります。CLIをdoctorで確認し、旧テキストstdoutの保存結果を新しい完了応答として再利用しないでください。
5. 対象プロジェクトのルートで `node migration-kit/scripts/run_migration.mjs doctor --check-cli` を実行します。追跡ファイルの一覧、モデル、レビュー用プロファイルを確認します。`migration-kit/` からは `npm run check` も使えます。
6. 入力・実行コードのハッシュとレビュー契約が変わるため、古い承認・完了記録を再利用しません。judgeを実行し、成果物を確認してtranslationを再承認・実行します。既存の候補ファイルは再レビューから始めます。その後build、smoke、parityを順に確認・承認・実行します。

記録や承認JSONのハッシュを手動で書き換えて継続しないでください。既存の記録は調査用に残せます。
