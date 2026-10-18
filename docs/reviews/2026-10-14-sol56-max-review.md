# GPT-5.6 Sol（max）による互換性レビュー

> アーカイブ：0.3.0で削除したnative（VS Codeサブエージェント）ワーカー方式を扱う記録です。
> 参照先の `docs/NATIVE-WORKERS.md`、`lib/native-workers.mjs`、`tests/native-workers.test.mjs` は現在存在しません。

2026-10-14。GPT-5.6 Sol、推論強度maxのサブエージェントが独立にレビューし、
親エージェントも以下の根拠を照合した。
対象は `feat/github-copilot-migration-kit` の現在の未コミット変更を含む実装と、
[直前の互換性調査](2026-10-14-host-model-compatibility.md)。
今回はレビューと調査資料の訂正までで、実行コード・プロンプトは修正していない。

## 指摘

### P1：Localの標準経路ではnativeのモデル確認を完了できない

[共通スキル](../../skills/code-migration/SKILL.md#L74)と
native手順（`docs/NATIVE-WORKERS.md`）は、ホストの実行メタデータで
モデルを確認してから提出することを要求する。
しかし公開VS Code mainの
[runSubagentTool.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/tools/builtinTools/runSubagentTool.ts#L423)
はモデル名を `toolMetadata.modelName` に保持し、親へ返す本文は子の回答だけにする。
[toolCalling.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/toolCalling.tsx#L492)
も親モデル向け本文を `toolResult.content` から生成する。
キットには、このメタデータをnativeタスクへ結び付けて取得する接続がない。

標準の親AI経路で手順を守れば、結果を提出できず失敗・タイムアウトになり得る。
要求モデルの転記で提出しても、Nodeの比較（`lib/native-workers.mjs`）は
申告文字列の一致しか検査しないため、実モデルの確認にはならない。
[cost集計](../../lib/pipeline.mjs#L235)も `hostReportedModel` を使用するため、
親による確認のない転記値を実績として残してはいけない。

[doctor](../../scripts/run_migration.mjs#L50)はこの能力を調べず、native host contractを
`ok: true` とする。live検証が必要という注記はあるが、ホスト能力の確認済み表示とは分ける必要がある。

修正候補は、タスクIDとホストのモデル情報を結ぶ接続、および開始前の能力確認。
取得できないホストではrunner開始前に理由を示して止める。
Localの所見は公開mainのコード確認であり、利用者のインストール済みVS Codeでの再現ではない。
Copilot Agent Hostにはモデルイベントがあるが、親AIの取得経路は未確認であり、
同じ失敗が起きるとは断定しない。

### P2：Localのモデル名形式と提出時の比較が整合しない

[設定](../../templates/migration-config.json#L15)の各役の文字列は、そのままホストへ渡される。
LocalはCLI IDではなく表示名または `Model Name (Vendor)` で検索する
（[languageModels.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/languageModels.ts#L384)）。
返却モデル名は表示名単体だが、submit（`lib/native-workers.mjs`）は要求文字列との
完全一致を求める。

CLI用IDでは検索に失敗する環境があり、修飾名で起動に成功しても表示名の提出が拒否される。
具体的なモデル表示名での実機再現は未確認。
ホスト別に要求値・解決したモデルID・表示名・vendorを区別し、既知の対応だけを使って照合する。
大文字小文字の変換や推測したaliasで一致させない。

### P2：CLI用の5プロファイルにある資料リンク10個が壊れている

[implementer](../../com.github.copilot/agents/code-migration-plugin-implementer.agent.md#L9)、
reviewer-semantics、reviewer-rules、arbiter、fixerの9–10行目は、
`../../../docs/OPERATING-MANUAL.md` / `../../../docs/CONTRACTS.md` を参照する。
プロファイルのディレクトリから解決するとリポジトリ外を指し、存在しない。
正しい `../../docs/...` の10対象がすべて存在することを親も確認した。

reviewerでは人向け資料のリンクで、応答契約もinlineなので影響は限定的。
implementer・arbiter・fixerには資料を読む指示があり、参照に失敗する可能性がある。
5ファイルのリンクを修正し、配布対象の相対リンクを検査する。
この問題だけでモデル指定そのものが壊れるとは判定しない。

### P2：新規strict案件による03のpilotに、循環しない手順がない

[03の指示](../../prompts/03-stress-test.md#L26)は、同じprofiles/runtimeの使い捨て案件で
pilotを行い、その結果を03の報告へ含める。
ところが[新規設定](../../templates/migration-config.json#L7)はstrictで、
pilot案件自身の[実装承認](../../lib/pipeline.mjs#L61)にはreview済み03が必要。
通常のinstallerで任意のpilot案件を新規に用意すると、pilot結果を得る前に
その結果を含む03のレビューが必要になる。

すべてのpilotが不可能という意味ではない。
[LIVE-SMOKE](../LIVE-SMOKE.md#L15)のdemo setupは
[demo](../../scripts/demo.mjs#L16)から[test helper](../../tests/helpers.mjs#L18)を呼び、
`phasePolicy: legacy` に変更するため動く。
ただし任意のrisk-weighted pilotで同じlayout/backendを使用する正式手順にはなっていない。

本番のstrict制御を維持し、pilot専用の設定・限定承認・実行経路を設ける。
使い捨て案件の作成とreceiptの分離を明文化し、試作記録を本番へ流用しない。

## 調査資料の訂正と結論

- `modelPolicy: required` は、指定モデルを使えないときに代替せず起動を拒否する設定。
  フォールバックの条件として読める説明を訂正した。
  これを追加するだけでLocalのモデル名形式やメタデータ取得が解決するわけではない。
- CLI 1.0.95で確認した範囲は、フラグ仕様の一致・プラグイン登録・11 IDの列挙。
  プロファイル、ツール制限、モデル指定、JSON応答がプロバイダーまで適用されるところは
  確認できていない。調査表の判定をこの範囲へ限定した。
- native方式では、利用者が別途standalone Copilot CLIを導入する必要はない。
  VS Code Copilot内部のSDK・同梱runtimeへの依存とは区別する。
- 5役割のモデル設定は存在する。01・02等の工程別モデル・任意エージェント選択は未実装。
- `tools: []` がnested subagent設定で破られるという途中候補は撤回した。
  追加確認でenablement mapが全ツールをfalseにし、再有効化されないことが判明したため、
  確定指摘には含めない。

## 検証範囲

このレビューでは実AI、認証済みモデル、VS Code UI、外部モデルへのソース送信を使っていない。
既存の関連30/30テスト成功は固定応答によるもので、理由なく再実行していない。
CLI 1.0.95は監視資源上限でプロバイダー要求0件。
CLI 1.0.93の既存疑似プロバイダー成功も全役同じモデルであり、異なる5実モデルの証明ではない。
OSのinotify確認は会話中の観測で、生ログはvalidation artifactに残っていない。

親は各指摘の対象コード・公開ソース・リンクの解決先を照合し、資料訂正後に
`git diff --check` と新規レビュー資料の相対リンクを確認した。
