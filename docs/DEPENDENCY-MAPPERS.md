# 依存解析器（同梱版と自作アダプタ）

日本語 | [English](DEPENDENCY-MAPPERS.en.md)

工程01の依存マップは、**ソースを読むだけの決定的な解析器**で作ります。元のアプリをビルドしたり実行したりはしません。[ソースを唯一の仕様とする方式](SOURCE-AS-SPEC.md)でも同じ解析器を使います。

## 同梱の解析器

どれも Python 3 の標準ライブラリだけで動きます（追加インストール不要、Windows・macOS・Linux 共通）。

| 元の言語 | コマンド | 辺の根拠 |
|---|---|---|
| Python | `python3 migration-kit/scripts/depmap_python.py --root src --out migration/depmap` | import（ast で解析） |
| JS / TS | `node migration-kit/scripts/depmap_ts.mjs --root src --out migration/depmap` | import / export from / require |
| C / C++ | `python3 migration-kit/scripts/depmap_c.py --root src --out migration/depmap` | `#include "..."`、実装と同名ヘッダ |
| C# | `python3 migration-kit/scripts/depmap_csharp.py --root src --out migration/depmap` | 型名（名前空間・using・global using・別名・using static・拡張メソッド・partial） |
| Java | `python3 migration-kit/scripts/depmap_java.py --root src --out migration/depmap` | 型名（同じパッケージ・import・`pkg.*`・static import・完全修飾名） |
| VB.NET | `python3 migration-kit/scripts/depmap_vbnet.py --root src --out migration/depmap` | 型名と Module のメンバー（Imports・RootNamespace・大文字小文字を区別しない） |
| PHP | `python3 migration-kit/scripts/depmap_php.py --root src --out migration/depmap` | include / require のパス、クラス・関数・定数の名前（namespace・use） |
| COBOL | `python3 migration-kit/scripts/depmap_cobol.py --root src --out migration/depmap` | COPY、EXEC SQL INCLUDE、CALL 'PROG'、EXEC CICS LINK/XCTL |

Windows では `python3` の代わりに `py` または `python` を使います。

追加のオプション（どちらも `--root` からの相対パスをカンマ区切りで指定）：

- PHP：`--include-path lib,inc` で PHP の include_path を指定します。相対パスの include はまずここを探し、次に include したファイルの場所、最後に `--root` を探します。`./x` や `../x` のように明示した相対パスは作業ディレクトリ基準なので include_path は使わず、include したファイルの場所と `--root` だけを探します。この2つで別のファイルになるときは両方を辺にし、`unresolved.tsv` にも載せます。`composer.json`（vendor 以外）の autoload（PSR-4・PSR-0・classmap）は自動で読みます。同じクラスが複数のファイルにあるときは autoload が指すファイルを選びます
- COBOL：`--copy-path copy,shared` でコピーブックの検索順（SYSLIB や COBCPY に相当）を指定します。同じ名前のコピーブックが複数あるときは、先に書いたディレクトリのものを選びます。`COPY X OF LIB` は LIB という名前のディレクトリを先に探します

出力は共通です。

- `edges.tsv`：1行1辺（依存元 → 依存先、`--root` からの相対パス）
- `order.txt`：移行順（依存先が先、循環は1行にまとめる）
- `cycles.txt`：2ファイル以上の循環
- `unresolved.tsv`（C#・Java・VB.NET・PHP・COBOL）：見えたのにファイルへ結び付けられなかった参照と理由。動的な include、データ項目経由の CALL、計算した名前のリフレクション、リポジトリ内パッケージに無い型の import など

同じ入力なら毎回バイト単位で同じ出力になります。Shift_JIS（cp932）のソースも読めます（UTF-8 で読めないファイルは警告を出して cp932、それも駄目なら Latin-1 で読みます）。

## 精度について（型の言語）

C#・Java・VB.NET では、`using` や `import` はファイルではなく名前空間を指し、同じ名前空間の型は import なしで使えます。そこで解析器は「各ファイルが宣言する型の表」を作り、各ファイルのコードに**書かれている名前**をその表で解決します。

- **名前が書かれていない型もたどります。** 各型のメソッド・プロパティ・フィールドの宣言型と継承元を表にして、`var x = F(); x.M().N();` のように変数やメソッドチェーンを通る型（`F` の戻り値の型、`M` と `N` の戻り値の型）を辺にします。引数・型付きのローカル変数・foreach の変数も使います。`List<Order>` のような要素の型は、インデクサや LINQ 風の呼び出しを通しても引き継ぎます。
- **名前の解決は言語の優先順に従います。** 名前は書かれている名前空間ブロックから探します（1ファイルに複数のブロックがあっても、ブロックごとに解決します）。C#・VB.NET は内側の名前空間から外側へ、次に using/Imports。`global::X` / `Global.X` はルートの名前空間から探します。Java は単一型 import、自分のパッケージ、`pkg.*` の順。同じ順位に複数の候補があるときは全部を辺にします（多めに出る方向）。型と同名のローカル変数も辺になります。
- **プロジェクトファイルで候補を絞ります。** C#・VB.NET は `.csproj`/`.vbproj` の ProjectReference、Java は Maven（`pom.xml`）と Gradle（`build.gradle`）のモジュール依存を読み、同じ名前の型が複数のプロジェクトにあるときは、参照しているプロジェクト側だけを辺にします。ビルド対象外のファイル（`<Compile Remove>`、古い形式のプロジェクトで `<Compile Include>` に無いもの）は型を提供せず、`unresolved.tsv` に載ります。Include/Remove の値はアイテムのリスト（`a.cs;b.cs`）として読みます。Condition は評価しません。条件付き（項目・ItemGroup・`<Choose>` の分岐）でだけ外れるファイルは型を残したまま `unresolved.tsv` に載せます。global using とその別名、`<Using Include>`・`<Import Include>` は同じプロジェクトのファイルにだけ効きます。ファイルはテキストとして読むだけで、MSBuild や Maven は実行しません。
- **まだ見落とすもの：** ラムダ引数の型、ジェネリックメソッドの型推論、オーバーロードの選択、`dynamic`、VB の With ブロック。レビュー根拠（一緒に読むファイル）として不足していないかは、[準備監査](PREPARATION-AUDITS.md)の抜き取りと `dependency-diff` で確かめてください。
- PHP はメソッド呼び出し先が実行時に決まる言語なので、本物の構文解析器を使っても `$obj->m()` の行き先は分かりません。COBOL の依存は COPY と CALL の名前だけで決まります。この2言語は、同梱版と本物の解析器の差がほとんどありません。

## 解析器の結果を確かめる

1. 5ファイル試行：全体を作る前に5ファイルで実行し、`edges.tsv` と `unresolved.tsv` をユーザーに見せる
2. `unresolved.tsv` を全件確認する：外部ライブラリなら問題なし、リポジトリ内のファイルを指すべきものは `review-dependencies.json` に追記する
3. 除外ディレクトリ（各スクリプト冒頭のコメントに記載）が案件に合っているか確認する
4. 結果は `migration/depmap/report.md` にまとめる（対応構文、除外、未解決、監査結果）

## 同梱されていない言語：アダプタを自作する

同梱版のない言語（RPG、PL/I、Delphi、VB6、Perl など）や、同梱版では足りない構文がある場合は、エージェントが**アダプタ（専用の解析器）**を書きます。エージェントが推測で書いた依存グラフは使えません。

### 守ること

- **静的解析だけ。** ソースファイルを読むだけにする。元のアプリのビルド・実行・テストはしない（ソースが唯一の仕様の案件では、元のアプリが動かないことが前提）
- **置き場所は `migration/tools/depmap-<言語>/`。** キット本体（`migration-kit/`）は変更しない
- **出力は同梱版と同じ契約。** `edges.tsv`（ヘッダー `from<TAB>to`）、`order.txt`、`cycles.txt`、`unresolved.tsv`（ヘッダー `file<TAB>reference<TAB>reason`）。パスは `--root` からの相対パスで `/` 区切り、並びは整列済み
- **決定的にする。** ファイルは整列して走査し、同じ入力で同じ出力にする。乱数・時刻・並列実行の順序に依存しない
- **追加インストールを避ける。** Python の標準ライブラリだけで書くのが第一候補。コンパイラ系のライブラリ（Roslyn、JavaParser など）が必要なら、使う前にユーザーに確認する（ネットワーク接続やSDKが要るため）
- **見落としより多めを選ぶ。** 迷ったら辺を足す。解決できない参照は捨てずに `unresolved.tsv` に書く
- **除外ディレクトリはスクリプト冒頭に一覧で書く。** 生成物・ビルド出力・第三者コードの除外を、読めば分かるようにする

### 手順

1. 対象言語で依存が生まれる構文を列挙する（ファイル取り込み、モジュール参照、型名、呼び出し、設定ファイル経由の結び付けなど）
2. `migration/tools/depmap-<言語>/fixture/` に小さなテスト用ソースを作る。循環、除外ディレクトリ、コメントや文字列の中の偽の参照、動的な参照を必ず含める
3. 期待する `expected_edges.tsv` などを**手で**書いてからアダプタを実装し、出力と比較する
4. 実ソースで5ファイル試行をして、ユーザーに見せる（工程01の決まり）
5. 全体を生成し、`depmap/report.md` に対応構文・未対応構文・除外・未解決を書く

アダプタを直したら、依存マップを作り直し、工程01の確認（5ファイル試行・監査・`make_review_dependencies.mjs` による依存宣言の再生成）をやり直します。
