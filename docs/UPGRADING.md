# 更新手順（0.18.0 と以前の版）

日本語 | [English](UPGRADING.en.md)

## 0.18.0（リポジトリの整理）

動作は変わりません。`scripts/` のファイル（プラグインでは版番号も）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力と survey の結果は保持されます。

1. 上流由来で、どの導入でも読み込まれていなかった `skill/SKILL.md` を削除しました。プラグインは `skills/`、コピー導入は `.github/skills/` を使います（変更なし）。
2. 開発時のレビュー・検証記録（`docs/plans/`・`docs/reviews/`・`docs/validation/`・`docs/REVIEW-FIXES.md`）を `history/` へ移しました。コピー導入では、導入先の `migration-kit/docs/` に残った古い記録フォルダーを削除してかまいません（キットは読みません。文書内の記録へのリンクは GitHub のリポジトリを指します）。

## 0.17.0（GitHub Copilot app 対応）

キットのファイル（plugin.json・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. プラグインの登録元を、手元のcheckoutから GitHub のリポジトリ（`umauma00/code-migration-kit-with-github-copilot#feat/github-copilot-migration-kit`）に変えられます。手元のcheckoutで登録したままでも動きます。登録を変える場合は、先に `copilot plugin marketplace remove code-migration-kit-marketplace --force` で外してから追加してください（同じ名前の登録が二重にならないようにするため）。
2. GitHub Copilot app で使う場合は [PLUGIN.md](PLUGIN.md#github-copilot-app) の手順で入れ、セッションは This computer・Current checkout で始めます。
3. コピー導入では `migration-kit/` 全体と、`.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.16.0（自動モードは工程の中でも止まらない・survey の部分を並列に）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力と survey の結果は保持されます。

1. 自動モードでは、準備監査やレビューの `changes` は1回直して再監査し、残りは報告と記録の note に載せて先へ進みます。ソースと RULEBOOK で決まらない選択は、いちばん保守的な案を `TODO(port)` 付きで残して進みます（inventory の survey を始める前は RULEBOOK、始めた後は変換結果だけ）。方針が決まっているなら autopilot の前に伝えてください。
2. survey は1つの範囲を分けた部分も `concurrency` の上限の中で並列に動きます。途中の survey はそのまま再開できます。
3. inventory の survey で `droppedFacts` がマイナスになる表示を直しました。以前の版で保存した結果はそのまま使い、マイナスは 0 として数えます。
4. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.15.0（初期設定で検証方式を決める・自動モードの引き継ぎ）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 元のコードが動かない案件では、初期設定の5問目で仕様書・テストの有無を聞き、無ければ 00 の前に source-as-spec へ切り替えます。初期設定が済んでいる既存の案件では何も変わりません（仕様の有無は `preferences --specification available|unavailable` で記録できます）。
2. 自動モードで初期設定の途中の案件は、`settings init` をやり直すと「まだ手動」の案内が付き、終わると 00 の前で止まって autopilot への切り替えを案内します。
3. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.14.0（最初の選択は質問で・設定ファイルは値だけ）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. `originalRuntime` が未記入なら、`settings init` が「移行元のプログラムを動かせるか」を質問で聞きます。ファイルを手で書く必要はありません。動かせない場合はファイルの `verificationMode` が `source-only` になります。
2. 移行元のフォルダーを判定できないときも質問で聞き、`settings init --source-roots` で記録します。
3. `source-spec init --apply` で source-as-spec に切り替えると、run-settings.json の `verificationMode` も `source-only` になります。
4. run-settings.json から `_help` と `_choices` がなくなり、説明と選択肢（使えるモデルなど）は `migration/run-settings.help.md` に移りました。既存のファイルは次の `settings init` で小さくなります（記入した値はそのまま）。
5. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.13.0（自動モード）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 何もしなければモードは変わりません。Copilot CLI の autopilot で通して動かすには、autopilot を始める前に対話セッションで `run_migration.mjs preferences --phase-mode auto` を実行するか、run-settings.json の `phaseMode` を `auto` にして `settings apply` します（どちらもホストが確認を求めます）。詳しくは[自動モード](ORDERED-WORKFLOW.md#auto-mode)。
2. `phaseMode` の選択肢に `auto` が加わりました。`settings init` をやり直すと説明と選択肢が更新されます。
3. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.12.0（緩和モード）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 何もしなければ普通モード（今までどおり）です。緩和モードにするには `run_migration.mjs preferences --phase-mode relaxed` を実行するか、run-settings.json の `phaseMode` を `relaxed` にして `settings apply` します。詳しくは[緩和モード](ORDERED-WORKFLOW.md#relaxed-mode)。
2. 0.11.0 で作った run-settings.json に `phaseMode` がなくても、そのまま `settings apply` できます（モードは変わりません）。`settings init` をやり直すと `originalRuntime` の次に `phaseMode` の欄が加わります。
3. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.11.0（実行設定ファイル）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。既存の `migration/config.json` は `settings apply` を実行するまで変わりません。既存の案件をファイル方式にするには `run_migration.mjs settings init` を実行します。現在の設定から `migration/run-settings.json` を作り、`status` が設定と一致しているかを表示します。`models set` と `preferences` は引き続き使えます。

## 0.10.0（途中停止の撲滅・契約メモの廃止）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力と、完了済みのsurvey scopeは保持されます。

1. survey は、1回の補正後も引用を確かめられない行を `uncited` 付きの UNKNOWN にして完了します。止まっていた scope は同じ `survey run` を再実行すれば最後まで進みます。件数は scope 記録と `survey merge` の結果の `uncited`・`droppedFacts` と、inventory の巨大ファイルは `unsurveyedOversizedFiles` で確認できます。
2. 異常終了で残った `migration/run.lock` は、同じホストなら次のコマンドが自動で外します。別ホスト（共有フォルダ）のロックだけは、その実行が止まったことを確認してから `unlock --pid` で外します。旧版が残したロックはホストを記録していないため、このホストでのPIDで判断します。
3. 新規導入の `maxReviewInputBytes` は 262144 です。既存の設定は変わりません。引き上げる場合は `migration/config.json` を書き換えます。設定の指紋に含まれるため、02以降の記録と承認は確認し直しになります。
4. source-as-spec の新規計画では契約メモ（`contracts.md`）を作りません。既存の計画はそのまま使えます（`TODO(spec)` の確認も従来どおり）。ソース一覧の方式に移る場合は `migration/judge-plan.json` を削除して `source-spec init --apply` をやり直し、00b〜02 を一括で確認し直します。
5. 01 の依存監査は、同梱の解析器なら `preparation_cli.mjs dependency-targets` で選んだ約10ファイルを1人が1回監査するだけになります（2人×20ファイル×最大3ラウンドは不要）。途中の案件も、次の監査からこの方法に切り替えられます。
6. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.8.0（コンテキストサイズの選択）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 担当ごとのコンテキストサイズを、モデル・エフォートと同じ1回の回答で選べます。長いコンテキストにする担当だけ、`models set --assign "reviewers=ID:high:long_context,..."` のように末尾に `:long_context` を付けます。対応するモデルは `models list` のコンテキスト列でわかります。
2. 付けない担当はこれまでどおり `--context` なしで起動します。既存の設定はそのまま使えます。

## 0.7.0（入口はオーケストレーターだけ）

オーケストレーターの定義が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 移行はエージェント一覧のオーケストレーター（コピー導入は `migration-orchestrator`、プラグインは `code-migration-plugin-orchestrator`。Copilot CLIでは `/agent`）から始めます。`/code-migration` は `/` メニューに出なくなりました。オーケストレーターが最初にスキルを読みます。
2. `code-migration`・`depmap-adapter` スキルは `user-invocable: false` です。AIは引き続き読み込めます。ほかのエージェントがスキルを読み込んでも、工程は始めずオーケストレーターへの切り替えを案内します。この案内はAIへの指示で、ホストが強制するものではありません。
3. VS Code Local用の `/migrate-…` prompt files（10個）を削除しました。コピー導入の案件に残る `.github/prompts/migrate-*.prompt.md` はinstallerが削除しません。オーケストレーターが残っているファイルを見つけると削除を提案し、同意を得てから削除します。
4. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の2つのSKILL.md、`.github/copilot-instructions.md` の管理ブロックを一時導入先の内容に手で置き換えます（管理ブロックの置き換えは0.3.0の手順6と同じです）。内容が違うファイルがあるとinstallerの再実行は上書きせず停止するためです。プラグインは更新だけで入ります。

## 0.6.1（0.6.0 のレビュー修正）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 時間・CPU・無出力で止める処理は追加していません。continuous のまま動きます。
2. `doctor` が、設定に書かれていても continuous では効かない上限（テンプレートの既定値と違う `maxAgentCalls`・`maxAiCreditsPerCall`・`maxRunInputBytes` など）を `execution limits` に表示します。効かせたい場合は `"executionMode": "bounded"` を設定し、不要なら削除してください。
3. build-loop でエラー数が3回続けて減らない場合、止まらずに `stalled` として記録し、status にルールブック修正の提案を表示します。
4. 退避したログのパスは相対パスで記録されます。0.6.0 の絶対パスの記録も同じ場所なら読めます。

## 0.6.0（継続実行と巨大survey）

依存解析の追加修正では、Python版はすべてdepmap_common.pyを使い、JS/TS版はdepmap_js_scan.mjsを読みます。source-specの生成コマンドは全8mapperの--source-rootとmake_manifest.pyの新しい--map-rootを使います。単一スクリプトだけでなくキット全体を更新し、既存の期待結果と未解決情報を確認して依存マップ・manifest・依存宣言を再生成してください。

キットの更新後はexecutionMode未指定の既存設定もcontinuousとして動作します。旧設定の600秒・呼び出し数・修正回数で中断しません。有限の上限を望む場合だけ利用者がboundedを選びます。巨大ソースは全survey種類で断片処理し、正常な既存scopeと断片を保持します。移行先にコピーしたキットは更新が必要です。停止条件・ログ保存・外部制約は [継続方針](INTERRUPTION-POLICY.md) を参照してください。

## 0.5.0（ワーカー統合を測るベンチマーク）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. `scripts/review_benchmark.mjs` を追加しました。レビュー2人と1人、fixer と implementer を、欠陥を埋め込んだ題材で比べます。手順は [REVIEW-BENCHMARK.md](REVIEW-BENCHMARK.md) です。キットのチェックアウトから実行し、移行先リポジトリでは使いません。
2. 翻訳ループの動作は変わりません。
3. 0.4.0 で追加された依存解析器の変更も含みます。0.3.2 以前から更新する場合は、次の 0.4.0 の手順も確認してください。

## 0.4.0（C#・Java・VB.NET・PHP・COBOL の依存解析器）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持され、再実行時はレビューだけが行われます。

1. 工程01の依存マップに、C#・Java・VB.NET・PHP・COBOL の同梱解析器が使えます（[依存解析器](DEPENDENCY-MAPPERS.md)）。これらの言語で自作のツール（`migration/tools/` など）を使っている案件は、同梱版の結果と比べてから切り替えてください。切り替えると依存マップと依存宣言が変わるため、工程01からの確認と承認をやり直します。
2. 新しい解析器は `unresolved.tsv` も出力します。工程01の報告で全件を確認してください。

## 0.3.2（00 で資格情報の疑い・guidance の読み違いで止まらない）

キットのファイル（lib）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持され、再実行時はレビューだけが行われます。まだ00の途中なら影響はありません。

1. `guidance --message` の出力は「渡されたメッセージへの対処」で始まり、guidance 自体は正常終了したと明記します。JSONには `explained: true` が付きます。
2. 資格情報の疑いを伝えるメッセージには専用の案内が出ます。キットは秘密情報の検査をせず、これで止まる段階はありません。`set /P` などのスイッチだけなら資格情報ではありません。値が含まれうるため、案内はそのメッセージを表示しません（JSON も同じ）。「検出されませんでした」などの問題なしの結果には質問のない案内が出ます。
3. prompts/00: 本物らしい行は読むのをやめ、ファイルと行番号だけを未確認として報告書に書きます。guidance には検査ツールの生の出力ではなく、値を含まない説明を渡します。
4. guardrails.json を書き換えるコマンドの判定で、PowerShell・cmd.exe の読み取りコマンド（`Test-Path`、`Get-ChildItem`、`Select-String`、`findstr` など）を読み取りとして扱います。拒否文には判定の理由になった語が出ます。

## 0.3.1（コマンド引数の検査・モデルの一括選択）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持され、再実行時はレビューだけが行われます。

1. runnerなどのスクリプトは、未知のオプション・値の抜け・余分な語・範囲外の値（工程ID、承認段階、`--format` など）をエラーにします。以前は黙って無視されていた書き方を自前のスクリプトで使っていた場合は、エラーが示す受け付けるオプションに合わせて直してください。`--opt=値` の形は使えず、`--opt 値` と書きます。どのコマンドでも `--help` / `-h` で使い方を表示します。
2. モデルとエフォートは1回の質問でまとめて選びます。記録は `models set --assign "implementer=ID:EFFORT,reviewers=ID:EFFORT,arbiter=ID,fixer=ID"` で、従来の `--role/--model/--effort` も使えます。

## 2026-10-19の更新（再開時の失効範囲、使用量、監査、parity修正）

キットのファイルが変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持され、再実行時はレビューだけが行われます（1単位2回）。この更新以降は、実行上限（`concurrency`・`maxAgentCalls` など）、文書・工程プロンプト・スキル・`.github/copilot-instructions.md` を変えても失効しません。

1. `doctor --check-cli` に、ツール付きレビューのhookを実CLIで確かめる項目が加わります（loopback、AI利用なし）。
2. 準備監査は `audit_inputs.mjs run --directory migration/audits/ID` でCLIワーカーとして実行できます。既存の未提出requestは設定のハッシュ方式が変わるため、freezeからやり直します。
3. `maxAiCreditsPerCall` は任意です。既存設定には追加しません。
4. 同じ日の追補（失敗時の選択肢、工程順の案内、質問とTODOの表示）も、キットのファイルを変えます。追補の前に再検証を済ませた案件は、もう一度だけ失効します（完了済みの出力は保持されます）。`doctor` は、phase 01を記録するまでは依存宣言がなくても失敗にしません。2人のレビュー担当が同じ行を指摘した場合も裁定を通すため、そうした単位では裁定の呼び出しが1回増えます。TODOでは、承認待ち・確認待ち・停止中の工程は `in-progress` ではなく `not-started`（状態はタイトルに表示）になります。

## 0.3.0（native方式の削除・チャットだけで完遂）

0.3.0ではVS Codeのサブエージェント方式（native）を削除しました。ワーカーは常にCopilot CLIで動きます。以下はすべてAIがチャットで提案し、同意を得て実行します。

1. `workerBackend: "native"`、`nativeHarness`、`nativeModelVerification`、`nativeInput` を含む設定は、移行方法を表示して停止します。`"workerBackend": "copilot-cli"` に直し、これらのキーを削除してから、judgeと翻訳の承認をやり直します。
2. コピー導入の案件に残る `.github/agents/migration-native-*.agent.md` は使われません。installerは削除しないので、AIが同意を得て削除します。
3. Copilot CLIが未導入、または未サインインの場合、AIが `npm install -g @github/copilot` と `copilot login` を実行します。利用者はブラウザでサインインを承認するだけです。
4. `migration/guardrails.json` は、AIが `guardrails show` を基に提案し、合意後に `guardrails install` で設置します。ホストが確認を求め、その許可が人間の設置行為になります。
5. 既存の設定には `fixPolicy`・`dependencyOrder`・`reviewFocus` を自動で追加しません。採用する場合は承認をやり直します。
6. `.github/copilot-instructions.md` の管理ブロックを短くしました（詳細はスキルにあります）。コピー導入で再インストールすると「Existing managed instructions differ」で止まるので、AIが同意を得て `<!-- code-migration-kit:start -->`〜`end` の間を新しい内容に置き換えます。ブロック外の利用者の記述は変えません。
7. ワーカーはセッションごとに動き（GitHubアカウントへの同期は利用者のCLI設定に従う）、IDを実行記録に残します。0.3.0より前のワーカーのセッションはIDが記録されていないため `sessions prune` の対象外です。GitHubアカウントに同期済みのものは、Copilot CLIの `/session` から整理してください。
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
詳細は[今回の対応表](../history/plans/2026-10-15-review-implementation.md)を参照してください。

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
