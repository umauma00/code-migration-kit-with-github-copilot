# 0.1.0 / 0.1.1 / 0.1.2から0.1.3への更新

新規導入はREADMEの手順を使います。既存の導入先に0.1.3のinstallerを実行すると、内容が違うファイルは上書きせず停止します。これは意図した動作です。

既に案件へ導入している場合は、作業をコミットまたはバックアップしてから、次の差分を確認して取り込んでください。配布ZIPにはキット本体用の `changes-from-0.1.0.patch`、`changes-from-0.1.1.patch`、`changes-from-0.1.2.patch` も含めています。このpatchは導入先のパスへ直接適用するものではありません。

1. 0.1.3を別の場所へ展開し、空の一時プロジェクトへREADMEのinstallerで導入します。元の導入と同じ `--harness`、必要なら `--with-workflow` を使います。`MODEL_ID` は自分の値を指定します。
2. 一時プロジェクトの `migration-kit/` を既存導入の同ディレクトリと比較し、独自変更を確認して更新します。新しいlib/review.mjsも含めてください。
3. `.github/agents/migration-reviewer-*.agent.md` は `tools: []` と固定入力用の指示へ更新します。その他の管理対象ファイルも一時導入先と比較します。既存のチーム向けCopilot指示は保持し、キットの管理ブロックを更新してください。
4. 既存の `migration/config.json`、RULEBOOK、inventory、manifest、移行したソースと記録は保持します。`verificationInputs` を設定し、必要なら `maxReviewInputBytes` を調整します。省略時はそれぞれ空配列、65536 bytesです。
   - 0.1.2ではmigration内のスクリプトと追加設定も追跡できます。state/results/gates/runs/run.lockをコマンドで直接指定したりverificationInputsへ登録していた場合は、スクリプト・設定を生成領域外へ移してください。
   - 0.1.3では `cc -c FILE`、`node -c FILE` 等の直接入力も追跡します。コマンドで出力ファイルを直接指定する場合は、そのディレクトリを `buildArtifactRoots` へ追加します。例：`cc -c native/shim.c -o artifacts/shim.o` なら `["artifacts"]`。省略時は `[]` です。元ソース・テスト・変換後ソース・明示入力・管理領域と重なる指定は拒否します。生成物に実際の入力を混在させず、内容の検証は各コマンドで行います。
   - 固定レビュー入力はUTF-8に限定します。非UTF-8の元ソース等がある場合、文字コードと意味を確認して対応方針を決めてください。未対応のまま文字化けしたレビューへ進めることはできません。
5. 対象プロジェクトのルートで `node migration-kit/scripts/run_migration.mjs doctor --check-cli` を実行します。追跡ファイルの一覧、モデル、レビュー用プロファイルを確認します。`migration-kit/` からは `npm run check` も使えます。
6. 入力・実行コードのハッシュとレビュー契約が変わるため、古い承認・完了記録を再利用しません。judgeを実行し、成果物を確認してtranslationを再承認・実行します。既存の候補ファイルは再レビューから始めます。その後build、smoke、parityを順に確認・承認・実行します。

記録や承認JSONのハッシュを手動で書き換えて継続しないでください。既存の記録は調査用に残せます。
