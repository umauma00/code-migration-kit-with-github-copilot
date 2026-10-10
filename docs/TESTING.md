# 検証記録（2026-10-08 JST）

この記録は本Copilot対応版の検証です。元の `RUN-NOTES.md` はAnthropic版の過去の実験で、本版の実績を示すものではありません。

## 実行環境と結果

| 項目 | 結果 |
|---|---|
| OS / Node / Python | Linux x86_64 / Node 24.19.0 / Python 3.12.14 |
| 自動テスト | **57件成功、失敗0、skip 0** |
| 元のPython / JS・TS / C依存解析fixture | edges・順序・cyclesの出力がすべて元の期待値と一致 |
| オフライン変換題材 | Python 3ファイル → JavaScript 3ファイル、用意済みのワーカー応答9回 |
| original | 12ケース成功 |
| 比較器のmutation検証 | 意図的な不具合を12ケース中6ケースで検出 |
| build / smoke | 3モジュール構文検査成功 / 実操作1ケース成功 |
| parity | **12ケース、差分0、skip 0** |
| 実際のCLIの診断（前回確認） | Copilot CLI 1.0.93の起動・version・help・必要なオプションを確認 |

生の結果：[自動テストTAP](validation/automated-tests.tap)、[オフライン実行結果](validation/offline-demo.json)。

## 0.1.3で追加した回帰検証

Astraの指摘A1・A2は親エージェントも実コンパイラで独立再現し、妥当と判断しました。`tests/astra-regressions.test.mjs` に8件追加しました。旧0.1.2に同じテストを適用すると6件が失敗し、修正後は8件すべて成功しました。

- `cc -c FILE` の直接入力を追跡し、`node -c FILE` の変更で古い完了記録と後続承認を無効にすること。
- インラインコードは認識したNode/Python/POSIX shellのエントリポイント前だけを除外し、未知ツールやスクリプトに渡すファイルを読み飛ばさないこと。長いインラインコードも扱えること。
- `buildArtifactRoots` に宣言した生成物を入力へ追加せず、初回・clean buildで入力ハッシュが変わらないこと。
- 生成物を除外しても、実行中に本当の入力を変更したbuildは失敗すること。
- 元ソース・変換後ソース・テスト・明示入力・管理領域等を生成物として宣言できないこと。
- 新しい設定の省略を受け入れ、未知ツールの `-o` の意味を推測しないこと。doctorに入力と生成物の宣言を別々に表示すること。

実Cコンパイラによる修正前・修正後の確認はLinux/GCC 13.3.0で実施しました。通常の自動テストにはCコンパイラを要求しません。詳細は [コマンド検証結果](validation/astra-command-checks.json) を参照してください。

## 0.1.2で追加した回帰検証

再レビュー指摘RR1〜RR3について7件を追加しました。`tests/rereview-regressions.test.mjs` にあります。

- migration内のコマンドと明示設定の変更で、完了状態と承認が失効すること。
- state/results/gates/runs/run.lockを直接の検証入力にすると、工程の実行前に拒否すること。
- node_modules、__pycache__、.git配下の明示変換先が検証中に変更されると、コマンド終了0でも工程結果を失敗にすること。
- Latin-1のPythonソースを、文字化けしてレビューへ渡さず、ファイル名付きのエラーでblockedにすること。
- 非UTF-8のrepair診断も、モデル呼び出し前に同じ検査で拒否すること。
- 有効なUTF-8の日本語・絵文字・BOM・実際のU+FFFDを失わないこと。

## 0.1.1で追加した回帰検証

レビュー指摘R1〜R7とhook契約C1について15件を追加しました。詳細は [修正対応表](REVIEW-FIXES.md) を参照してください。

- 明示した除外ディレクトリ内ソース、ビルドスクリプト、依存設定の変更検出。
- 上流の再実行が失敗・成功した両方で、下流の古い結果・承認を拒否。
- SIGTERMを無視する子孫のheartbeatが、タイムアウト処理完了後に増えないこと。
- 両レビューへの同じ固定入力、他担当の記録除外、CLI/SDKのtoolsなしプロファイル検査、入力超過での停止。
- 隣り合わない親子出力の衝突、失敗時の診断保存、導入後チェック、テスト0件の拒否。
- snake_caseのCLI hook入力でもトップレベルのdenyが出ること。Local出力の両形式。

## 自動テストで確認した範囲

- 非空の未レビュー出力が未完了として扱われること。
- 片方のレビュー失敗後に、完了済みのもう一方を再実行せず再開できること。
- レビュー・裁定記録の削除や破損、出力変更が完了状態を無効にすること。
- 比較器・元ソース・設定の変更で古い承認が無効になること。
- 確認された指摘だけを修正し、変更後の出力を2人で再レビューすること。
- 裁定の欠落、不正JSON、対象パスの偽装、矛盾したレビューを失敗にすること。
- 修正回数とAI呼び出し数の上限、全ワーカー合計の並列数上限。
- ビルド失敗の終了コード保存と次工程の承認拒否。
- 同時実行ロック、中断後の再開、処理中の入力変更、出力の競合時の上書き拒否。
- syntax errorを診断付きrepairでレビュー・修正できること。
- パストラバーサル、重複出力、出力親子衝突、保護対象との重なり、symlinkの拒否。
- 導入のdry run、再実行、既存指示の保持、既存ファイル競合の事前検出。
- シェル展開なしの引数渡し、タイムアウト、中断、出力サイズ制限。
- CLI/Local用hookの入出力変換。実ツール呼び出しによるhook実行は別途確認が必要。
- 疑似SDKコンテキストでの構造化結果・モデル指定・共有エンジン・null応答の拒否。
- 旧Bashビルド経路の非ゼロ終了コード伝播。

## 未確認の範囲

**実アカウントによるCopilotモデル呼び出しは行っていません。** 自動テストのワーカーとSDKはテスト用の応答です。新旧比較・ビルドは実際のPython/Nodeプロセスで実行していますが、モデルの変換能力を評価した結果ではありません。

実CLIでのツール制限・hook起動、アカウントごとのモデル利用可否、VS CodeのUI、Dynamic Workflowsの登録・実行、実際の利用量、大規模な実案件、macOS/Windowsは未検証です。[LIVE-SMOKE.md](LIVE-SMOKE.md) に次の確認手順を記載しています。

## 再現

配布ZIPの展開先で `npm test`、`npm run demo` を実行します。導入先の `migration-kit/` は `npm run check` のみを公開します。外部npmパッケージやCopilot認証は不要です。Node 22以上とPython 3が必要です。

参照した一次資料：[Copilot CLI v1.0.93](https://github.com/github/copilot-cli/releases/tag/v1.0.93)、[ツール制御](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)、[custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration)、[VS Code 1.141](https://code.visualstudio.com/updates/v1_141)、[SDK workflowsの固定参照](https://github.com/github/copilot-sdk/blob/cf245cdf76ced14d2f61dc3d908dd37cf12e0978/nodejs/docs/workflows.md)。
