# 処理を途中で打ち切らないための実装と停止条件

日本語 | [English](INTERRUPTION-POLICY.en.md)

通常実行は `executionMode: "continuous"` です。設定を持たない既存プロジェクトも同じです。
古い設定に `timeoutSeconds: 600` や `maxAgentCalls: 100` が残っていても適用しません。
CPU使用率、無出力、経過時間、呼び出し数、修正回数、入力累計、ログ量だけでは処理を終了しません。
一時的な通信障害は待って再試行し、既存プロセスが実行中ならそのプロセスを待ちます。

上限を必要とする場合だけ、利用者が `executionMode: "bounded"` を選ぶか、コマンドに
`--max-calls N` / `--max-rounds N` を明示します。エージェントが独断で有限の上限を追加してはいけません。
`concurrency` と1入力のモデル容量は引き続き守ります。これらは仕事を分割・順番待ちさせるための制約です。

## 打ち切りを撤廃・回避した条件

| 条件 | 通常実行での処理 | 実装 |
|---|---|---|
| CPU 100%が継続、CPUが低い、無出力 | 終了・再起動しない。CPUによる自動終了コードはなく、親の指示にも中断禁止を明記 | 全ハーネスのskill・orchestrator・工程引継ぎ |
| 1ワーカー600秒、ビルド・比較600秒 | 自動終了しない。既存の正数設定も通常モードでは無効。低水準APIの `timeoutMs: 0` はタイマーを作らない | `execution-policy.mjs`, `process.mjs`, `copilot_adapter.mjs`, `pipeline.mjs` |
| モデル一覧・バージョン確認・doctorの20/30/60秒 | 暗黙の時間切れを撤廃。応答を待つ。doctorの各プローブにも利用者の明示キャンセルを伝え、後続プローブは開始しない | `models.mjs`, CLIとadapterの診断 |
| 子プロセスstdout+stderrが16MiB超 | 終了せず全出力をログファイルへ退避。メモリには末尾だけ保持。モデルJSONLと診断パーサーは全ログを順に読む | `process.mjs`, `copilot_adapter.mjs`, `diagnostics.mjs`, `diagnostic_queue.mjs` |
| surveyのファイル集合・censusが入力上限超 | ファイル・箇所の集合を分割。scope IDと既存結果を維持 | `survey-parts.mjs` |
| surveyの単一ファイル本文が入力上限超 | facts・contractsは行範囲に分割（1行自体が巨大でも文字位置で分割し、Unicodeのペアを切らない。入力は実際のJSON化後bytesで検査）。inventoryは、RULEBOOKと1箇所と一緒に1回の入力に収まらないファイルについて、モデルを呼ばずに全箇所をUNKNOWN / TODO(port)で記録し、`unsurveyedOversizedFiles` に残す（2万行・1,000箇所の1ファイルで148回の呼び出しが同じUNKNOWNに結合されていた） | `survey-parts.mjs`, `survey.mjs` |
| 01の依存監査（2人×20ファイル、最大3ラウンドで停止） | 同梱・fixture検証済みの解析器では、`dependency-targets` が選ぶ約10ファイルを1人が1回監査する。見落としは直して同じファイルで比べ直す。残った未解決は report.md に書いて止めない（手書きのグラフも3ラウンド後は止めずに報告） | `preparation.mjs`, `PREPARATION-AUDITS.md`, 01の指示 |
| 入力上限の既定64KB | 新規導入の既定を1 MiB（1048576 bytes）に引き上げ、断片化そのものを減らす。既存設定の値は変えない（設定の指紋に含まれるため） | `templates/migration-config.json` |
| 大きい本文に大量のcensus箇所 | 入力容量を本文と箇所に配分し、全箇所で全断片を維持しながら同一断片の重複送信を減らす | `survey-parts.mjs` |
| 巨大ファイルの途中で手動中断・外部障害 | 検証済み断片を入力ハッシュ付きで保存。再開時に同じ断片を呼び直さない。全断片が揃うまでファイル・scopeは未完了 | `survey.mjs`の `.parts/` 記録 |
| 100呼び出し、2修正回、入力累計予算、1呼び出しAI Credits上限 | 通常モードでは打ち切り条件にしない。利用量は記録。CLIへ `--max-ai-credits` を渡さない。テンプレートの既定値と異なる値が設定に書かれていれば、doctor の `execution limits` と実行結果の `ignoredLimits` で「適用されていない」と表示する（停止はしない） | `execution-policy.mjs`, `run_migration.mjs` |
| 一時障害の既定2回リトライ | 通常モードでは回数で打ち切らず、最大60秒の間隔で再試行。途中の手動キャンセルは受け付ける。認証・残高不足が429等の一時障害にも一致するときは、復旧不能の分類を優先して原因を返す | `pipeline.mjs`, `survey.mjs`, `failures.mjs` |
| 連続3単位の失敗 | 通常モードでは独立する残りの単位を処理。失敗した単位とその依存先だけ未完了 | `pipeline.mjs` |
| build-loopの既定5回・呼び出し予算・エラー件数が減らない | 通常モードではクリーンになるまで継続。利用者が指定した有限の上限だけ適用。エラー件数が3回続けて減らない場合は止めずに `stalled` として記録し、status と結果に「ルールブックの修正を提案」と表示する（上流ルール6） | `build-loop.mjs`, `status.mjs` |
| benchmarkの生成コード検査20秒 | 通常モードは時間で打ち切らない。明示的なboundedモードの検査のみ20秒 | `bench.mjs` |
| `status --wait 600`の待機終了 | 状態表示を返すだけ。worker・runnerに終了信号を送らない。引き続き同じ実行を監視 | `run_migration.mjs` |
| 準備工程の定期確認が重い・status や phase next が無言のまま打ち切られる | 生存通知は別スレッドから15秒ごとに出す（検証は同期処理なので、従来のタイマーは処理が終わるまで鳴らなかった）。status・phase・approve・diagnose・source-spec を含む全コマンドが対象。manifest検証は保護パスの解決を1回にまとめ、2,000ファイルで約5.5秒→約2.2秒。`status --fast` と断片進捗も使える。全ソース再検証は工程の境界で実施 | `command-progress.mjs`, `command-progress-heartbeat.mjs`, `core.mjs`, `run_migration.mjs` |
| 異常終了した実行の run.lock | 同じホストで所有PIDが存在しなければ、次のコマンドがロックを自動で外して続行する（build-loopロックも同じ。短い回収用の印を取り、外す直前に内容が変わっていないか確認する）。別ホストのロック（共有フォルダ）と、PIDが無関係のプロセスに再利用された場合だけは止まり、実行が止まったことを確認して `unlock --pid` を使う。0.10.0 より前に作られたロックはホストを記録していないため、このホストでのPIDで判断する。ホストはホスト名で区別します。実行ごとにホスト名が変わるコンテナでは、自分の異常終了で残ったロックも別ホスト扱いになり `unlock` が必要です。ホスト名が同じでPID空間が別のコンテナ同士で、同じ移行フォルダを共有しないでください。 | `core.mjs` の `lockRun` |
| サービス・通信側の「timed out」 | 一時障害として再試行する。キット自身が明示的な期限（boundedモード）で止めた場合だけ最終扱い | `failures.mjs` |
| Copilot CLI 内部の受け渡し待ち（「Session host did not acknowledge 'assistant.reasoning' delivery within …」、報告では120秒。または「event poll loop may be wedged」） | そのファイルと、それに依存するファイルを止めず、一時障害として再試行する。待ち時間は CLI の中で固定（1.0.105 に設定なし）でキットからは延ばせない。同時に動かす数を減らすと起きにくい | `failures.mjs`, `guidance.mjs` |
| surveyの範囲外引用・取りこぼしが1回の補正後も残る | 止めない。その行を `uncited` 付きのUNKNOWN / TODO(port)にしてscopeを完了する。根拠欄は元ファイルの範囲と却下記録だけで、担当の引用は残さない。factsは不正な項目だけを捨てる。件数をレビュー報告に含める | `survey.mjs` |
| coordinatorの準備・報告helperのTypeError/SyntaxError | 実装と呼び出しの契約を照合し、同じ許可範囲で修正・機械的検証・候補生成から再開。標準inventory-previewを使い、再surveyや検証省略を選択肢にしない | preparation・PHASE-HANDOFF・全親skill/agent |
| 依存解析の文字コード・metadata型ずれ・再帰例外 | 言語別の復号/型確認と反復walk・Import展開を使う。読取不可・構文不備は未解析として記録し、独立したファイルを解析する。全rootからmanifest/依存宣言まで確認 | dependency mappers・source-spec・make_manifest |

巨大ファイルのcontractsは断片ごとの観測と引用を機械的に結合します。断片をまたぐ関係を推測で確定しません。
inventoryの巨大ファイルは断片をまたぐデータフローを確定できないため、モデルを呼ばずに `UNKNOWN` / `TODO(port)` を残します。
既存の仕様レビュー・準備監査・工程承認で解決する対象を明示します。本文を捨てたり、架空の証拠行を書いて完了にする処理はありません。

## 失敗・停止として残す条件

以下は時間や負荷による打ち切りではありません。継続しても正しい結果を保存できない条件です。
実行中の兄弟workerを中断するのは利用者のキャンセルと、入力変更など安全な実行の前提が壊れた場合です。
サインイン・権限・サービスの残高不足は新規起動を止めますが、別の健全なworkerを時間だけで殺しません。

| 条件の種類 | 具体例・扱い |
|---|---|
| 利用者の操作 | SIGINT / SIGTERM / AbortSignal。doctorを含め子プロセス群へ伝え、開始済みworkerが終わるまでロックを保持。SIGTERM後の終了処理ログも保存する |
| 利用者が明示した上限 | boundedモードの時間・回数・予算、明示的な `--max-calls` / `--max-rounds`。暗黙に設定しない |
| 権限・工程の範囲 | 未承認、古い承認、未完了の前工程、承認済みbatch外、pilotの範囲外、source-onlyでparity実行 |
| 入出力の安全性 | 元ソースへの上書き、保護パス、パストラバーサル、symlink、重複した変換先、未知の書き込み先、guardrails違反 |
| 実行中の前提変更 | ソース・ルール・設定・比較器・repair intentの変更、候補出力の外部変更。古い結果を採用しない |
| 同時実行と記録の整合性 | 生存する所有者または別ホストのrun/build-loopロック（このホストで所有者がいないロックは自動で外す）、破損した台帳・ハッシュ・レビュー証跡、未完了依存先、typecheck付きの循環依存 |
| 起動不能・認証・残高 | CLIや言語ランタイムがない、agentが見つからない、モデルが利用不可、認証切れ、403、サービス側のquota/credits/billing制限。新規起動を止め原因を報告 |
| 実際に壊れた応答 | 不正JSON/JSONL、不完全なterminal event、誤target/schema、範囲外引用、取りこぼし・重複、裁定漏れ、レビューとverdictの矛盾。surveyでは正常終了したCLIストリーム内の不正なモデルJSON/schema/項目/引用を保存し、不正箇所だけ1回補正する。再び不正なら、その行を `uncited` 付きのUNKNOWNにして完了する（止めない）。CLIストリーム自体の破損やsession.errorは障害の分類に従って扱う |
| 準備監査の入力が上限超 | `audit_inputs.mjs freeze` は切り詰めずに拒否する。1 batch のファイル数を減らして freeze し直す（または `maxReviewInputBytes` を上げる） |
| 本当に処理できない必須データ | バイナリ（NULを含み UTF-16 でもない）・読取権限、rulebookやcensusの1項目など必須メタデータだけでモデル容量を超える。ソース本文の大きさによる停止とは区別して報告 |
| 変換結果・テストの失敗 | typecheck・original・mutation・build・smoke・parityの非ゼロ終了、比較差分、未確定のマーカー。build-loop内の修正可能な失敗はレビュー付き修正へ進む |
| 修正の所有先を決められない | manifestに対応しないコンパイラ診断、16000文字を超える1修正用診断、元テストの失敗、比較器自身の欠陥。元ソースや比較器を勝手に直さない |
| 保存・環境の実障害 | ENOSPC、EACCES、EMFILE、EIO、spawn失敗、stdinのEPIPE以外の障害、OSによるOOM kill、外部プロセス・端末・サービスの終了。保存できない結果を完了としない |
| hookが権限制限を保証できない | hookの欠落・応答不正、ホスト側のhook制限時間30秒、prompt modeでhookが読み込まれない。doctorはその問題を検出する。30秒はworkerの実行時間ではない |
| 補助ツールの不正入力 | 未知のCLIオプション、空manifest、壊れたTSV/設定、benchmarkがテスト専用rootでない、インストール先の衝突。作業開始前に具体的な誤りを報告 |

読み込めないソースや対象外・不存在のcensusファイルがある場合、読めるscopeは保存しますがsurvey全体は未完了とし、mergeしません。入力修正後も正常なscopeを再利用します。

外部サービス・OS・VS Code/ホストの独自制限や、任意のプロジェクトコマンド内部のタイムアウトはキットから解除できません。
親はホストの待機APIが一旦戻ったことをプロセス終了と取り違えず、実行IDを維持して待ちます。
CIの45分・テストケースの10分制限はこのキット自体の開発テスト用で、移行runnerには適用されません。
外部中断が発生した場合は、発生元と終了コードを示し、保存済み結果から再開します。

## 再現可能な全ソース索引と検証

[interruption-sources.json](interruption-sources.json) は `lib/`・`scripts/`・拡張ブリッジ・hook・テンプレート・CIを全走査し、
明示的なthrow/reject/exit、kill/abort、break、時間指定の候補を行番号・本文・ファイルハッシュ付きで収集したものです。
単なるループ脱出・PIDの生存確認・例外の再送出も含め、上の表と突き合わせて点検します。索引生成自体のコードとtests/fixtures/vendorは対象外です。
外部プログラム内の全エラーや、暗黙のOS例外まで列挙したと偽るものではありません。

```bash
node scripts/audit_interruptions.mjs > docs/interruption-sources.json
node --test tests/continuous-execution.test.mjs tests/survey-large-source.test.mjs tests/interruption-policy.test.mjs
npm test
npm run demo
```

回帰テストは古い600秒設定の無効化、短い従来設定時間を超えるCPU負荷・無出力の実プロセス、
回数・入力累計・修正回数・連続失敗・build-loop既定回数を超える継続、16MiB超のログと中間診断の読取、
巨大本文・巨大1行・Unicode・CRLFの無欠落分割、inventoryの巨大ファイルのモデルなしUNKNOWN、手動中断からの断片再利用、範囲外引用が補正後も残る場合のUNKNOWN完了、同期処理中の生存通知、所有者のいないロックの自動解除、明示的キャンセルを確認します。
モデル応答はテストダブルです。利用者の実プロジェクト・認証済みモデルでの完走時間は未計測です。
