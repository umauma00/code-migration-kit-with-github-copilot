# 0.1.3 Astraレビューの検討と修正

2026-10-08。Astraが0.1.2に指摘した2件は、親エージェントも実コンパイラで独立再現し、いずれもP2として妥当と判断しました。A1はREADMEの直接入力の追跡契約を破り、A2はREADMEが要求する別ディレクトリへの生成物出力で正常なbuildを停止させます。

| 指摘 | 独立再現した修正前の動作 | 変更と回帰検証 |
|---|---|---|
| A1 `-c` の後の入力追跡漏れ | `cc -c native/shim.c -o /dev/null` が成功した後、補助ソースを不正なCにしてもcontextHashが同じ。古いbuildを前提にsmokeを承認・実行できる。コンパイルを実際にやり直すと終了1 | インラインコードの除外を認識した実行ツール・オプション・エントリポイント前に限定。cc/nodeの `-c FILE` と未知ツールの入力は追跡。変更で完了記録と後続承認を無効化し、既存のインラインコードと長い引数は維持 |
| A2 生成物を入力へ追加 | `cc -c native/shim.c -o artifacts/shim.o` は終了0だが、生成したオブジェクトが検証入力へ追加され、工程全体は入力変更エラーで失敗 | `buildArtifactRoots` に生成物のディレクトリを明示し、存在の有無にかかわらず入力一覧から除外。初回・clean buildが成功し、本当の入力を実行中に変えた場合は引き続き失敗 |

A1のsmoke再現には固定の成功コマンドを使っています。実案件のsmoke/parityが不整合を検出する可能性はありますが、それでも入力変更時に古いbuildを失効させる契約は破られています。A2は誤った成功を許可する問題ではなく、正常な実行を止める問題です。

言語を問わず使うため、未知のツールの `-o` を一律に出力オプションと解釈する修正は採用していません。出力先を直接引数に渡す利用者は、実行前に `"buildArtifactRoots": ["artifacts"]` 等を設定します。省略時は空配列で、旧設定の読み込みは維持します。生成物の内容は承認ハッシュの対象外なので、各検証コマンドで検査してください。元ソース・検証ルート・変換後ソース・明示入力・管理領域との重複は拒否します。

`tests/astra-regressions.test.mjs` に8件追加しました。同じ8件を修正前0.1.2で実行すると6件が失敗し、修正後は8件すべて成功しました。コンパイラなしでも自動テストは実行できます。実際のCコンパイラによる確認は別途行い、結果を [検証記録](TESTING.md) に記載しています。

## 0.1.2 再レビュー指摘への対応

2026-10-08。0.1.1の再レビューで再現した3件を修正しました。

| 指摘 | 変更 | 回帰検証 |
|---|---|---|
| RR1 migration内の検証入力 | 直接指定したコマンドファイルと明示入力をmigration内でも追跡。自動生成するstate/results/gates/runs/run.lockとの混在は拒否 | migration/build.mjsの変更で古いbuild承認とsmoke承認を拒否。migration内の追加設定も変更検出。生成領域の指定は実行前に拒否 |
| RR2 明示した変換先の追跡 | 出力ルートの走査に加え、manifestの全変換先をハッシュへ追加 | node_modules、__pycache__、.git配下の明示出力を検証コマンドが変更すると、終了0でも工程結果は失敗 |
| RR3 文字コード | 生バイトをUTF-8として厳密に検査してから固定入力を作成。repairの診断にも同じ検査を適用。非対応ファイルは名前を示して停止 | Latin-1のPythonソースでレビューを呼び出さずblockedになる。非UTF-8の診断も拒否。正しいUTF-8の日本語・絵文字・BOM・実際の置換文字は保持 |

`tests/rereview-regressions.test.mjs` に7件追加しました。0.1.1の42件と合わせた結果は [TESTING.md](TESTING.md) と [TAP](validation/automated-tests.tap) を参照してください。変換先の除外ディレクトリ3種と生成領域5種は、それぞれのテスト内で確認しています。

本版はUTF-8以外の文字コードを自動変換しません。元案件で文字コードを変える場合は、言語のencoding宣言と文字列の意味を確認して元テストを再実行してください。既存導入では [UPGRADING.md](UPGRADING.md) に従い、承認とレビューを取り直します。

実Copilot、IDE、SDKの実セッションは引き続き未検証です。この修正は入力検査・工程記録のローカルな正しさを対象としています。

## 0.1.1 レビュー指摘への対応

2026-10-08。0.1.0のレビューで再現した7件を修正し、hook出力契約の指摘C1にも対応しました。

| 指摘 | 変更 | 回帰検証 |
|---|---|---|
| R1 入力追跡 | manifestの全元ファイル、主要なルート設定、コマンドに指定したファイル、明示したverificationInputsをハッシュへ追加 | 除外ディレクトリ内の元ファイル、build.mjs、package.json、追加設定の変更で完了・承認が無効になる |
| R2 工程結果 | 再実行開始時に下流結果と承認を失効。結果・承認を前工程の実行IDに結び付け、前提の連鎖を検査 | build失敗後・成功した再実行後の両方で古いsmokeを再利用できない。古いJSONを戻しても拒否 |
| R3 プロセス終了 | 親のcloseが発生してもPOSIXグループのSIGKILLを取り消さず、終了処理が済むまで呼び出しを返さない | SIGTERMを無視する子孫がタイムアウト処理完了後にheartbeatを書かない |
| R4 レビュー分離 | 元ソース、候補、ルール、inventory、任意の診断を固定して両担当へ渡す。CLI/SDK両方でレビュー用toolsを空にする | 他レビューの識別文字列が入力に入らない。同じ入力で再開。読み取りを有効化したプロファイルは拒否 |
| R5 パス検査 | 各出力の全祖先を出力集合と照合 | a、a-b、a/bの並びでも開始前に衝突を検出 |
| R6 診断記録 | 実行前に試行を記録。失敗・中断・タイムアウト・不正JSONでも時刻と出力を保存 | タイムアウトのstderrと実行コマンド、不正JSONの生出力、要求モデルを保存 |
| R7 導入パッケージ | 配布元のtest/demoと、導入先のcheckを分ける。テスト0件は失敗にする | 導入先のdoctor実行と、空テストディレクトリが終了0にならないことを確認 |
| C1 hook形式 | 入力キーの形式によるharness推測を廃止。Local形式にはCLI用トップレベル判断も含める | snake_case入力、CLI形式、Local形式の出力契約を確認 |

回帰テストは `tests/review-regressions.test.mjs` にあります。既存27件に15件を追加しました。一括実行結果は [TESTING.md](TESTING.md) と [TAP](validation/automated-tests.tap) を参照してください。

工程結果は最新の記録を維持する方式です。イベントソーシング等の新しい基盤は導入していません。再実行で失効した工程結果には理由と時刻が残ります。

レビュー担当は64 KiBを既定上限とする固定JSON入力を使います。省略して合格することを避けるため、上限超過では停止します。CLIへは標準入力で渡すので、プロンプトを巨大なコマンド引数にしません。別の変換後ファイルはレビュー入力へ含めず、統合時の整合性はbuild/smoke/parityで確認します。

`verificationInputs` は任意の追加設定です。既存設定でも動きますが、ビルドから間接的に読む設定、入れ子のpackage.json等は利用者が登録します。ツールチェーン・環境変数・外部サービスの状態まで自動追跡するものではありません。`doctor` は追跡ファイルの一覧と不足した明示ファイルを確認できます。

POSIXでは同じプロセスグループ内の終了を検証しました。Windows向けにはtaskkill /T /Fを使いますが、Windows実機では未検証です。意図的に別グループで常駐するプロセスは対象外なので、検証コマンドはdaemon化しないでください。

実Copilotモデル、VS Code UI、SDKの実セッションとhookの実消費側は引き続き未検証です。C1は出力の修正と契約テストまでで、実機互換性の保証ではありません。[LIVE-SMOKE.md](LIVE-SMOKE.md) に確認手順があります。

参照した一次資料：
- [Custom agentsのtools設定](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [Copilot CLIのプログラム実行](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- [CLI hooks](https://docs.github.com/en/copilot/reference/hooks-reference)
- [VS Code hooks](https://code.visualstudio.com/docs/agent-customization/hooks)
- [Windows taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
