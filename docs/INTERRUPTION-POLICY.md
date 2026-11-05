# 処理を途中で打ち切らないための実装と停止条件

日本語 | [English](INTERRUPTION-POLICY.en.md)

通常実行は `executionMode: "continuous"` です。設定を持たない既存プロジェクトも同じです。
古い設定に `timeoutSeconds: 600` や `maxAgentCalls: 100` が残っていても適用しません。
CPU使用率、経過時間、呼び出し数、修正回数、入力累計、ログ量だけでは処理を終了しません。
一時的な通信障害は待って再試行し、既存プロセスが実行中ならそのプロセスを待ちます。
例外は2つで、どちらも止めるのはその呼び出しだけです。実行は続けます（下の表）。

- 作業役の AI 呼び出しが何も出力しないまま `workerSilenceSeconds`（既定600秒）続いたとき。同じ呼び出しをやり直します（エラーが出ないまま切れた接続から戻すため）。
- 変換の AI 呼び出しが、出力を続けたまま `workerCallMinutes`（既定30分。その単位のソースと移行先の大きさ 8 KiB ごとに1分を足す）を過ぎても答えないとき（0.47.0 から）。何をしていたかを伝えて1回だけやり直し、それでも答えなければ、そのファイルをその実行では後回しにして、ほかのファイルを進めます。

上限を必要とする場合だけ、利用者が `executionMode: "bounded"` を選ぶか、コマンドに
`--max-calls N` / `--max-rounds N` を明示します。エージェントが独断で有限の上限を追加してはいけません。
`concurrency` と1入力のモデル容量は引き続き守ります。これらは仕事を分割・順番待ちさせるための制約です。

## 打ち切りを撤廃・回避した条件

| 条件 | 通常実行での処理 | 実装 |
|---|---|---|
| CPU 100%が継続、CPUが低い、コマンド・ビルド・比較の無出力 | 終了・再起動しない。CPUによる自動終了コードはなく、親の指示にも中断禁止を明記 | 全ハーネスのskill・orchestrator・工程引継ぎ |
| 作業役の AI 呼び出しが何も出力しない（0.44.0 から。`workerSilenceSeconds`、既定600秒） | 2026-11-02、Windows・会社の VPN（Cisco Secure Client。ISE Posture の確認がよく迷子になる）・画面ロック中に通信が途切れる PC で、レビュー1回が戻らず、工程 04 が 96/554 のまま11時間43分止まった。エラーが出ないまま切れた接続を CLI は待ち続ける（CLI 1.0.105 は、止まった応答を少なくとも400秒は自分で打ち切らないことを 127.0.0.1 の偽プロバイダで確認）。そこで作業役は途中経過を出力し（`--stream on`。文章と考え中の内容が届くたびに1行）、runner は何も届かない時間を数える。設定の秒数続いたら、その呼び出しだけを止めて（子プロセスごと）、少し待ってから同じ呼び出しをやり直す。期限ではないので、出力が続く呼び出しは長くかかっても止めない。CPU も見ない。やり直すたびに待つ時間を倍にする（最大で設定の4倍。既定では10・20・40・40・40・40分）。途中経過を出さずに長く考えるだけの呼び出しにも、やり直すたびに時間を与えるため。1回の呼び出しにつき5回まで（受け渡し待ち・ロック待ち・サインインの案内つきの通信エラー・引き取られた接続と、通信エラー・レート制限・5xx 以外の理由で CLI があきらめた呼び出し、トークンを確かめられなかったとき、モデルの一覧を取れなかったときと合わせて数える。boundedモードでは `transientRetries` が全体の上限）。それでも何も出ないファイルは、変換なら実行の最後にもう1周やり直し（答えの書き損じと同じ。修正の実行ではしない）、それでも出なければそのファイルとそれを使うファイルだけを未完了にする。ほかのファイルは進める。調査は区切りごとに同じくやり直す（最後のもう1周はない）。時間は最後の出力から区切りごと（設定の20分の1、最大30秒）に数え、予定よりずっと遅れて来た区切り（パソコンのスリープ、runner の一時停止）は2区切りとしか数えないので、目覚めた直後に答える呼び出しを止めない。runner が忙しい間に届いていた出力も、止めるかどうかを決める前に読んで数える。途中経過の行は、メモリ・ディスクに退避するログ・記録のどこにも残さず、届いた数（`streamedDeltas`）だけを残す。呼び出しの前の CLI のバージョン確認も同じ時間で見張る（止まった確認は止め、呼び出しは警告つきで続ける）。呼び出しのプロセスの外のもの（プロセスグループを抜けたものなど）が出力の通り道（パイプ）を持ち続けても、CLI が止められるか自分で終わってから5秒後に手放して呼び出しを終える（自分で終わった呼び出しは答えをそのまま使う。見張りをやめていても同じ。その5秒の間に無反応や期限切れとして扱うこともない）。Windows で taskkill が10秒たっても終わらないときは、CLI 自体を止めて先へ進む。準備監査（`audit_inputs.mjs run`・`run-pending`）も同じくやり直し（最後のもう1周はない）、Ctrl+C で止めると作業役の CLI も一緒に止める。レビューのベンチマークにはやり直しがないので、止まった呼び出しはエラーで終わり、もう一度実行するとやり直せる。無反応で止めたのと同時に Ctrl+C で実行を止めたときは、中断として記録し、やり直さない。`0` で見張りをやめる（作業役は途中経過を出力せず、0.43.1 までと同じく呼び出しが戻るまで待つ）。それ以外は 300〜86400（CLI はレート制限の待ち、180秒までを何も出さずに待つため）。status は「a call that showed no sign of progress」と、案内（`cli-silent`）はやり直し・接続の確認・待つ時間の延長を示す | `process.mjs`, `copilot_adapter.mjs`, `execution-policy.mjs`, `failures.mjs`, `pipeline.mjs`, `survey.mjs`, `audit_inputs.mjs`, `status.mjs`, `guidance.mjs` |
| 変換の AI 呼び出しが、出力を続けたまま終わらない（0.47.0 から。`workerCallMinutes`、既定30分に、その単位のソースと移行先の 8 KiB ごとに1分を足す） | 2026-11-05、Windows・キット 0.46.1・CLI 1.0.105・gpt-6-luna・並列4の工程 04（117/554）で、ふだん2〜4分の呼び出しが何時間も終わらなかった（59行のファイルのレビュー2つが201.8分・192.8分で手で止められ、再開するとまた同じファイルから始まった）。入力が `maxReviewInputBytes`（1 MiB）を超えた単位では、キットがファイルの一覧を渡して「一覧のファイルを全部読め」と指示していた。依存の連鎖に 1 MB の自動生成ファイル（61単位の連鎖にあった）があり、CLI 1.0.105 の view は 20 KB を超えるファイルを view_range なしでは断り、範囲つきでも1回に約20 KB しか返さない（本物の CLI を通信なしで動かして確認）。1回読むごとに AI のターンが進み、文脈が大きくなる。出力は続くので無反応の見張りでは止まらず、continuous には上限がなかった。直したこと: ツールで読む方式では、その単位のファイル（ソース・移行先・ルールブック・設計入力）を view_range で続けて全部読み、依存は使う名前を検索して見つかった行だけ読む（依存を丸ごと読まない、forceReadLargeFiles を使わない）。そのうえで、翻訳ループの呼び出しが上限を過ぎても答えなければ、無反応のときと同じく子プロセスごと止め、新しいセッションで1回だけやり直す（止めた呼び出しのターン数・道具の数・いちばん多く読んだファイルと回数・文脈の大きさを伝え、依存は必要な行だけ読むよう指示する）。それでも答えなければ、そのファイルを理由つきで未完了にし、その実行の最後のもう1周には入れない（同じ時間を繰り返すため）。ほかのファイルは進め、そのファイルを使うファイルは未完了のまま待つ。次の実行は、まだ試していないファイルを先に、前に試して終わらなかったファイルを後に、どちらもマニフェストの順で配る（修正の実行は今の順のまま）。時間は無反応の見張りと同じく区切りごと（上限の20分の1、最大30秒）に数え、予定よりずっと遅れて来た区切り（スリープ・一時停止）は2区切りとしか数えない。continuous と bounded の両方で効き、bounded の `timeoutSeconds`（最終、やり直さない）とは先に来た方で止める。止めたのと同時に Ctrl+C で実行が止められたときは中断として記録し、やり直さない。調査・準備の監査・ベンチマークには使わない（道具を持たず1回で答えるか、人が手で回す測定のため）。各呼び出しの記録には、何をしたか（`activity`。ターン数・道具ごとの数・よく読んだファイル5つと断られた回数・文脈の大きさ。中身は残さない）と上限（`callLimitMinutes`）が残る。`0` で止めない。それ以外は 10〜1440。status は「a call stopped at its call limit」と、案内（`cli-call-limit`）はやり直し・上限の延長・依存の確認を示す | `process.mjs`, `copilot_adapter.mjs`, `execution-policy.mjs`, `failures.mjs`, `pipeline.mjs`, `activity.mjs`, `status.mjs`, `status-snapshot.mjs`, `guidance.mjs` |
| 1ワーカー600秒、ビルド・比較600秒 | 自動終了しない。既存の正数設定も通常モードでは無効。低水準APIの `timeoutMs: 0` はタイマーを作らない | `execution-policy.mjs`, `process.mjs`, `copilot_adapter.mjs`, `pipeline.mjs` |
| モデル一覧・バージョン確認の20/30/60秒 | 暗黙の時間切れを撤廃。応答を待つ | `models.mjs`, CLIとadapterの診断 |
| doctorの各プローブ | 移行作業ではない短い確認なので、continuousでも起動するプロセス1つにつき180秒（boundedで `commandTimeoutSeconds` をそれより短く明示すればその値）で打ち切り、終わらなかった確認とよくある原因（応答しないプロキシ・サインイン待ち・ネットワーク遮断）を出して終わる。応答しないプロキシで1時間以上「still running」が続いた（2026-10-30）。後続のCLIプローブは開始しない。利用者の明示キャンセルも各プローブへ伝える。127.0.0.1 の偽プロバイダを使うプローブは、その子プロセスにだけ `NO_PROXY` へ 127.0.0.1・localhost を足す | `run_migration.mjs` の `doctor`, `copilot_adapter.mjs` |
| 子プロセスstdout+stderrが16MiB超 | 終了せず全出力をログファイルへ退避。メモリには末尾だけ保持。モデルJSONLと診断パーサーは全ログを順に読む | `process.mjs`, `copilot_adapter.mjs`, `diagnostics.mjs`, `diagnostic_queue.mjs` |
| surveyのファイル集合・censusが入力上限超 | ファイル・箇所の集合を分割。scope IDと既存結果を維持 | `survey-parts.mjs` |
| surveyの単一ファイル本文が入力上限超 | facts・contractsは行範囲に分割（1行自体が巨大でも文字位置で分割し、Unicodeのペアを切らない。入力は実際のJSON化後bytesで検査）。inventoryは、RULEBOOKと1箇所と一緒に1回の入力に収まらないファイルについて、モデルを呼ばずに全箇所をUNKNOWN / TODO(port)で記録し、`unsurveyedOversizedFiles` に残す（2万行・1,000箇所の1ファイルで148回の呼び出しが同じUNKNOWNに結合されていた） | `survey-parts.mjs`, `survey.mjs` |
| 01の依存監査（2人×20ファイル、最大3ラウンドで停止） | 同梱・fixture検証済みの解析器では、`dependency-targets` が選ぶ約10ファイルを1人が1回監査する。見落としは直して同じファイルで比べ直す。残った未解決は report.md に書いて止めない（手書きのグラフも3ラウンド後は止めずに報告） | `preparation.mjs`, `PREPARATION-AUDITS.md`, 01の指示 |
| 入力上限の既定64KB | 新規導入の既定を1 MiB（1048576 bytes）に引き上げ、断片化そのものを減らす。既存設定の値は変えない（利用者が選んだ値のため） | `templates/migration-config.json` |
| 大きい本文に大量のcensus箇所 | 入力容量を本文と箇所に配分し、全箇所で全断片を維持しながら同一断片の重複送信を減らす | `survey-parts.mjs` |
| 巨大ファイルの途中で手動中断・外部障害 | 検証済み断片を入力ハッシュ付きで保存。再開時に同じ断片を呼び直さない。全断片が揃うまでファイル・scopeは未完了 | `survey.mjs`の `.parts/` 記録 |
| 100呼び出し、2修正回、入力累計予算、1呼び出しAI Credits上限 | 通常モードでは打ち切り条件にしない。利用量は記録。CLIへ `--max-ai-credits` を渡さない。テンプレートの既定値と異なる値が設定に書かれていれば、doctor の `execution limits` と実行結果の `ignoredLimits` で「適用されていない」と表示する（停止はしない） | `execution-policy.mjs`, `run_migration.mjs` |
| 一時障害の既定2回リトライ | 通常モードでは回数で打ち切らず、最大60秒の間隔で再試行（例外は CLI 内部の受け渡し待ち・ロック待ち、何も出力しない呼び出し（上の行）、サインインの案内つきの通信エラー、引き取られた接続、通信エラー・レート制限・5xx 以外の理由で CLI があきらめた呼び出し・トークンを確かめられなかったとき・モデルの一覧を取れなかったときで、どれも1回の呼び出しにつき5回まで。変換では、そのあと実行の最後にもう1周。ただし呼び出しの上限を使い切ったときは、やり直しを待つ間に使い切ったときも、もう1周しない。下の行）。途中の手動キャンセルは受け付ける。準備監査も 0.44.0 から同じく再試行する（それまではすぐ失敗）。認証・残高不足が429等の一時障害にも一致するときは、復旧不能の分類を優先して原因を返す（通信エラーのあとのサインインの案内だけは除く。下の行） | `pipeline.mjs`, `survey.mjs`, `audit_inputs.mjs`, `failures.mjs` |
| 連続3単位の失敗 | 通常モードでは独立する残りの単位を処理。失敗した単位とその依存先だけ未完了 | `pipeline.mjs` |
| build-loopの既定5回・呼び出し予算・エラー件数が減らない | 通常モードではクリーンになるまで継続。利用者が指定した有限の上限だけ適用。エラー件数が3回続けて減らない場合は止めずに `stalled` として記録し、status と結果に「ルールブックの修正を提案」と表示する（上流ルール6） | `build-loop.mjs`, `status.mjs` |
| benchmarkの生成コード検査20秒 | 通常モードは時間で打ち切らない。明示的なboundedモードの検査のみ20秒 | `bench.mjs` |
| `status --wait 600`の待機終了 | 状態表示を返すだけ。worker・runnerに終了信号を送らない。引き続き同じ実行を監視。0.47.0 から、単位が1つ終わるたびには返さない（実行の停止・開始、blocked の数、build-loop の段階・周回、survey の範囲と状態の変化と、待つ時間が過ぎたときに返す） | `run_migration.mjs` |
| 準備工程の定期確認が重い・status や phase next が無言のまま打ち切られる | 生存通知は別スレッドから15秒ごとに出す（検証は同期処理なので、従来のタイマーは処理が終わるまで鳴らなかった）。status・phase・approve・diagnose・source-spec を含む全コマンドが対象。manifest検証は保護パスの解決を1回にまとめ、2,000ファイルで約5.5秒→約2.2秒。`status --fast` と断片進捗も使える。全ソース再検証は工程の境界で実施 | `command-progress.mjs`, `command-progress-heartbeat.mjs`, `core.mjs`, `run_migration.mjs` |
| 異常終了した実行の run.lock | 同じホストで所有PIDが存在しなければ、次のコマンドがロックを自動で外して続行する（build-loopロックも同じ。短い回収用の印を取り、外す直前に内容が変わっていないか確認する）。別ホストのロック（共有フォルダ）と、PIDが無関係のプロセスに再利用された場合だけは止まり、実行が止まったことを確認して `unlock --pid` を使う。0.10.0 より前に作られたロックはホストを記録していないため、このホストでのPIDで判断する。ホストはホスト名で区別します。実行ごとにホスト名が変わるコンテナでは、自分の異常終了で残ったロックも別ホスト扱いになり `unlock` が必要です。ホスト名が同じでPID空間が別のコンテナ同士で、同じ移行フォルダを共有しないでください。 | `core.mjs` の `lockRun` |
| サービス・通信側の「timed out」 | 一時障害として再試行する。キット自身が明示的な期限（boundedモード）で止めた場合だけ最終扱い | `failures.mjs` |
| 名前解決の失敗・ネットワークに届かない・この PC 側で切れた接続・答えの途中で切れた接続（0.44.0 から。ENOTFOUND・getaddrinfo・ENETUNREACH・ENETDOWN・EHOSTUNREACH・EHOSTDOWN・ECONNABORTED・UND_ERR_*、Windows の「No such host is known」「forcibly closed by the remote host」「connected party did not properly respond」「target machine actively refused」「established connection was aborted」と os error 10050〜10054・10060・10061・10064・10065・11001・11002、「host is down」、CLI の通信部分の「dns error」「connection closed before message completed」「error reading a body from connection」「error writing a body to connection」「end of file before message length reached」「connect-stage timed out」「connect error: deadline has elapsed」、close_notify なしで閉じた TLS、「tls handshake eof」、プロキシのトンネルの「proxy CONNECT I/O error」「tunnel I/O error」「proxy CONNECT did not complete within」、組織の IP 許可リストによる拒否（「IP allow list enabled」「IP address is not permitted」。VPN が切れて社外からの接続になったとき）など） | VPN の再接続や再確認、眠ったネットワークの後に残るエラー。ETIMEDOUT などと同じ通信エラーとして再試行する（通常モードでは回数で打ち切らない）。これまでは再試行せず、そのファイルをすぐ未完了にしていた。外側の「error sending request」だけでは通信エラーとみなさない（証明書・トンネルを断るプロキシ・誤ったアドレスも同じ形で来る。AI の呼び出しで断られたトンネルは、CLI があきらめた呼び出しとして来る。下の行）。status は VPN・プロキシの設定・会社の証明書（NODE_EXTRA_CA_CERTS）の確認を勧め、30分を超えると続いている時間も示す。案内は `cli-network` | `failures.mjs`, `status.mjs`, `guidance.mjs` |
| CLI が自分で何度かやり直してあきらめた呼び出し（0.44.0 から。「Failed to get response from the AI model; retried N times … Last error: …」「… because the slow-stream retry limit was reached」） | 再試行する。最後のエラーが通信エラー・レート制限・5xx なら回数の上限なく（答えの途中で切れた接続を、実物の CLI はこの形で報告する）、それ以外（答えの終わりが来なかった、JSON でない返事など）は1回の呼び出しにつき5回まで（受け渡し待ちと合わせて数える）。変換では、そのあと実行の最後にもう1周。0.43.1 までは、最後のエラーがキットの知っている一時的な失敗でなければ、すぐ未完了にしていた。案内は `cli-gave-up`、または最後のエラーに合う案内 | `failures.mjs`, `pipeline.mjs`, `guidance.mjs` |
| 途中で引き取られた接続（0.44.0 から。このパソコンが信頼していない証明書。UnknownIssuer・NotValidForName・certificate verify failed・自己署名など、「does not appear to originate from GitHub」、CLI がトークンを確かめる段階で GitHub の形ではない返事が来たとき（4xx の「Failed to fetch PAT user login (403): Failed to fetch Copilot user info: 403 Forbidden: <html>…」や、200 で来たページの「Invalid Copilot user response」）、CLI がモデルの一覧を取る段階で GitHub の要求 ID がない返事や 200 で来たページが来たとき（CLI 自身の行で「(Request ID: …)」のない「Error: Access denied by policy settings」、「Error: expected value at line 1 column 1」）、プロキシが通信の中で自分へのサインインを求めたときと、CLI がそのサインインをできなかったとき（「407 Proxy Authentication Required」、モデルの一覧を取る段階では「Error: 407」。Kerberos の「proxy Negotiate authentication failed: failed to acquire proxy credentials: …」、「tunnel error: proxy authorization required」）、ネットワークが自分のページでサインインを求めたとき（ポータルの「511 Network Authentication Required」、モデルの一覧を取る段階では「Error: 511」）。0.43.1 までは、407・Negotiate の失敗・511 のページと、モデルの一覧を取る段階の 200 のページはサインインの問題として実行を止めていた） | 会社のプロキシ・VPN・セキュリティソフトが暗号化された通信の中身を確かめていると設定を直すまで通らず、VPN の確認中（ISE Posture）には一時的に起きることもある。そこで1回の呼び出しにつき5回まで再試行し（受け渡し待ちと合わせて数える）、回数の上限なく再試行することはしない。変換では、そのあと実行の最後にもう1周。0.43.1 まではすぐ未完了にしていた（「fetch failed」がつけばサインインの疑いとして5回まで）。CLI がトークンを確かめる段階では、それ以外は CLI が原因を書かない（証明書も、断られたプロキシも、名前の引けないプロキシも「network fetch failed: request failed: error sending request for url (…)」になる）。VPN が切れているのと見分けられないので、そこでは通信エラーとして回数の上限なく再試行する（status が30分を超えると続いている時間を示す）。案内は `cli-intercepted`（つながってからのやり直し。プロキシのサインインならパソコンのロックを解除してから。`copilot login` では直らない。会社の証明書は `NODE_EXTRA_CA_CERTS` で CLI に教える。プロキシがサインインを求め続けるなら管理者にプロキシの設定を確かめてもらう） | `failures.mjs`, `pipeline.mjs`, `guidance.mjs` |
| 通信エラー（ETIMEDOUT・ECONNRESET・ECONNREFUSED・EAI_AGAIN・socket hang up・fetch failed、0.44.0 から上の行のものも）に、CLI のサインインの案内（「To authenticate, you can use…」「run the '/login' command」）が続くもの | サインイン切れとして実行全体を止めず、一時障害として再試行する。CLI は通信できずにサインインを確認できなかっただけのことが多い。本当にサインインが切れている可能性も残るので、詰まりと同じく1回の呼び出しにつき最大5回まで（通常モードでも無制限にしない。変換では、そのあと実行の最後にもう1周）。0.44.0 から、CLI 自身がそう書いたとき（「Authentication token found but could not be validated … Your token may still be valid. Check your network connection」）と、起動時にモデルの一覧を取れなかったと書いたとき（「Error: Failed to load models … Copilot could not retrieve the list of available models.」。作業役の呼び出しはどれも起動時にこれを取りに行く。0.43.1 まではサインインの問題として実行を止めていた）は通信の問題として扱い、通信エラー・レート制限・5xx が一緒なら回数の上限なく、そうでなければ5回まで再試行する。どちらも実行全体を止めず、作業役を自分の CLI の置き場所へ移すこともしない。案内は `cli-network`（やり直し・プロキシとサインインの確認）で、`copilot login` は勧めない。「not signed in to GitHub」「authentication required」「Authentication failed」（モデルの一覧に 401 が返ったときの CLI の言葉でもある）・401・Bad credentials・`session.error authentication` のような明示や、GitHub がトークンの確認に答えて、GitHub のエラーの形で断ったとき（「Failed to fetch PAT user login (403): GitHub returned: …」のようにレート制限以外の 4xx。トークンに権限がない・SAML の承認がない・Copilot が有効でないなど。`workerCopilotHome` が "separate" なら、先に自分の CLI の置き場所でもう一度試す）は、これまでどおりサインインの問題。レート制限（429、または「rate limit」と書いた 403）と 5xx は回数の上限なく再試行し、組織の IP 許可リストによる拒否は通信エラー（名前解決の失敗などの行）、ほかの形の 4xx の返事は途中で引き取られた接続（上の行。ただし 401 の返事と、前に「Proxy」も「Network」もなく「Authentication Required」と書いた返事は、サインインの問題として止まる）。ほかの止まる原因（エージェントがない・残高・ファイル数の上限など）も、通信エラーが一緒でも止まる | `failures.mjs`, `guidance.mjs` |
| Copilot CLI 内部の受け渡し待ち（「Session host did not acknowledge 'assistant.reasoning' delivery within …」、Windows の記録では「session event delivery failed: session host did not complete the assistant.reasoning event within 120s」、報告では120秒。または「event poll loop may be wedged」） | そのファイルと、それに依存するファイルを止めず、一時障害として再試行する。1回の呼び出し（調査は1区切りとその1回の修正）につき、ほかの一時障害とは別に数えて最大5回（boundedモードでは `transientRetries` が全体の上限。再試行のたびにAIを1回使う）。それでも詰まる呼び出しは、変換なら実行の最後にもう1周やり直し（0.44.0 から）、それでも詰まれば、そのファイルと依存するファイルだけを未完了にする。待ち時間を延ばす設定は CLI 1.0.105 とキットには見当たらない | `failures.mjs`, `pipeline.mjs`, `survey.mjs`, `guidance.mjs` |
| Copilot CLI 内部のロック待ち（「The shared writer lock timed out.」「MCP installation storage is busy」「Another process is changing MCP configuration」） | そのファイルを止めず、一時障害として同じ CLI の置き場所で再試行する（変換やレビューを担当する CLI を別の置き場所へ移す理由にはしない）。受け渡し待ちと同じく1回の呼び出しにつき最大5回（boundedモードでは `transientRetries` が全体の上限）。それでも通らない呼び出しは、変換なら実行の最後にもう1周やり直し（0.44.0 から）、それでも通らなければ、そのファイルと依存するファイルだけを未完了にする。CLI が MCP の起動の失敗として報告しても同じ扱い。案内（`cli-lock`）は、作業役専用の置き場所（`workerCopilotHome` が `separate`）で起きたときは `shared` に戻すこと、`~/.copilot`（既定の `shared`）で起きたときは前の実行で残った CLI の確認を先に勧める | `failures.mjs`, `pipeline.mjs`, `survey.mjs`, `guidance.mjs` |
| 変換の1回の答えの書き損じ（JSON の前後の文字・形の誤り、最後のメッセージが空やツール呼び出しで終わった答え、裁定の参照名、末尾行 PORT STATUS の位置・件数、何も変えない single-pass の修正） | 止めない。同じ役に何が違ったかを伝えて、その場で1回だけ答え直させる。このファイルでは直せない指摘は、修正役に `TODO(port): <参照名>: <必要なこと>` の行で残させ、直さずに残った指摘は要約の `selfRepairs.flagged` と警告で伝える。末尾行の形や位置だけの誤り（大文字や句読点、閉じないコメント、最後の閉じ括弧より前、同じ末尾行が2つ）は、AI を呼ばずにランナーが書き直す（0.46.0、`trailer-repair.mjs`）。それ以外で書かれたファイルに残った末尾行の誤り（TODO(port) の行数との食い違いなど）は、確認済みの指摘として修正役に回し、直したファイルをレビューする（1回の実行で2回まで。修正回数の上限には数えない）。single-pass の修正の後に末尾行だけを直したときは、その修正のレビューを保つ（0.46.0）。それでも止まった単位（末尾行を除く）は、実行の最後にもう1周だけ処理する（連続失敗・呼び出し回数の上限、全体に及ぶ失敗、中断で止まった実行ではしない）。回数は実行の要約の `selfRepairs` に残す（ランナーの書き直しは `markerRewrites`、保ったレビューは `reviewsKept`） | `pipeline.mjs`, `markers.mjs`, `trailer-repair.mjs`, `copilot_adapter.mjs` |
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
| 起動不能・認証・残高 | CLIや言語ランタイムがない、agentが見つからない、モデルが利用不可、認証切れ、403、サービス側のquota/credits/billing制限（モデルの一覧を取る段階で GitHub が返す 402 Payment Required と、CLI の「Copilot Pro trial paused」も。0.44.0 から案内は `credits`）。新規起動を止め原因を報告 |
| 実際に壊れた応答 | 不正JSON/JSONL、不完全なterminal event、誤target/schema、範囲外引用、取りこぼし・重複、裁定漏れ、レビューとverdictの矛盾。変換では、その場で1回答え直させ、実行の最後にもう1周しても直らないときだけ、その単位を未完了にする（上の表）。surveyでは正常終了したCLIストリーム内の不正なモデルJSON/schema/項目/引用を保存し、不正箇所だけ1回補正する。再び不正なら、その行を `uncited` 付きのUNKNOWNにして完了する（止めない）。CLIストリーム自体の破損やsession.errorは障害の分類に従って扱う |
| 準備監査の入力が上限超 | `audit_inputs.mjs freeze` は切り詰めずに拒否する。1 batch のファイル数を減らして freeze し直す（または `maxReviewInputBytes` を上げる） |
| 本当に処理できない必須データ | バイナリ（NULを含み UTF-16 でもない）・読取権限、rulebookやcensusの1項目など必須メタデータだけでモデル容量を超える。ソース本文の大きさによる停止とは区別して報告 |
| 変換結果・テストの失敗 | typecheck・original・mutation・build・smoke・parityの非ゼロ終了、比較差分、未確定のマーカー。build-loop内の修正可能な失敗はレビュー付き修正へ進む |
| 修正の所有先を決められない | manifestに対応しないコンパイラ診断、16000文字を超える1修正用診断、元テストの失敗、比較器自身の欠陥。元ソースや比較器を勝手に直さない |
| 保存・環境の実障害 | ENOSPC、EACCES、EMFILE、EIO、spawn失敗、子の標準入力への書き込みの EPIPE・EOF 以外の障害（EPIPE と Windows の EOF は、子が入力を読み終える前に終わったか入力を閉じたことなので、子自身の終了コードと出力で扱う）、OSによるOOM kill、外部プロセス・端末・サービスの終了。保存できない結果を完了としない |
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

回帰テストは古い600秒設定の無効化、短い従来設定時間を超えるCPU負荷・無出力の実プロセス、何も出力しない作業役の停止とやり直し（子プロセスごとの停止、Windows で taskkill が使えないときの停止、待ち時間の倍増、最後のもう1周、出力が続く呼び出しは止めないこと、runner の一時停止を沈黙と数えないこと、止まったバージョン確認、準備監査の Ctrl+C）、通信エラー・CLI があきらめた呼び出し・引き取られた接続・確かめられなかったトークン・取れなかったモデルの一覧の分類、
回数・入力累計・修正回数・連続失敗・build-loop既定回数を超える継続、16MiB超のログと中間診断の読取、
巨大本文・巨大1行・Unicode・CRLFの無欠落分割、inventoryの巨大ファイルのモデルなしUNKNOWN、手動中断からの断片再利用、範囲外引用が補正後も残る場合のUNKNOWN完了、同期処理中の生存通知、所有者のいないロックの自動解除、明示的キャンセルを確認します。
モデル応答はテストダブルです。利用者の実プロジェクト・認証済みモデルでの完走時間は未計測です。
