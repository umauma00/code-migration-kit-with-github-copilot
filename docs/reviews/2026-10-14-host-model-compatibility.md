# VS Code / Copilot CLIのモデル・専用ワーカー互換性調査

2026-10-14。対象は `feat/github-copilot-migration-kit`、HEAD
`e700c604bea0d867a729efa0b7102b1df00e99f6` と現在の未コミット変更。
今回は調査であり、実行コード・プロンプトは変更していない。

## 判定

「実装・レビュー2種・裁定・修正の5役割にモデル設定と専用プロファイルがある」は正しい。
「VS Code / CLIで、そのモデルが実際に使われるところまで確認済み」という意味ではない。

| 実行経路 | 判定 | 確認したこと / 残る条件 |
|---|---|---|
| Copilot CLI、`workerBackend: copilot-cli` | 使用フラグは公式仕様と一致。登録とID列挙を確認。実行時の適用・通信は未確認 | 各役割で `--agent` / `--model` を渡す。CLI 1.0.95でプラグイン導入と専用IDの列挙を確認。プロファイル・ツール制限・モデル指定がプロバイダーへ適用される前に監視資源上限で停止。認証済み実モデルは検証していない。 |
| VS Code Copilot（Agent Host）、`nativeHarness: copilot` | 条件付き。実機未確認 | SDKランタイムには呼び出し単位のモデル指定がある。ただしキットは親AIに委譲を指示する方式。親が実際のモデル引数と実行メタデータを利用できるかは未確認。 |
| VS Code Local、`nativeHarness: vscode-local` | 指定は可能。実モデル確認の接続が不足 | `runSubagent.model` は存在する。標準の親AI向け返却内容にはモデル情報が含まれず、現在の確認・提出条件を確実に満たすための接続が必要。親モデルのコスト帯による制限もある。導入形態はコピー。 |
| 01・02等の調査工程 | 両ホストとも工程別設定なし | 工程別モデル、任意のレビュー担当を選ぶ設定は未実装。5役割の設定は変換・修正パイプライン用。 |

VS Codeの利用者側のSession Targetとバージョンは不明なため、CopilotとLocalの両方を調査した。
公開 `main` のソース確認は、利用者のインストール済みバージョンでの実行確認とは区別する。

## 現実装の経路

[設定テンプレート](../../templates/migration-config.json)の `models` は
`implementer`、`reviewer-semantics`、`reviewer-rules`、`arbiter`、`fixer` の5キー。
専用エージェントは固定の役割別プロファイルで、任意のエージェント名を設定する項目はない。
2種のレビューは同じ固定入力を受け取り、他方の指摘を受け取らない。
裁定・修正は指摘が発生した場合に呼ばれる。

### CLI

[CLI adapter](../../scripts/copilot_adapter.mjs)は `config.models[role]` を読み、
役割ごとに新しい `copilot` プロセスへ `--agent` / `--model` を渡す。
これはCopilotの親セッション内の `task` サブエージェント起動とは異なる。
`--no-custom-instructions`、機械出力、役割別ツール制限も渡す。
レビュー担当は `tools: []`、実装・裁定・修正は `view,grep,glob` のみ。

指定値は `requestedModel` として残るが、CLIイベントから実モデルを抽出・照合する
処理はなく、`observedModel` はnull。指定の送信と実モデルの検証は区別する必要がある。
後述のCopilotサブエージェントのフォールバック仕様を、そのままこの新規CLIセッションの
`--model` の挙動に当てはめてはいない。

### VS Code native

[native transport](../../lib/native-workers.mjs)はタスクファイルを発行し、
親が `list → claim → ホストの委譲ツール → submit` を処理する。
NodeからSDKやVS Code APIを呼び出す自動接続はない。
[運用手順](../NATIVE-WORKERS.md)は、実際のモデル引数で指定し、ホストの実行メタデータを
確認し、確認できなければ失敗として提出するよう要求している。

`submitNativeTask` は提出されたモデル文字列と要求文字列の一致を検査するが、
その文字列が本当にホストの実モデルかを独立に検証しない。
結果は `hostReportedModel` として保存し、`observedModel` はnullのまま。
専用nativeプロファイルは全5役 `tools: []` で、`model` の固定値は持たない。

## 見つかった実行上の不足

### 1. Localでは、標準のツール結果だけで実モデルを確認できない

VS Code公開ソースの
[runSubagentTool.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/tools/builtinTools/runSubagentTool.ts)
には `model` 入力とモデル解決がある。
返却値の `content` は子の回答のみで、解決したモデル名は別の `toolMetadata.modelName` に入る。
UI用の `toolSpecificData` にもモデルID・名前が記録される。

一方、Copilot拡張の
[toolCalling.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/toolCalling.tsx)
は親AI向けの `ToolMessage` を `toolResult.content` から生成する。
`toolMetadata` はモデルに見せる本文に追加されていない。
拡張内部にメタデータが存在することと、親AIがツール結果からそれを読めることは別である。

現在のキットには、このメタデータをタスクIDに結び付けて親やNodeへ渡す機能がない。
追加のログ取得や拡張による接続がない標準経路では、「実モデルを確認してsubmit」という
要求を確実に実行できない。手順を守れば失敗・待ち時間切れになり得る。
要求モデルの転記で通過させても、実モデル確認の代わりにはならない。

### 2. Copilot Agent Hostのモデル情報はあるが、親への公開経路は未確認

[Copilot Agent Hostのソース](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/copilot/copilotAgentSession.ts)
では `subagent.started` / `subagent.configured` 等のイベントからモデルを取得し、
`ChatUsage` として公開する。
したがって「ホストにモデル情報がない」とは結論しない。
ただし、このUI・ホスト用情報を親AIが使えるツール結果として得られることまでは
確認できていない。現在のキット側にも専用の取得・転送機能はない。

[Copilotの公式仕様](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#custom-agent-frontmatter-fields)
では、`task` またはSDKでのサブエージェント起動に、呼び出し単位のモデル指定がある。
指定が実現できない場合は通常、親モデルへフォールバックする。
エージェントが `modelPolicy: required` を宣言している場合は、代替せず起動を拒否する。
現在のnativeプロファイルにはこの宣言がないため、引数を渡しただけで
実モデルの一致を保証してはいけない。
この仕様はランタイム能力の根拠であり、各VS Codeホストの親AIに同じ引数や
メタデータ取得手段が公開される証明ではない。

### 3. モデルの表記とLocalのコスト帯制限

Localのモデル検索はCLIのIDではなく表示名・修飾名を使う。
[languageModels.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/languageModels.ts)
の `matchesQualifiedName` は、Copilotモデルなら表示名単体、または
`Model Name (Vendor)` と照合する。CLI用の `gpt-4.1` 等をそのまま渡すと、
表示名が一致しない環境ではモデルが見つからない。

また、修飾名で要求してモデル名単体が返ると、現在のsubmitの文字列比較は不一致になる。
表記を実モデルIDへ正規化する処理はない。これは実ホストでの再現確認ではなく、
ホストの返却形式とキットの比較方式を照合した互換性上の問題である。

[VS Code公式仕様](https://code.visualstudio.com/docs/agents/run/subagents#select-the-model-for-a-subagent)
には、Localで親モデルより高いコスト帯のモデルを明示指定すると実行が拒否されるとある。
したがって安い親モデルから高いレビュー用モデルを呼ぶ配分は、Localでは常に可能ではない。

## 検証した範囲

- 関連テスト：`node --test tests/native-workers.test.mjs tests/copilot-compatibility.test.mjs`、
  **30件成功、失敗0**。固定応答による並列実行、独立レビュー、裁定・修正、
  モデル不一致の拒否、CLIへの無断切り替え防止、JSON転送等。実AIは起動していない。
- CLI **1.0.95**：マーケットプレイス導入と、orchestrator・CLI用5役・native用5役の
  合計11IDの認識を確認。存在しないエージェントを指定してセッション開始前に停止させる
  検証で、外部AIは使っていない。
- 既存の[CLI 1.0.93の検証記録](../validation/copilot-cli-1.0.93-local-provider-2026-10-10.json)
  は、ローカル疑似プロバイダーとの変換・独立レビュー・再開の成功を示す。
  全役 `gpt-4.1` を使っており、5役それぞれに異なる実モデルを割り当てた証明ではない。
- 今回の1.0.95通信検証は `Failed to register MCP configuration watches:
  Too many open files (os error 24)` で停止。固定ダミー入力、空の使い捨て案件、
  認証情報なし、ループバックの応答サーバーに限定した代替検証でも同じエラーとなり、
  プロバイダーへの要求は0件だった。
- OSで単一の `inotify_init1` も同じエラーになり、CLIのセッション開始前の
  監視資源上限が原因と確認した。キットの並列数を原因とは判定しない。
  このOS確認の生ログはvalidation JSONへ保存していないため、会話中の観測として扱う。
- VS Code UIはこの環境にない。利用者の実VS Code上でのモデル選択、親が読める
  実モデル情報、実ツール制限、認証済みモデルでの移植品質は未検証。

初回の既存通信テスト後、その再実行は自動承認審査で拒否された。
理由は「テスト対象のソース・設定がGitHub/Copilotへ送られる可能性があり、
その具体的な送信は承認されていない」ため。既存テストの再実行は行わず、
審査が示した固定ダミー入力での安全な代替検証を実施した。

子プロセスの出力が空になる既定サンドボックスでは関連テスト2件が失敗したが、
子プロセスを正常に実行できる許可付き環境では上記30件すべてが成功した。
この許可付き実行もテスト用応答のみで、外部モデルは利用していない。

## 次の修正に必要な条件

1. VS Codeのホストごとに、実モデル情報をタスクに結び付けて取得・提出する接続を作る。
   利用できないホストは、runner開始前に理由を明示して止める。
2. 要求値・ホストの名前・実モデルIDを区別し、既知の対応だけを正規化して照合する。
   Localの利用可能モデルとコスト帯制限も開始前に確認する。
3. CLIでも実モデル情報を取得できる場合は記録・照合する。
   各役で異なるモデル指定、利用できないモデル、ホストの代替モデルを検証する。
4. 実VS CodeのCopilot / Localと、通常環境のCLIで、まず1ファイルの起動・独立レビュー・
   結果提出を確認する。01・02の工程別モデル・任意レビュー担当は別の未実装機能として扱う。

この調査に基づく修正はまだ行っていない。

2026-10-14、[GPT-5.6 Sol（max）の独立レビュー](2026-10-14-sol56-max-review.md)で
検証範囲を再確認し、`modelPolicy: required` の説明とCLI判定の表現を訂正した。
実行コードは変更していない。nativeで不要なのは利用者が別途導入するstandalone CLIであり、
VS Code Copilot内部のSDK・同梱ランタイムへの依存がなくなるという意味ではない。

## 根拠

- [VS Code subagents](https://code.visualstudio.com/docs/agents/run/subagents)
- [VS Code harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses)
- [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [今回のCLI認識・ダミー通信結果](../validation/host-model-compatibility-2026-10-14.json)

公開ソースは2026-10-14に取得。取得内容のSHA-256先頭16桁：
`runSubagentTool.ts=4626b45ffd3d7ad1`、`languageModels.ts=122ece9c1b8b9af5`、
`toolCalling.tsx=f7f65371d1b47c6c`、`copilotAgentSession.ts=0bb4ab7b06af1550`。
