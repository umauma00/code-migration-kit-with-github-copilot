# Copilot互換性の修正 — 2026-10-10

0.1.4で [互換性レビュー](2026-10-10-copilot-compatibility.md) の3件を修正した。

| 指摘 | 修正 |
|---|---|
| CLIテキストstdoutが長いJSON文字列を破損 | --output-format jsonのJSONLを解析。最終の主agent応答と正常な末尾resultを必須とし、子agent、未完tool、異常・切断を成功扱いしない |
| 全元ソースとinventoryで固定入力が上限を超過 | 必須の監査済みreview-dependencies.jsonから推移的閉包を取得。該当inventory行・全体注記・RULEBOOK全文・1候補を同じJSONで2reviewerへ渡す。欠損はエラー。静的入力を実装・修正前にも検査 |
| read/search aliasで検索ツールが落ちる | implementer/fixer/arbiterのprofileをview/grep/globへ統一。reviewerはtools: []を維持 |

依存宣言はimport解析だけでなくinventoryのevidence等に必要な意味上の参照も監査する。生成器はsource-root内の孤立ファイルも列挙するが、監査を代替しない。mapと明示依存はcontextHashへ含め、変更で承認・完了が失効する。各reviewerへの全ソース投入を除去した一方、全ソースの走査・hash追跡は維持した。

GPT-6 Astraによる方針レビューを実施し、最終主agent応答の判定、孤立ノード、inventoryの完全一致と行検査、JSON直列化サイズでのpreflight、全体走査を残す制限を反映した。実装結果と最終追加変更も同じGPT-6 Astraが独立レビューし、重大な欠陥なしとして承認した。Astraは最新の互換性テスト14件を独立実行し、14成功・0失敗・0skipを確認した。全71件と実CLI通信は親エージェントの検証であり、Astraはその通信記録と再現スクリプトを照合した。

検証はmacOS arm64、Node 25.9.0、Python 3.13.13で実施した。自動テスト71件成功、失敗0、skip 0。tests/copilot-compatibility.test.mjsに14件を追加した。オフラインデモも3/3単位、build/smoke成功、parity12ケース・差分0・skip 0。

疑似プロバイダーへ接続した実Copilot CLI 1.0.93で3単位・9呼び出しが完了。各候補のコードが固定応答とbyte単位で一致し、独立レビュー2件ずつ、build/smoke成功、parity12ケース・差分0・skip 0、再実行0呼び出しを確認した。追加のarbiter/fixerを含む全5役について、providerへ提示されたtoolsを検査した。実装・修正・裁定はview/grep/glob、reviewerは空配列だった。

手元のCLIランチャーも検証時はキャッシュされた1.0.93を選択した。ランチャーのファイル名から旧版1.0.40の成功とは判定していない。別途、既存キャッシュの1.0.40/app.jsをNodeから直接起動して版を固定し、同じ全工程・全5役のtools・再実行0呼び出しを確認した。1.0.40/index.jsを通常Nodeで起動した試行はワーカーがタイムアウトしたため成功としていない。主な対応検証は1.0.93、旧版の追加検証は1.0.40のapp runtimeであり、旧版ネイティブランチャーの再検証とは区別する。

生の検証記録: [自動テスト](../validation/copilot-compatibility-tests-2026-10-10.log)、[オフラインデモ](../validation/copilot-offline-demo-2026-10-10.log)、[実CLI 1.0.93と疑似プロバイダー](../validation/copilot-cli-1.0.93-local-provider-2026-10-10.json)、[旧1.0.40のapp runtime](../validation/copilot-cli-1.0.40-runtime-local-provider-2026-10-10.json)。

実AIの移植品質、実アカウントの認証・モデル利用可否、VS CodeのUI、Dynamic Workflowsの実セッション、Windowsは未検証。[更新手順](../UPGRADING.md) と [実アカウント確認](../LIVE-SMOKE.md) を参照。

通常テスト: npm test / npm run demo。
実CLI通信の再現: node tests/verify_cli_transport.mjs /absolute/path/to/copilot。
後者はループバックHTTPと一時CLI設定を使い、固定応答で3ファイルを処理する。外部AIを呼ばず、providerへ提示されるtoolsも検査する。終了後に一時ディレクトリを除去する。

出力契約と子agent識別の参照: [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)、[SDK session event schema](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts)。
