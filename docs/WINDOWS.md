# Windows で使う

日本語 | [English](WINDOWS.en.md)

このキットは Windows を主な実行環境として扱います。GitHub Actions の `windows-latest`（Windows Server、PowerShell 7、Node 22、Python 3.12）で、`npm test` と `npm run demo` を毎回実行しています。Copilot CLI と VS Code を使った実機での確認は、まだ済んでいません（[LIVE-SMOKE](LIVE-SMOKE.md) の手順で確認します）。

## 用意するもの

| 必要なもの | 入れ方の例 | 確認 |
|---|---|---|
| Node.js 22 以上 | `winget install OpenJS.NodeJS.LTS` | `node --version` |
| Git for Windows | `winget install Git.Git` | `git --version` |
| Python 3（付属の依存解析・デモ用） | python.org のインストーラー（`py` ランチャーが入ります） | `py -3 --version` |
| Copilot CLI | `npm install -g @github/copilot`（WinGet などで入れた `copilot.exe` もそのまま使えます） | `node migration-kit/scripts/run_migration.mjs doctor --check-cli` |

`python3` は、Windows では見つからないか、Microsoft Store を開くだけのことがよくあります。キットが表示するコマンドは、`py` があれば `py -3`、なければ `python` を使います。

## キットが Windows で自動的に扱うこと

- **Copilot CLI の起動**：npm 版の `copilot.cmd` は、同梱の `copilot.exe`（なければ `node` とローダー）に読み替えます。PATH に npm のフォルダがない端末でも、npm の global prefix を探します。
- **`.cmd` / `.bat` のコマンド**：`migration/config.json` の `commands` に `npm`、`npx`、`mvn`、`gradlew.bat` などをそのまま書けます。プロジェクト直下のバッチは `gradlew.bat` のように拡張子付きで書けば見つかります（拡張子なしの `gradlew` は PATH だけを探します。リポジトリ内のファイルが PATH のツールにすり替わらないようにするためです）。キットは `cmd.exe /d /s /c` を通し、引数を引用・エスケープして渡します（空白、`"`、`%`、`&` などを含んでも、そのまま届きます）。
- **ガードレール**：`npm.cmd test`、`& "C:\...\npm.cmd" test`、`cmd /c git push`、`Start-Process git -ArgumentList push`、`py -3 -m pytest` も、`npm test`・`git push`・`python -m pytest` と同じ禁止ルールで止めます。PowerShell の `Set-Content`、`Out-File`、`Remove-Item` による `migration/guardrails.json` の書き換えも拒否します。
- **ファイルの置き換え**：記録ファイルをほかのプロセス（status の確認、エディター、ウイルス対策）が開いていて一時的に置き換えられないときは、約2秒まで再試行します。
- **改行と文字コード**：依存解析と manifest の生成は UTF-8・LF で書きます。CRLF でチェックアウトされた TSV や Markdown も読めます。キット自体は `.gitattributes` で LF に固定しているため、`core.autocrlf=true` の端末で clone してもテンプレートやエージェント定義は LF のままです。
- **エラー解析**：`C:\Users\Taro Yamada\...` のような空白を含む絶対パスや、`ported\a.mjs` のようなバックスラッシュの相対パスも、manifest の変換先に対応付けます。

## 気をつけること

- **コマンドの書き方**：`commands` は argv の配列です。PowerShell の構文（パイプ、`;`）は使えません。複数の手順が必要なら、`node scripts/check.mjs` のような1つのスクリプトにまとめてください。
- **フォルダの信頼**：Copilot CLI は、信頼していないフォルダの `.github/hooks` を読み込みません。最初に対象リポジトリで `copilot` を対話起動し、フォルダを信頼してください（`doctor` が確認します）。
- **長いパス**：深いフォルダでは 260 文字の制限に当たることがあります。対象リポジトリは `C:\work\proj` のような短い場所に置くか、Windows の長いパスを有効にしてください。
- **改行の自動変換**：Git の `core.autocrlf=true` でも動きます。ただし、変換後のファイルの内容（ハッシュ）が変わると承認が失効するため、移行中に autocrlf の設定を変えないでください。
- **Python の判定スクリプト**：Windows の Python は、パイプの入出力に UTF-8 ではなくコンソールのコードページを使います。日本語などを出力する旧コードや判定スクリプトは、子プロセスに `PYTHONUTF8=1` を渡し、`subprocess.run(..., encoding="utf-8")` で読み書きしてください（`fixtures/mini/tests/judge.py` が例です）。
- **WSL**：WSL の中で動かす場合は Linux として動きます。Windows 側の Copilot CLI と WSL 側のファイルを混ぜないでください。
