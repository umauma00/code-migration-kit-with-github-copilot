# 0.1.0〜0.1.4から0.1.5への更新

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
