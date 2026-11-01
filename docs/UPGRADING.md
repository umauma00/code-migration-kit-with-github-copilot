# 更新手順（0.40.1 と以前の版）

日本語 | [English](UPGRADING.en.md)

## 0.40.1（キットの更新で工程 00b〜03 が古くならないように）

0.40.0 でも、工程 00b の判定材料の記録にキット自身のファイルが入っていたため、キットを更新すると 00b〜03 が順に古くなり、記録し直すまで変換を続けられませんでした（RULEBOOK の受け入れも「工程02が古いまま」で拒否されました）。この版で外しました。

1. 0.40.0 から上げると、記録の作り方が変わるため、工程 00b の記録が一度古くなり、続く 01〜03 も順に古くなります。`phase next` は「やり直し」ではなく「確認して記録し直す」と案内します（自動モードでは確認なしで進めます）。工程の作業そのもののやり直しは要りません。完了済みのファイルと承認はそのまま使えます。テストの判定（judge）をもう一度実行するときは、元コードの実行（original・mutation）も一度だけやり直しになります。
2. 0.40.0 より前の版から上げる場合は、下の 0.40.0 の注意（一度だけ全件が再レビュー）がそのまま当てはまります。

## 0.40.0（RULEBOOK の変更とキットの更新で完了済みを残す）

**この版への更新は、移行の途中では行わないでください。** 承認と完了記録の作り方が変わるため、この版に上げるときだけ、既存の承認・完了記録が一度失効し、完了済みのファイルもすべて再レビューになります。移行が終わってから、または次の移行の前に更新してください。

1. 工程02の後に RULEBOOK を変えたときは、`rulebook changes --format markdown` で変更点と、関係しそうな完了済みファイル（inventory の構文・分類・シンボルが変更行に出てくるもの）を確かめられます。`rulebook accept --note "理由" --redo listed|all|none|PATH,...` で受け入れると、工程02・03、承認、完了済みのファイルはそのまま使い、選んだファイルだけを次の `translate` でレビューし直します（ホストが確認を求めます）。受け入れなければ今までどおり、02・03 の記録し直しと全件の再レビューになります。
2. 受け入れの記録は `migration/phases/rulebook-amendments.json` に残り、runner だけが書きます（AI が直接書こうとするとフックが拒否します）。受け入れた後に RULEBOOK をまた変えたら、もう一度 `rulebook accept` します。工程02を記録したときの RULEBOOK は `migration/rulebook-history/` に保存され、差分の比較に使います。
3. プラグインの更新では、承認と完了記録が失効しなくなります（上流と同じ）。完了済みのファイルはそれぞれ、出力・レビュー・判定・末尾行の確認をこれまでどおり受けます。プロジェクト側の `.github/agents`・`.claude/agents`・`.github/hooks`（コピー導入では `.github/extensions` も）は、ワーカーに届くため引き続き入力です。コピー導入でキットを更新するとこれらのファイルも置き換わるので、ワーカーの定義が変わった版では今までどおり失効します。
4. 自動モードでは `rulebook accept` を確認なしで実行します（ほかの承認と同じ）。変換を始めた後は AI が RULEBOOK を書き換えることはなく（フックが拒否）、利用者が書き換えた場合の受け入れだけです。作り直す範囲は listed です。言葉の一致でファイルが見つからない節は、全部を作り直すのではなく、AI がその節を読んで影響するファイルを足します（一覧が空で訳し済みのコードに影響しなければ none）。判断できないときは止まらずに進み、確かめていない節を状況報告に警告として出します。一覧のファイルを外す選択は実行側が拒否し、自動モードで受け入れたことは状況報告に出ます。
5. コピー導入では `migration-kit/` 全体と `.github/skills/` の SKILL.md、`.github/agents/migration-orchestrator.agent.md` を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.39.0（文書の書き直し）

キットのコードは変わっていません。

1. README・ガイド・docs を今の版に合わせて書き直しました。README にあった細かい説明は [詳しい使い方](REFERENCE.md) に移しました。
2. プラグイン導入では、版番号が変わるため既存の承認・完了記録が一度だけ失効し、完了済みのファイルもすべて再レビューになります。文書だけの変更なので、**移行の途中では更新せず**、移行が終わってから、または次の移行の前に更新してください。
3. コピー導入では文書とスキルの案内先が変わるだけで、承認と完了記録は失効しません。`migration-kit/` 全体と `.github/skills/` の SKILL.md を一時導入先の内容に置き換えてください（設定の質問の案内先を README から詳しい使い方に変えました）。
4. 開発時の記録（`history/`・TESTING）はリポジトリから外しました。必要なら GitHub のコミット 0bea302 で読めます。

## 0.38.0（ルールブックの書き換えで全件やり直しにならないように）

**移行の途中では更新しないでください。** キットのファイル（lib・scripts・templates）が変わるため、既存の承認・完了記録は一度だけ失効し、完了済みのファイルもすべて再レビューになります。移行が終わってから、または次の移行の前に更新してください。

1. RULEBOOK のひな形の末尾行の例を `// PORT STATUS: confidence=medium todos=2` にしました。検査は `todos=[2]` のような角括弧付きも同じ数として受け付けるので、**既存の RULEBOOK は直さないでください**（直すと全件やり直しになります）。
2. 判定役（arbiter）の出力例を実際の参照名にし、参照名の書き間違い・抜け・重複は1回だけやり直させてから止めます。
3. 工程01の後に AI が `migration/RULEBOOK.md` を書き換えようとすると、書き換え前の内容を `migration/rulebook-history/` に残します。変換を始めた後は、完了済みの件数を示して利用者に確認を求めます（ホストの確認画面が出ます）。自動モードでは確認画面を出さず（autopilot では表示できないため）、書き換えだけを拒否して「RULEBOOK は変えずに修理で直す」と AI に返し、実行は続きます。読むだけのコマンドや、メモに名前を書くだけでは確認は出ません。スクリプトがファイルを直接開いて書く場合は見えません。
4. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.35.0（autopilot への切り替え案内をどのアプリでも正しく）

キットのファイル（lib）が変わるため、既存の承認・完了記録は一度だけ失効します。`phase next` の `stale` が示すとおり記録し直してください。

1. 自動モードで初期設定が終わったときの案内から、Copilot CLI だけの操作（Shift+Tab）を外しました。今は「autopilot モードに切り替えて「続けて」と送ってください（切り替えなくても、ある程度は自動で進みます）」とだけ案内します。切り替え方は使っているアプリ（Copilot CLI・GitHub Copilot app・VS Code）の操作に従ってください。
2. 案内を出す時機と、00 の前で止まる動きは変わりません。設定の変更も不要です。
3. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.34.0（作業用の会話を専用の記録場所で動かす）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。`phase next` の `stale` が示すとおり記録し直してください。

1. キットが動かす作業用の Copilot CLI は、利用者の `~/.copilot` ではなく、隣の `~/.copilot-migration-kit-workers` を使います。会話の記録が数千件たまった `~/.copilot` の記録 DB（session-store.db）に書き込まなくなり、120秒の詰まりが減る見込みです。
2. サインイン情報・設定・プラグインは利用者のものをそのまま使います（設定ファイルを写し、プラグインなどのフォルダはリンクします）。利用者の会話記録・記録 DB・ログは持ち込みません。
3. 専用の場所で CLI がサインインしていないと言った場合は、その呼び出しを利用者の `~/.copilot` でやり直します。そちらで動けば、そのコマンドの残りもそちらで続けます。止まらず、実行の報告に注意として残ります。
4. 元の動き（全部 `~/.copilot`）に戻すには `migration/config.json` に `"workerCopilotHome": "shared"` を書きます。実行の設定なので、レビュー済みの作業と承認は失効しません。
5. `sessions status`・`sessions prune` は両方の場所を見ます。
6. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.33.0（120秒の詰まりと通信エラーを正しく見分ける）

キットのファイル（lib）が変わるため、既存の承認・完了記録は一度だけ失効します。`phase next` の `stale` が示すとおり記録し直してください。

1. Copilot CLI の「session host did not complete the … event within 120s」（Windows で記録された言い方）を詰まりとして見分け、同じ呼び出しを最大5回やり直します。以前はこの言い方を見分けられず、最初の詰まりでそのファイルを未完了にしていました。
2. 通信エラー（ETIMEDOUT など）のあとに CLI がサインインの案内を出しても、サインイン切れとして実行全体を止めず、やり直します（1回の呼び出しにつき最大5回）。案内も `copilot login` ではなく、やり直しとプロキシ・サインインの確認になります。
3. 設定の変更は不要です。止まった試運転は、更新後に準備からやり直してください。
4. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.32.0（変更なし）

この版での変更はありません。新規導入の `concurrency`（同時に動かすAIの数）を4から1にする変更は、出す前に取り下げました。初期値は4のままです。

それでも Copilot CLI が120秒待って止まることが続くパソコンでは、`migration/run-settings.json` の `concurrency` を下げて `settings apply` で反映します（このファイルがなければ、先に `settings init` で作ります）。実行の設定なので、レビュー済みの作業と承認は失効しません。

## 0.31.0（日本語を選んだらルールブックも日本語）

キットのファイル（lib・scripts・templates）が変わるため、既存の承認・完了記録は一度だけ失効します。`phase next` の `stale` が示すとおり記録し直してください。

1. 報告言語に日本語（ja）を選ぶと、導入時のルールブック（`migration/RULEBOOK.md`）が日本語のひな形（`templates/RULEBOOK.ja.md`）になり、オーケストレーターも説明文を日本語で書きます。コード・識別子・パス・`construct: NAME` などのタグ・`TODO(port):` などのマーカーは英語のまま、書式も変わりません。
2. 既にあるルールブックは書き換えません。ルールを書き込んだ後のルールブックを訳すと、これまでの承認がすべて外れます。今の実行で日本語で読みたいときは、オーケストレーターに要約を頼んでください。
3. 新しく始めるプロジェクトだけが日本語のひな形で始まります。設定の変更は不要です。
4. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.30.0（doctor が終わらないことをなくす）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。`phase next` の `stale` が示すとおり記録し直してください。

1. `doctor` が確認のために起動するプロセスは、1つにつき180秒で打ち切ります（hook の応答確認も含みます）。応答しないプロキシなどで Copilot CLI が答えないと、以前は自動モードで何時間でも待ち続けました。今は「どの確認が・何秒で終わらなかったか」とよくある原因（プロキシ・サインイン待ち・ネットワーク遮断）を出して終わります。移行の作業（変換・ビルドなど）の時間制限は変わりません。
2. CLI に 127.0.0.1 の偽の接続先を使わせる確認は、その CLI にだけ `NO_PROXY` へ `127.0.0.1,localhost` を足します。会社のプロキシ設定があっても、手で `NO_PROXY` を設定する必要はありません。利用者の環境変数は変えません。
3. 設定の変更は不要です。boundedモードで `commandTimeoutSeconds` を180秒より短く明示していれば、その値を使います（長くはなりません）。モデルのツール確認の待ち時間は120秒から180秒になります。
4. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.29.0（変換役にも資料をキットが渡す）

キットのファイル（lib・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。`phase next` の `stale` が示すとおり記録し直してください。

1. 変換・修正役は、規則書・該当する調査表の行・元ファイル・依存先をキットから受け取ります。上限内ならファイルを開く道具なしで動き、上限を超えるときは一覧のファイルだけを読みます。調査表全体を開くことはなくなります。
2. 設定の変更は不要です。上限は従来どおり `maxReviewInputBytes` です。変換・修正役の入力はその分大きくなるので、変換・修正役のモデルもこの量を扱える必要があります（レビュー役と同じ）。boundedモードでは `maxRunInputBytes` に早く達します。
3. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.28.0（CLI 内部の待ち時間切れで止めない）

キットのファイル（lib）が変わるため、既存の承認・完了記録は一度だけ失効します。`phase next` の `stale` が示すとおり記録し直してください。

1. Copilot CLI が「Session host did not acknowledge 'assistant.reasoning' delivery within …」で終わったワーカーは、止めずに自動でやり直します（通常は1回の呼び出しにつき最大5回、boundedモードでは `transientRetries`（既定2回）と5回の少ない方）。この待ち時間（120秒）を延ばす設定は、CLI 1.0.105 とキットを調べた範囲では見当たりません。
2. 5回でも通らないファイルは未完了になります。同じ処理をもう一度動かすか、同時に動かす数（`concurrency`）を減らしてみてください。この変更では承認は消えません。
3. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.27.0（キットを知らない人にも分かる質問）

キットのファイル（lib・scripts・エージェント定義）が変わるため、既存の承認・完了記録は一度だけ失効します。`phase next` の `stale` が示すとおり記録し直してください。

1. 工程 03 の試運転は、先に `pilot plan --sources …`（書き込みなし）で最終のファイル数（選んだファイル＋それらが使っているファイル）を出し、その数で1回だけ許可を聞きます。`pilot prepare --expect-total N` は、範囲がその数と違えば止まります。
2. 質問の書き方の決まり（docs/PHASE-HANDOFF.md）と言い換え表（docs/PLAIN-WORDS.md）が入りました。失敗時の選択肢とサンドボックスの質問は、キットの用語やコマンドを使わない文になりました。
3. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.26.0（古くなった工程記録の理由と次の一手）

キットのファイル（plugin.json・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。今回からは `phase next` が `stale` で理由を示します。この版より前の 02 以降の記録には内訳がありません。記録の後に設定・検証用ファイル・sourceRoots 外のソースが書き換わっていなければキット更新が原因として `record-again`、書き換わっていれば `redo` になります。

1. `phase next`・`phase check`・工程の関門のエラーが、記録の後に何が変わったか（記録したファイル、ソースや設定、前の工程の記録、02 以降は承認済み入力のどの部分か）と、次の一手を示します。`record-again` は記録したファイル・前の記録・キットだけが変わった場合で、その変更だけを確かめて記録し直します（工程全体のレビューのやり直しではありません）。`redo` はソース・設定・コマンド・検証用ファイルが変わった場合で、変わった所の作業をやり直します。実行する `phase complete` のコマンドと、その後に記録し直す工程も出ます。
2. `status --fast` は今までどおりハッシュを計算しませんが、記録の後に書き換わったファイルがある工程に印を付け、`phase next` での確認を案内します。
3. オーケストレーターは `stale.next` に従います。自動モードでは聞かずに記録し直し（または、やり直し）、それ以外のモードでは記録し直しを推奨して1回だけ聞きます。2つの表示が食い違う理由そのものは聞きません。
4. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md、`.github/copilot-instructions.md` のキットの区間を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.25.0（モデルごとのツールの事前確認）

キットのファイル（plugin.json・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 03 の比較試験 B は `stress-b command --dir DIR` が作るコマンドで実行します。そのモデルが持つファイル操作ツールだけを並べます（AI の使用量はかかりません）。
2. `doctor --check-cli` が、ツール付きレビュー担当のモデルに読み取り・検索ツールがあるか、B のモデルに書き込みツールがあるかを確かめます。
3. コピー導入では `migration-kit/` 全体と `.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.24.0（03 の比較試験 B の書き込みと、ローカル sandbox の検出）

キットのファイル（plugin.json・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 03 の比較試験 B のコマンドに `apply_patch` が加わりました。gpt-6-luna など `apply_patch` でしか書けないモデルでも B が書き込めます。途中の 03 はチェックリストの新しいコマンドで B をやり直してください。
   hook も直しました：`apply_patch` による `migration/guardrails.json` の書き換えを拒否し、ツール付きレビューの `grep`・`rg`・`glob`（CLI 1.0.105 では対象を `paths` で渡します）が再び使えます。
2. `doctor` に `commands can write outside the project and use loopback` の確認が加わりました。ローカル sandbox が有効なセッションでは失敗し、`/sandbox off` か sandbox の設定での許可を案内します。キットは設定を変えません。
3. 初期設定中の `settings apply` は、sandbox を見つけると `sandboxQuestion` を返し、工程 00 と autopilot への切り替えの前に聞きます（解消するまで、初期設定中の apply のたびに聞きます）。初期設定が済んだ案件では、03 の前に `doctor` で確かめてください。
4. コピー導入では `migration-kit/` 全体と `.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.23.0（準備レビューの修正は1回まで・生成コードと方針の事前確認・phase next の高速化）

キットのファイル（plugin.json・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 00b〜02 の準備監査・独立レビュー（source-as-spec の仕様一式レビューを含む）は、どのモードでも修正1回までになりました（フォーク元と同じ）。指摘をソースで確かめて直し、直した箇所だけを1回だけ再レビューします。
2. それでも残った指摘はもう直しません。inventory の行は UNKNOWN（最も保守的な訳と TODO(port)）になり、それ以外は judge-report.md や depmap/report.md に未解決として残ります。工程の報告に、直した指摘・残った指摘（根拠つき）・UNKNOWN にした行（件数つき）が載り、進むか直すかは工程の確認で決めます（自動モードでは同じ一覧を記録の note に書いて先へ進みます）。
3. 02 の RULEBOOK と inventory の合同監査は、修正後にやり直しません（フォーク元と同じ）。手書きの依存グラフの抜き取り監査は今までどおり最大3ラウンドです。
4. 02 の inventory 調査の前に `preparation_cli.mjs generated-files --write` と `policy-questions` を実行します。生成コードの箇所はモデルを呼ばずに GENERATED の行になり、件数だけを報告します。移行では普通のコードとして訳し、人が移行先の生成手段を決めたものだけ再生成します（生成先ができるまでビルド承認が止まります）。方針の質問はまとめて1回聞き、`policy-record` で RULEBOOK の管理区間に記録します（自動モードは最も保守的な案）。
5. 全体の調査の前に `rulebook-coverage --sites PATH` と `survey run --kind inventory --sites PATH --trial 3` で、規則のない構文と UNKNOWN の多い構文を先に決められます。調査済みのプロジェクトでは、RULEBOOK を変えると inventory 調査はやり直しになります。
6. `phase next` と `status` が大きいプロジェクトで速くなりました（設定の変更は不要です）。
7. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md、`.github/copilot-instructions.md` のキットの区間を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.22.0（キット全体の AI 使用量）

キットのファイル（plugin.json・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. ワーカー呼び出しごとの使用量が `migration/runs/usage/calls.jsonl` に記録され、`usage --format markdown` でキット全体の合計を見られます。記録はこの版から始まるため、以前の呼び出しは含まれません。
2. survey の実行要約に `measuredUsage` が入り、cost-log.tsv の survey 行の `tokens` が埋まるようになりました。
3. コピー導入では `migration-kit/` 全体と `.github/skills/` の SKILL.md を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.21.0（固定レビュー入力の既定上限を 1 MiB に）

プラグインでは版番号が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. 新規導入の `maxReviewInputBytes` は 1048576（1 MiB、目安で約26万〜36万トークン）です。既存の `migration/config.json` は変わりません。
2. 既存の案件で上げる場合は `migration/config.json` を書き換えます。設定の指紋に含まれるため、02以降の記録と承認は確認し直しになります。レビュアーのモデルの `models list` の「コンテキスト（入力上限）」がこれより小さい場合（例：272K）は、その上限に収まる値（272K なら 655360 以下）に下げてください。固定入力がモデルの入力上限を超えると、その呼び出しは送り切れずに失敗します。
3. コピー導入では `migration-kit/` 全体を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.20.0（設定の記録で確認を出さない）

キットのファイル（plugin.json・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. `models set` と `settings apply` は、単独のコマンドならどのモードでもホストの確認（Hook approval）が出なくなりました。利用者が質問への答えやファイルで選んだ内容を記録するだけだからです。自動モードへ切り替える内容の `settings apply` と、他のコマンドとつないだ場合、`--root` で別の案件を指す場合、`--copilot` を付けた場合は今までどおり確認します。
2. 自動モードでは `pilot prepare` と `source-spec init --apply` も確認なしで進みます。確認が残るのは `sessions prune`（元に戻せない削除）、自動モードへの切り替え、オプション付きまたは設置済みのときの `guardrails install`、読み取れない形のキット呼び出しです。
3. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md、`.github/copilot-instructions.md` のキットの区間を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.19.0（長時間コマンドの進捗表示を統一）

キットのファイル（plugin.json・scripts）が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. `translate`・`repair`・`repair-round`・`build-loop`・`pilot run`・`survey run` は、すべて同じ方法で動かします。コマンドだけをバックグラウンドのターミナルで起動し、`status --root 対象 --wait 600 --format markdown` で進捗を確認します。`| Out-String` などのパイプやファイルへのリダイレクトは、終わるまで進捗を隠すため hook が拒否します（`2>&1` だけなら使えます）。
2. 進捗行は `14:03:45 [3/12] src/a.cs: review (agent calls 14)`（時刻・この実行の完了数/全体・単位・段階・AI 呼び出し数）の1形式になりました。止まった単位は `blocked` の行ですぐ表示されます。
3. コピー導入では `migration-kit/` 全体と、`.github/agents/migration-orchestrator.agent.md`、`.github/skills/` の SKILL.md、`.github/copilot-instructions.md` のキットの区間（`code-migration-kit:start` から `end` まで）を一時導入先の内容に置き換えます。プラグインは更新だけで入ります。

## 0.18.1（配布元を main に）

動作は変わりません。プラグインでは版番号が変わるため、既存の承認・完了記録は一度だけ失効します。judgeから再検証してください。完了済みの出力は保持されます。

1. キットがリポジトリの既定ブランチ（main）に入り、マーケットプレイスの登録元が `umauma00/code-migration-kit-with-github-copilot`（ブランチ指定なし）になりました。
2. 以前の案内どおり `#feat/github-copilot-migration-kit` 付きで登録したままでも、そのブランチが残っている間は入れられますが、今後の更新は main に入ります。切り替える場合は、先に `copilot plugin marketplace remove code-migration-kit-marketplace --force` で外してから、[PLUGIN.md](PLUGIN.md) の登録元で追加し直してください（同じ名前の登録が二重にならないようにするため）。
3. コピー導入の文書から `history/` の記録へのリンクは既定ブランチを指すため、main に入ったことでリンク切れが解消します。

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
詳細は[今回の対応表](https://github.com/umauma00/code-migration-kit-with-github-copilot/blob/0bea302/history/plans/2026-10-15-review-implementation.md)を参照してください。

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
