# Astraによる今回の変更全体のレビュー

レビュー担当は `gpt-6-astra`。対象は `feat/github-copilot-migration-kit` の0.5.0基点（`0e3c71b`）からの作業ツリー差分と新規ファイル。
言語別依存解析だけでなく、大容量surveyの分割・復旧、continuous実行と停止条件、ログ退避、adapter、進捗、inventory候補と正式gate、生成コマンド、配布指示・文書・索引・テストを確認した。
モデル選択の初期context機能は旧checkoutに保存された別の差分で、以前のAstraレビュー対象。今回の現checkoutには移植していない。

初回レビューで6件のP2を再現・確認し、親側が修正した。既定のcontinuous実行を時間やCPU負荷で止める変更はしていない。

修正後のAstra再レビューで6件すべての解消と追加の確定指摘がないことを確認した。補足されたworker版のversion確認も、continuousでは無期限、bounded時だけ明示のcommand timeoutを適用するよう揃え、同じadapterでモードを切り替える回帰テストを追加した。最後の変更もAstraが再確認した。

| 指摘 | 修正前の影響 | 修正・回帰検証 |
|---|---|---|
| JSX後のimport欠落 | `</div>` をregexの開始と誤認し、同じ行のimport/requireを隠す | JSXタグ・本文を区別し、式は走査。閉じタグ後のimport・JSX式・template式・本物のregex・TS型assertionを実mapperで検証 |
| 対象外の同名型が混入 | 複数rootの共通親にある未選択ファイルから偽の辺を作り、依存宣言の生成が失敗 | 全8mapperにrepeatable `--source-root` を追加し、索引前に対象ソースを選択。build metadataの探索は保持。8言語の生成コマンドに未選択の同名ファイルを加えて確認 |
| doctorへ明示中断が届かない | timeout撤去後、SIGINTを親が受けても子CLIが応答待ちのまま残る | 全プローブへAbortSignalを伝え、キャンセル時は後続を起動しない。version・agent解決・hookの実プロセスと、実mainへ送るSIGINTで検証 |
| 不正応答がsurvey補正を迂回 | adapterが先にschema等を拒否し、拒否回答の保存・1回補正へ届かない | adapterのモデルJSON/schema不正をsurveyへ渡し、元回答を保存して1回補正。schema/targetが違う項目は採用しない。CLI doubleのitems・schema・target・JSON不正で確認 |
| 残高不足を無期限に再試行 | quotaと429の両方を含む失敗がtransient扱いになり、原因を返さない | systemic分類をretryより優先。continuousでもquota+429は1回で報告。一時障害の待機・再試行は維持 |
| 終了処理ログの欠落 | cancel/timeout後のstdout/stderrを捨て、cleanup失敗等の証跡を失う | 子のcloseまで出力を収集。ログI/O失敗時だけ収集を止める。SIGTERM handlerからの両ストリーム出力とspool全bytesを確認 |

## 検証

- 修正後の重点6ファイル80件は全件成功。`tests/astra-full-review.test.mjs` の新9件は実CLI double・実子プロセスを使用し、上記のadapter/doctor/ログ経路を確認した。
- 追加のbounded/continuous version確認切替テストも成功。Astra独自のJSX/template入れ子6パターンも成功した。
- 最終 `npm test` は435件中433成功、失敗0、skip 2（Windows専用）。`npm run demo` はcontinuousでbuild・smoke・parity成功、比較12件・差分0・skip 0。
- `git diff --check` 成功。元のfixture期待出力は変更なし。停止候補の索引は70ファイル・795行で現在のコードと一致。通常のループ脱出も含むため、795個の停止原因を表す数ではない。
- 初回レビューでは上記以外に根拠を示せる実害のある回帰は確認されなかった。これは静的解析や全環境での無エラーを保証するものではない。

## 適用範囲

モデル応答はテストダブル。認証済みモデル、画像の実プロジェクト、Windows実機・PowerShellは未検証。
SIGINT/SIGTERM handlerの試験はPOSIX用。WindowsのcancelはAPIからtaskkill経路を使うが、実機結果とは区別する。
fixtureの期待出力は変更していない。キットの保守作業だけで、移行工程の承認・正式inventoryをこのレビューが代行することはない。
