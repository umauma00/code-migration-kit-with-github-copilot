# オーケストレーターから10工程を順番に進める

日本語 | [English](ORDERED-WORKFLOW.en.md)

[6大段階と内部工程の対応](EXECUTION-SCOPES.md)に沿って、以下の10工程を維持します。
00bは十分な既存judgeを再利用し、早期検証の記録を通す軽量な経路を持ちます。
[準備監査](PREPARATION-AUDITS.md)と[隔離pilot](PILOT.md)を参照してください。
pilotは本番03の完了ではなく、専用の限定許可で実行します。

工程は `00 → 00b → 01 → 02 → 03 → 04 → 05 → 05b → 05c → 06`。
新規設定のphasePolicyはstrict。既存設定は保持し、オーケストレーター開始時に次を実行して
工程記録を有効にする。プラグイン導入ではmigration-kit/を実際のプラグインルートに置換する。

```sh
node migration-kit/scripts/run_migration.mjs phase init
node migration-kit/scripts/run_migration.mjs phase next
node migration-kit/scripts/run_migration.mjs phase start 00
```

親は最初の未完了工程だけを実行する。利用者が後の工程を指定しても、未完了の前提を示して
その工程へ戻る。`phase check ID`は読み取り専用の前提確認。00〜03では `phase complete` と同じ内容（成果物、RULEBOOKの下書き、依存マップ）も確認する。`phase start ID`も前提を確認する。
00〜03の完了は、実際の成果物をレビューした利用者の指示に基づいて記録する。
既に承認された作業は再質問せず、具体的な判断理由をnoteに保存する。

```sh
node migration-kit/scripts/run_migration.mjs phase complete 00 --note "対象範囲と移行判断をレビュー済み"
```

| 工程 | 必要な証拠と通過条件 |
|---|---|
| 00 | feasibility.mdと具体的なレビュー記録 |
| 00b | judge-report.md。runtimeは比較入力とoriginal/mutation/parityの設定、source-onlyは実在するjudge-plan入力。正式judgeは02後 |
| 01 | depmap/report.md、manifest、監査した依存宣言 |
| 02 | gap-report.md、RULEBOOK、inventory、manifest、依存宣言 |
| 03 | 現在のjudge成功とstress-test/report.md、試作結果のレビュー。`phase start 03` には人間が設置した `migration/guardrails.json` も必要 |
| 04 | 実装承認と全単位の有効な独立2レビュー。runnerの記録で判定。`phase start 04` にもガードレールが必要 |
| 05 | 現在の承認付きbuild成功 |
| 05b | 現在の承認付きsmoke成功 |
| 05c | runtimeは実際のparity成功。source-onlyは現在のsmokeを確認し、対象外・同等性未検証の記録を残す |
| 06 | runtimeは現在のpost-parity承認、整理後のhandoff.mdとphase complete 06。source-onlyは実際のhandoff成功 |

工程記録はmigration/phases/に保存する。テンプレートや成果物の存在だけでは完了にならない。
ソース・方式・根拠・前工程の記録が変われば、影響する工程は未完了に戻る。
02の監査で01の依存宣言やmanifestを変更した場合は、01の報告も更新して再確認してから進める。
既存案件は実際の報告を点検し、順番に完了記録を残す。以前の作業を再実行するためだけに
報告を作り直す必要はないが、未検証の工程を通過済みとは記録しない。

正式judgeは02の通過前に拒否され、実装承認とrunnerは03の通過前に拒否される。
build以降は既存の承認・前工程・出力ハッシュの検査を併用する。
source-onlyではsmoke後に次を記録してから06へ進む。

```sh
node migration-kit/scripts/run_migration.mjs phase start 05c
node migration-kit/scripts/run_migration.mjs phase complete 05c --note "source-onlyのため比較は対象外。動作同等性は未検証"
```

<a id="rulebook-amendment"></a>
### 02の後にRULEBOOKを変えたとき（受け入れ）

02の記録の後にRULEBOOKだけが変わった場合、`phase next` は記録し直しではなく受け入れを案内する（上流の規則6：直したルールが関わる部分だけを作り直す）。

```sh
node migration-kit/scripts/run_migration.mjs rulebook changes --format markdown
node migration-kit/scripts/run_migration.mjs rulebook accept --note "変更点と理由" --redo listed
```

- `rulebook changes` は読むだけ。02で記録した版（`migration/rulebook-history/`）との節ごとの差分と、変更行に inventory の構文・分類・シンボルが出てくる完了済みファイルの一覧を示す。どのファイルにも一致しない節も名前を出す。
- `rulebook accept` は人間の判断で、ホストが確認を求める。`--redo` は listed（一覧のファイル）・all・none・ファイルの列挙。工程02・03、承認、ほかの完了済みファイルはそのまま有効で、選んだファイルだけが次の `translate` でレビューし直しになる（出力は残す）。
- RULEBOOK以外（ソース・設定・inventory など）も変わっていれば受け入れられず、今までどおり記録し直す。受け入れは `migration/phases/rulebook-amendments.json` に残り、runnerだけが書く。
- 自動モードでは確認なしで実行し、listed を選ぶ。言葉の一致でファイルが見つからない節は、全部を作り直さず、AI がその節を読んで影響するファイルを足す（一覧が空で訳し済みのコードに影響しなければ none）。判断できないときは止まらずに進み、確かめていない節を状況報告に警告として出す。一覧のファイルを外す選択は実行側が拒否する。

この制御はキットの入口とrunnerに適用する。VS Code自体の任意の編集を禁止する機能ではない。
工程TODOも現在の記録に合わせ、完了を確認できない工程をチェック済みにしない。
利用量の記録は[main形式のcost-log](COST-LOG.md)を参照。

<a id="relaxed-mode"></a>
## 緩和モード（前提が足りないときに「直す／進む」を選ぶ）

工程の進め方は `migration/preferences.json` の `phaseMode` で決めます。最初の設定で1問だけ聞き、
`preferences --phase-mode normal|relaxed|auto`（または run-settings.json の `phaseMode`）で記録します。

| モード | 前提が足りないとき |
|---|---|
| `normal`（推奨・既定） | 今までどおり止まります。失敗時の選択肢の最後に「緩和モードに切り替えて進む」が出ます（推奨にはなりません） |
| `relaxed` | 止まった理由の末尾に `Relaxed mode: ... phase waive ID` が付きます。親は質問ツールで「直す（推奨）／このまま進む」を聞き、「進む」を選んだときだけ `phase waive ID --note "理由"` を実行してからやり直します |
| `auto`（autopilot 向け） | `relaxed` を人に聞かずに進めます。末尾は `Relaxed mode (auto): ...` になり、親は質問せずに工程の作業を続け、作業で埋められない前提だけ `phase waive` で見送ります。下の「自動モード」を参照 |

```sh
node migration-kit/scripts/run_migration.mjs phase waive 03 --note "全体の形を先に見たいので事前試行を見送る"
```

- 見送りは `migration/phases/waivers/ID.json` に、理由と「その時足りなかったもの」と一緒に残ります。`phase waive` はフックが人間の確認を求めます。
- 見送った工程は完了扱いになりません。status の `waivers` と、チェックリストの【見送り】で残り続けます。各工程の報告と最終の引き継ぎ報告に一覧を書きます。
- 見送りで通るのは工程の関門だけです。工程記録（00〜03）、正式 judge・ビルド・smoke の実行記録、変換単位のレビュー（04）、翻訳承認が求める feasibility.md・stress-test/report.md・judge の成功が対象です。
- 緩めないもの：guardrails、保護パス・元ソースの上書き、承認コマンドそのもの（`relaxed` では `approve` は今までどおり人間の確認つき）、サインイン・残高、pilot。
- 後で正規に戻す：見送った工程を普通に終えて記録すると（00〜03・05c は phase complete、04 は全単位のレビューが揃ったとき、05・05b・05c は実行の成功）、見送りは `migration/phases/waivers/retired/` へ移り、二度と使われません。その工程が後で失効したときは、もう一度「直す／進む」を聞きます。工程自身の記録（03 の judge など）を見送りで代わりにすることはできません。見送りの上で作った後続の記録（工程記録・ビルド等の実行記録）は、前提が変わったので記録し直しになります。
- `normal` に戻すと見送りは使われなくなり、見送りの上で作った記録は未完了に戻ります。`relaxed` に戻せば復活します（何も削除しません）。
- モードは設定の指紋（contextHash）に含めません。切り替えても承認やレビュー済みの記録は失効しません。

<a id="auto-mode"></a>
### 自動モード（`auto`、autopilot 向け）

autopilot は確認（フックの ask）を自動で拒否するため、`normal` と `relaxed` では関門で止まります。`auto` はその関門だけを人に聞かずに通します。

- 確認なしで実行できるもの：`approve`（`--complete-phase` 付きも）、`phase complete`、`phase waive`、`build-loop`、`pilot prepare`、`source-spec init --apply`、guardrails が未設置のときのオプションなしの `guardrails install`（テンプレートのまま）。`models set` と `settings apply` は利用者が選んだ内容を記録するだけなので、この案件に対して単独で実行すればどのモードでも確認なしです（`--root` で別の案件を指すときや `--copilot` を付けたときは確認します）。
- 確認なしになるのは、関門コマンドを単独で実行したときだけです（`cd`・`&&`・`;`・パイプ・`$(...)` で他のコマンドとつなぐと確認します）。`--note` に `$` やバッククォートを含めるときは単一引用符で囲みます。
- 今までどおり確認するもの：`sessions prune`（元に戻せません）、`--add`・`--remove`・`--deny`・`--waiver`・`--replace` 付きか既に設置済みのときの `guardrails install`、読み取れない形のキット呼び出し。`guardrails.json` を直接書くことも拒否のままです。
- `auto` に切り替える操作（`preferences --phase-mode auto` と、`phaseMode: "auto"` を含む `settings apply`。後者は確認の理由に自動モードへの切り替えと書かれます）は、どのモードでも人の確認が必要です。`--phase-mode` の値が文字どおりの `normal`・`relaxed` 以外（変数・`$(...)` など）のときも確認します。`auto` から抜ける操作は確認なしです。
- `auto` が効くのは、runner が書く記録 `migration/phases/auto-mode.json` があるときだけです。エージェントがこのファイルを直接書くことはフックが拒否します。`auto` から抜けるとこの記録は `migration/phases/retired/` へ移ります。preferences.json を手で `auto` にしただけでは無効で、関門は緩和モードと同じく確認し、status がその旨を表示します。
- guardrails が未設置なら、03・04・05 の関門でテンプレート（`templates/guardrails.json`）をそのまま設置し、`installedBy: "auto-mode"` を記録します。既にあるファイルは変えません。
- 上流の規則3（承認ゲートで止まる）からの逸脱として、`auto` を選んだ時刻と内容を `migration/phases/auto-mode.json` に残します（RULEBOOK に書くと contextHash が変わり承認が失効するため、別ファイルです）。工程の中で決めた選択を人に聞かずに RULEBOOK に書くことは、上流の規則1（RULEBOOK の変更は人に回す）からの逸脱でもあり、報告の「人の確認なしで決めたもの」に載せます。RULEBOOK がまだ無い 00b・01 で出た選択は、RULEBOOK を書くときに入れます。変換を始めた後は、自動モードでも AI による RULEBOOK の書き換えをフックが拒否します（ルールの変更は利用者が決めるため）。そのときに見つかったルールの問題は、報告に載せて人の判断に回します。
- `auto` で作った工程記録・承認・見送りには `auto: true` が付きます。status は「自動モード：オン」と「自動モードが人の確認なしで記録したもの」を出し、チェックリストでは【自動・人の確認なし】が付きます。見送りと build-loop の許可も一覧に入ります。`normal` や `relaxed` に戻しても一覧は残り、人が完了・承認し直すとその記録は置き換わります（工程を記録し直すと、その上に作った後続の工程も記録し直しになります。費用の記録は増えません）。逆に、人が記録した有効な承認・見送りを `auto` が置き換えることはありません（範囲を指定した翻訳承認と build-loop の承認は、その範囲・回の記録として書き直します）。
- 限界：フックはコマンドの文字列を読みます。ファイルを直接書く手段をすべて見分けられるわけではないため（変数で組み立てたパスなど）、`auto` の記録や承認ファイルの偽造は、普通モードの承認ファイルと同じく完全には防げません。
- 初期設定は手動です。自動モードを選んだ後の初期設定の質問には毎回「自動モードを選択済み・まだ手動・残り◯回ほど」の1行（`setupNotice`）が付きます。初期設定が終わると（仕様が無い場合は source-as-spec への切り替えまで済ませてから）、`autoHandoff` の案内を出して 00 を始める前に止まります。autopilot モードに切り替えて「続けて」と送ると 00 から進みます（切り替えなくても、ある程度は自動で進みます）。切り替え方は Copilot CLI・GitHub Copilot app・VS Code で違い、キットはどのアプリかを判別できないため、案内にはキーや操作の場所を書きません。00 の調査で初期設定の答え（元のコードが動くか、仕様があるか）が違うと分かったときは、理由を書いて止まり、autopilot を解除して対話で決めてもらいます。
- 工程の中でも聞きません。準備監査や独立レビューが `changes` を返したら、1回だけ直して、直した箇所だけを新しい依頼で再監査します（この修正1回の規則はどのモードでも同じです。[準備監査](PREPARATION-AUDITS.md#one-repair-round-all-modes)）。それでも残った指摘、入力上限（`maxReviewInputBytes`）のせいで一部しか見られなかったレビュー、UNKNOWN・引用なしの行は、もう直さずに工程の報告と `phase complete`（または見送り）の note に一覧して先へ進みます。
- ソースからも RULEBOOK からも決まらない選択（移行先の Web 層の方式、ソース以外の資産の出力先など）は、人が先に指定していない限り、いちばん保守的な案を選びます。元の作りにいちばん近く、新しいフレームワークや依存を足さない案です。inventory の survey を始める前なら `TODO(port)` 付きで RULEBOOK に書きます。始めた後は RULEBOOK を変えず（survey の入力と contextHash に含まれるため、変えると survey のやり直しになり、記録済みの工程も失効します）、変換結果に保守的な表現と `TODO(port)` を残します（上流の規則8）。どちらも報告に「人の確認なしで決めたもの」として載せます。方針が決まっているなら、autopilot の前に伝えておけばそれを使います。
- 止まるもの：安全系（保護パス・元ソースの上書き・guardrails の拒否）、サインイン・残高、未記入の実行設定。実行設定は autopilot を始める前に対話セッションで質問に答え、run-settings.json を仕上げて `settings apply` しておきます。
