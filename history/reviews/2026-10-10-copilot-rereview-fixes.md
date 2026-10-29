# 0.1.5 — 再レビュー3件の修正と確認

2026-10-10の再レビューで見つかった3件を修正した。GPT-6 Astraへ修正方針と実装結果をそれぞれ独立レビューしてもらい、3件の解消と、確認範囲で新たな実害のある回帰がないことを確認した。

| 指摘 | 修正 | 確認結果 |
|---|---|---|
| P1: AGENTS等の暗黙指示が固定レビュー入力とhashの外から混入する | 全5役割に `--no-custom-instructions` を必須指定。doctorも対応を検査。workflowのワーカーも同じCLI adapterを使用 | 実CLIの正の対照で読み込まれるroot・祖先・個人・リポジトリの4種の指示が、修正後の全役割で混入しない。明示profileとtool集合は維持 |
| P2: 先頭BOMの直後にコメントがあるinventoryをヘッダーと誤認する | inventoryのファイル先頭BOMを、コメント・空行・ヘッダー分類の前に一度だけ除去 | BOM＋注記、BOM＋空行＋注記、BOM＋ヘッダーを受け入れ、両レビューへ同じ内容を渡す。途中のBOMによる不正ヘッダーは引き続き拒否 |
| P2: stock parserのrepo-root相対edgesを生成器が扱えない | 列挙するsourceRootsとparserのdepmapRootを分離。解析ルートの `.`、複数ソースルートを許可 | 標準Python解析器の `pkg/a.py → pkg/b.py` を二重prefixせず変換。孤立ノード、複数ルート間依存、対象外edgeの報告、必要な範囲外依存の拒否、失敗時の既存map保持を確認 |

## 指示とworkflowの契約

`tools: []` だけではCLIのsession agentへの自動指示注入を止められないため、全ワーカーを新しいCLIプロセスで起動し、暗黙指示を無効にした。[GitHubのCLI仕様](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)にあるフラグを実際のprovider requestでも検証した。役割プロファイルとランナーの応答契約は引き続き適用される。案件の移植方針は、承認対象のRULEBOOK/inventoryへ取り込む。

実験的workflowはSDKで工程を登録し、ワーカーを通常CLIと同じアダプターから起動する。参照SDKの `WorkflowAgentOptions` には暗黙指示を無効化する呼び出し単位の設定がないため、`ctx.agent` を使う経路を廃止した。SDKのdurable agent resultとschema retryを使わず、ランナーの記録、JSON検証、concurrency・maxAgentCalls・timeoutSeconds・キャンセル伝播を使う。実行ファイルはworkflow argsの `copilot` で選択できる。詳細は [Dynamic Workflows](../../docs/DYNAMIC-WORKFLOWS.md) を参照。

root AGENTSを変えても自動ワーカーの入力は変わらない。RULEBOOK、役割プロファイル、依存宣言等の明示入力と実行コードの変更は従来どおりhashで検出する。更新後は古い承認を再利用せず、[更新手順](../../docs/UPGRADING.md)に従って再検証・再承認する。

## 依存マップ生成

stock Python parserがリポジトリルートを解析した場合は、`--source-root pkg --depmap-root .` を指定する。複数ソースルートなら `--source-roots pkg,shared --depmap-root .` とし、config.sourceRootsも合わせる。解析対象が広くても、列挙は選択したソースルート内だけに限定する。

対象外ファイルから始まる辺（tests → pkg等）は `ignoredEdges` に列挙して除外する。対象内から範囲外へ出る必要な依存は停止し、必要なソースルートの追加を求める。全edgeのpath構文・symlinkを検査し、対象内edgeの実在性も検査してから一度だけ出力する。生成物は草案なので、解析器の対応範囲・未解決import・除外・意味上の参照は案件ごとに監査する。

## 検証

- 自動テスト: **78成功、0失敗、0skip**。追加した7件をAstraも独立実行し、7成功を確認。[全テストの記録](../validation/copilot-rereview-tests-2026-10-10.log)。
- オフラインデモ: 3ファイル完了、build/smoke/parity成功、parity **12ケース・差分0・skip 0**。[記録](../validation/copilot-rereview-demo-2026-10-10.log)。
- 実CLI 1.0.93: macOS arm64 / Node 25.9.0 / loopback疑似provider。通常CLI経路とworkflow関数経路の双方で、指示canaryの正の対照、全5役割の指示遮断・profile/tool確認、3ファイル9呼び出し、候補の完全一致、build/smoke/parity成功、再開時0呼び出しを確認。[通常CLIの記録](../validation/copilot-rereview-cli-1.0.93-2026-10-10.json)、[workflow workerの記録](../validation/copilot-rereview-workflow-1.0.93-2026-10-10.json)。
- この環境にあったCLI 1.0.40のcached app runtimeをNodeで直接実行した確認でも、同じ4種の指示の対照・遮断、全5役割のprofile/tool確認、3ファイル9呼び出し、parity差分0・再開0呼び出しが成功した。native loaderの検証とは区別する。[記録](../validation/copilot-rereview-cli-1.0.40-runtime-2026-10-10.json)。

通信試験は外部AI・実アカウントを使わず、疑似応答で実行経路と入力を検証した。workflowのホストSDK contextは模擬で、ワーカーのCLIは実物。実AIによる移植品質、Copilot認証、VS Codeの操作、認証済みSDK workflow実セッションは引き続き未検証。

## レビュー対象

今回の変更は `/Users/soma/IdeaProjects/code-migration-kit-with-copilot` のローカル配布物へ反映した。ユーザー提示の [GitHubリポジトリ](https://github.com/umauma00/code-migration-kit-with-github-copilot)のmainは確認時点で元Claude版の構成であり、このローカルのCopilot版とはファイル構成が異なる。GitHubへの反映は今回の検証結果に含めない。
