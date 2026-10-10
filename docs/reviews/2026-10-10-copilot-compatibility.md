# Copilot対応版の互換性レビュー

2026-10-10 JST。対象は配布版0.1.3。元リポジトリは `UPSTREAM.json` に指定された `cf91c9d5068d9aaf95a36164169f08c3e636c909` をGitHubから取得して比較した。

## 判定

元版の「ルールを固定する、実装とレビューを分離する、元コードを実行可能な仕様として維持する、工程ごとに止める」という設計は概ね継承されている。完了をファイルの存在だけで判断せず、レビューとハッシュを必要にした点は改善である。

ただし、現在の通常CLI経路は長い実装JSONを正しく取り込めない。参照版CLI 1.0.93の実プロセスでも再現した。さらにレビュー入力が元ソース全体であるため、大規模移行という元版の目的をそのまま満たせない。**現状を、元版の期待通りに実運用できる状態とは判定しない。**

このレビューでは実装ファイルを修正していない。本レポートと検証結果JSONのみを追加した。

## R1 — P1: CLIの表示用テキストをJSONとして解析している

対象: `scripts/copilot_adapter.mjs:7`、同`:33`、同`:39`、`lib/results.mjs:3`。

`-s --stream off --no-color` を指定しても、CLIのtext出力は機械向けの無加工JSONになるとは限らない。ローカルの疑似プロバイダーが完全に有効なJSONを返しても、CLI 1.0.93は長い文字列に実改行を挿入する。241 bytesのfixtureコードを含む実装応答で、stdoutには例えば次の破損が生じた。

```text
"content":"export function
divide(a, b) {\\n ...
```

文字列内部の未エスケープ改行なので `JSON.parse` は失敗する。CLI自体は終了0だが、アダプターは `Agent did not return one valid JSON object; no completion recorded` で停止する。短いreview応答は1.0.93で成功したため、短いJSONだけを試すと問題を見逃す。`-p`へ変えるだけでも解決しなかった。

ユーザー環境のCLI 1.0.40でも同じ問題に加え、先頭の `●` が混入した。両版とも `doctor --check-cli` は `ok: true` を返した。doctorはhelp確認に限定されるという注意書きがあり、成功は通信・出力契約の保証ではない。

修正案: `--output-format json` のJSONLを読み、終了結果と対象エージェントの最終 `assistant.message.data.content` を取り出して、既存の結果検証へ渡す。複数メッセージ、tool呼び出し、CLI失敗、空応答を区別する。ターミナルの折り返しやbulletを文字列置換で「修復」すると、本来のコードの改行や空白を壊すため採用しない。

同じ実CLI 1.0.93と疑似応答でJSONL経路を確認したところ、`assistant.message.data.content` は折り返しを含まず、元の実装JSONを正しく解析できた。現在のアダプターはこの経路を利用していない。

参考: [CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)、[参照CLI Release 1.0.93](https://github.com/github/copilot-cli/releases/tag/v1.0.93)。

## R2 — P1（大規模移行の要件）: 各レビューに元ソース全体を詰めている

対象: `lib/review.mjs:27`、同`:30`、`lib/core.mjs:140`。

レビューの対象ファイルに関係する依存だけでなく、`sourceRoots` 配下の全ファイルと全manifestソース、RULEBOOK全文、inventory全文を毎回JSON化する。既定上限は65,536 bytes、設定で許される最大値も4,194,304 bytesである。

独立再現:

| manifestの単位数 | 候補コード | 無関係な元ソース | 上限 | 結果 |
|---|---:|---:|---:|---|
| 1 | 241 bytes | 70 KiB | 64 KiB（既定） | implementerの後、レビュー開始前にblocked |
| 1 | 241 bytes | 5 MiB | 4 MiB（設定可能な最大） | 同じくblocked |

単位が1ファイルでも、他のソースが大きければ全単位が止まる。manifestを小さくするだけでは `sourceRoots` 全体が残るため解決しない。入力を両reviewerで固定すること自体はよいが、全リポジトリを固定入力へ入れる必要はない。元版のinventory運用も「担当範囲を検索する」が基本で、現在の `prompts/02-gap-inventory.md` も全文を各workerへ入れないよう指示しており、実装と食い違う。

修正案: depmapとmanifestから単位ごとの関連ソース・必要な依存を選び、該当inventory行と必要なルールを同じsnapshotとして両reviewerへ渡す。必要な参照が欠けた場合は明示的に停止する。巨大なルールや単位には別途分割方針を持ち、実装モデル呼び出し前に容量を確認する。単純な上限引き上げでは全体を毎単位に渡すコストとモデル入力制限が残る。

READMEが大規模案件を未検証・未対応としている点は正直である。この指摘は、その制限が元版の主要用途に対する実装上の障害であることを示す。

参考: [元READMEの工程・inventory説明](https://github.com/anthropics/code-migration-kit-with-claude-code/blob/cf91c9d5068d9aaf95a36164169f08c3e636c909/README.md)。

## R3 — P2: CLIのsearch aliasに依存し、検索ツールが欠落する

対象: `lib/review.mjs:12`、`.github/agents/migration-implementer.agent.md:4`。arbiter/fixerも同じプロファイル指定である。

CLI 1.0.93とローカル疑似プロバイダーの `gpt-4.1` 設定で、モデルへ実際に渡ったtoolsを記録した。

| プロファイル | CLIのavailable-tools | 実際のモデル入力tools |
|---|---|---|
| `tools: ["read", "search"]`（現状） | `view,grep,glob` | `view` だけ |
| `tools: ["view", "grep", "glob"]`（使い捨て導入先で比較） | 同じ | `view,grep,glob` |
| reviewerの `tools: []` | 同じ | 空配列 |

`--available-tools` だけではプロファイルによる欠落を回復しない。現状の `validateWorkerProfile` は `read,search` の表記を厳密に強制するため、利用者がCLIの具体的なtool名へ変更してもランナーに拒否される。

無関係な全ソースを読めることとは別に、実装・修正・裁定でinventoryや依存を検索できるという本版の契約を満たさない。1.0.40でも現状プロファイルは `view` だけだった。全モデル・全harnessでの一般化はしていないが、指定可能な1つのモデル経路で参照版CLIとの不整合を確認できている。

修正案: 通常CLI向けに実在する `view,grep,glob` を使い、その同等性をvalidatorで許容する。IDE向けaliasが必要ならharness別に生成する。read/search以外の編集・shell・delegationを許可しない条件は維持する。doctorまたはsmokeで、frontmatterの文字列だけでなく実際に選択されたtool集合を検証する。

参考: [公式custom agentsのtool設定](https://docs.github.com/en/copilot/reference/custom-agents-configuration)、[同種のCLI alias問題の報告 #4594](https://github.com/github/copilot-cli/issues/4594)。本件の判定はissueの記述だけでなく、1.0.93での独立再現による。

## Claude Code / GitHub Copilotと、この移植で変わった部分

| 観点 | 元のClaude Code版 | Copilotの仕様・現在の対応版 |
|---|---|---|
| 常設の指示 | 対象repoのCLAUDE.md | `.github/copilot-instructions.md` を入口としてoperating manualへ誘導。installerがリンクを書き換える |
| スキル | `~/.claude/skills/code-migration` の導入例 | `.github/skills/code-migration/SKILL.md` へ配置。個別クライアントの発見仕様を前提にする |
| 並列実行 | Claude CodeのTask/Agentによる工程単位のfan-out | 通常版はNodeが新しいCLIプロセスを起動。VS Codeは工程のprompt launcher、Dynamic Workflowsは任意のSDK拡張 |
| 権限制限 | `.claude/settings.json` のdeny。高価なcompiler/test等をループから外す | CLIのtool allowlist/denyとread-onlyプロファイル。コードをJSONで返しNodeだけが書き込む。Claude用settingsの単純コピーはしない |
| レビュー | 別contextの2人、readonly。第三者が指摘を裁定 | reviewerのtoolsを空にし、同じ固定入力を渡す。通常CLIの実リクエストでtools空配列を確認。ただしR2の容量制限がある |
| 完了・再開 | manifestと出力ファイルの存在を基本にする | 入力・出力・review・arbitrationのhashとreceiptで判定。中断・再レビュー・上流再実行時の下流失効は自動テストで確認 |
| ビルド修正 | daemonによるsurvey build、診断queueをmoduleごとに並列処理 | Nodeが1回のbuildを実行。診断の切り出しと対象への対応付けは利用側が用意し、repairを対象ごとに呼ぶ |
| 完了ゲート | parity全合格と元suiteの再実行。post-parityを後に分離 | parity工程はoriginal→parityの順で実行。ケース網羅性はexit codeから推論せず人が確認する |
| 再設計・単位 | file以外のmodule/subsystemへの適応もプロンプトで扱う | 自動runnerはpreserveの1元ファイル→1対象ファイルのみ。redesign/module adapterは未対応と明記 |
| コスト | モデル計画とcost-logを各gateで記録 | 要求モデル・時刻・呼び出し数を保存。実測できないmodel/tokens/creditsはnull。呼び出し数上限は料金上限ではない |

Claudeのsubagentは独立contextと個別tool/permissionを持つ。Copilotもcustom agentsでtool集合を指定できるが、CLI・VS Code Local・SDKでは設定の解釈やhooksの形式が異なる。機能名の置換だけで同じ実行契約になるとは限らない。[Claude subagents](https://code.claude.com/docs/en/sub-agents)、[Claude permissions](https://code.claude.com/docs/en/permissions)、[Copilot custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration)、[Copilot tool controls](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)、[VS Code Local hooks](https://code.visualstudio.com/docs/agents/reference/hooks-reference)。

元版のPython/C/JS・TS依存解析器は実ファイル比較でも同一だった。fixtureの成功は維持されているが、path aliases、target packageのcycle、Java/C#等の追加解析を自動で解決する証拠ではない。

## 今回の検証

| 確認 | 結果と範囲 |
|---|---|
| `npm test` | Python参照先の調整後、57成功 / 0失敗 / 0skip |
| `npm run demo` | 3単位、疑似worker応答9回、build 3module、smoke 1ケース、original/parity各12ケース、差分0 |
| CLI 1.0.40 | ユーザーの既存CLI。version/helpとローカル疑似プロバイダーで実プロセス確認 |
| CLI 1.0.93 | GitHub公式darwin-arm64 Releaseを一時領域に取得。同ReleaseのSHA256SUMSと照合後、実プロセス確認 |
| CLI text/JSONL | 正しいJSONのtext破損、JSONLによる無損失取り出しを確認。`-p`とstdin両方を比較 |
| tool集合 | 現状alias、具体名、reviewerの空集合を実際のプロバイダーrequestで確認 |
| 元版との比較 | 固定コミットを取得し、元instructions/settingsと依存解析器の保存・変更点を比較 |

環境: macOS arm64、Node 25.9.0、Homebrew Python 3.13.13。既定の `/usr/bin/python3` では未同意のXcode licenseによって2件が終了69になった。一時PATH内の `python3` をHomebrew Pythonへ向けると全件通った。これはプロジェクトのロジック失敗として数えていない。

CLI検証は実バイナリを使用したが、モデル応答はローカルのtest doubleであり、AIによる移植能力を評価したものではない。GitHub Copilotの認証済みモデル経路、モデル利用資格、VS CodeのUI/hooks、Dynamic Workflowsの実登録・実行、大規模案件は未検証。プロジェクトが明示している未検証事項を、オフラインテスト成功だけで解消したとは扱わない。

検証結果の機械可読版: [2026-10-10-copilot-compatibility.json](2026-10-10-copilot-compatibility.json)。

## 修正・確認の順序

1. R1の出力契約をJSONLへ変更し、コード中の長い行・改行・Unicode・fenced JSONを含む実CLIテストを追加する。
2. R3のtoolプロファイルを修正し、CLIへ渡った検索・読取tool集合とreviewerの隔離を確認する。
3. R2の入力選択を単位と依存に限定し、大きい無関係ファイルを含む案件と関連依存が大きい案件を区別して検証する。
4. 認証済みCopilotで3ファイルのpilotを実行し、2レビュー・裁定・修正・再開・build・smoke・parityを確認する。
5. 元版の想定する大規模利用には、SCC/module単位、診断queue、package cycle、contextとI/Oコストの追加評価を行う。
