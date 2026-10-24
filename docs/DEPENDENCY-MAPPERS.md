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
- **名前の解決は言語の優先順に従います。** 名前は書かれている名前空間ブロックから探します（1ファイルに複数のブロックがあっても、ブロックごとに解決します）。ブロック内の using・別名・using static は、そのブロックと内側のブロックにだけ効きます（同じ名前空間の別ブロックには効きません）。C#・VB.NET は内側の名前空間から外側へ1段ずつ探し、各段でその名前空間の型、次にその名前空間の宣言に書かれた別名・using を見ます（ファイル直下と global using は最後の段です。`namespace N;` の後の using は N の段に入ります）。`global::X` / `Global.X` はルートの名前空間から探します。Java は単一型 import、自分のパッケージ、`pkg.*` の順。同じ順位に複数の候補があるときは全部を辺にします（多めに出る方向）。型と同名のローカル変数も辺になります。`using static T` が持ち込むのは T のメンバーと入れ子の型で、T という名前そのものではありません。属性 `[Foo]` は `Foo` と `FooAttribute` の両方を候補にします。
- **プロジェクトファイルで候補を絞ります。** C#・VB.NET は `.csproj`/`.vbproj` の ProjectReference、Java は Maven（`pom.xml`）と Gradle（`build.gradle`）のモジュール依存を読み、同じ名前の型が複数のプロジェクトにあるときは、参照しているプロジェクト側だけを辺にします。ビルド対象外のファイル（`<Compile Remove>`、古い形式のプロジェクトで `<Compile Include>` に無いもの）は型を提供せず、`unresolved.tsv` に載ります。Include/Remove の値はアイテムのリスト（`a.cs;b.cs`）として読みます。ワイルドカードは MSBuild と同じく `*`・`?` が1階層の中だけ、`**` が任意の深さに一致します。属性値は `"` と `'` のどちらで囲んでも読みます。Include の `Exclude` はその Include にだけ効きます（`Include="**\*.cs" Exclude="Legacy\**"`）。`Update` はメタデータを変えるだけなので読みません。Include と Remove は書かれた順に適用します（`Remove="Legacy\**"` の後の `Include="Legacy\Keep.cs"` は Keep.cs をビルド対象に戻します）。Condition とプロパティ（`$(Gen)`）は評価しません。条件付き（項目・ItemGroup・`<Choose>` の分岐・`<Target>` の中）やプロパティを使った項目でだけ入る・外れるファイルは型を残したまま `unresolved.tsv` に載せます。別のディレクトリのファイルを `<Compile Include="..\Shared\X.cs" />` で取り込むと、取り込んだプロジェクトのファイルにもなります（そのプロジェクトの global using・参照範囲・VB の RootNamespace が効きます。プロジェクトごとに別名の行き先が違うときは全部を辺にします。元のプロジェクトが外していてもビルド対象です）。SDK 形式で既定の項目を切り、`<Compile>` を1つも書いていないプロジェクトは、読まない import が項目を足すかもしれないので「入るかもしれない」とします。`EnableDefaultCompileItems`（`EnableDefaultItems`）を Condition の下で false にしている場合は、既定のファイルを「入るかもしれない」として扱います。ProjectReference のパスは大文字小文字を区別しません。Gradle は `project(":core")`・`project(path: ":core")`・Kotlin の `project(path = ":core")` と型安全アクセサ（`projects.core`、`my-lib` は `projects.myLib`）を読みます。global using とその別名、`<Using Include>`・`<Import Include>` は同じプロジェクトのファイルにだけ効きます。`global using static`（と `<Using Static="true">`）は、その型のメンバーを書いている同じプロジェクトのファイルから辺になります。属性値に生の `<` があるタグ（MSBuild 自身も読めない不正な XML）は読めないので、行番号付きの警告を出します。ファイルはテキストとして読むだけで、MSBuild や Maven は実行しません。
- **同じ型を partial なしで2つのファイルが宣言しているとき**は、2つを互いに結びません（結ぶと偽の循環になります）。その型を使うファイルからは両方へ辺を出し、`unresolved.tsv` に「also declared in ...」と載せます。ビルドから片方が外れている、あるいはプロジェクトが分かれているはずなので確認してください。VB の Module のメンバー（`Sub Log` が2つの Module にある）は重複として扱いません。
- **まだ見落とすもの：** ラムダ引数の型、ジェネリックメソッドの型推論、オーバーロードの選択、`dynamic`、VB の With ブロック。レビュー根拠（一緒に読むファイル）として不足していないかは、[準備監査](PREPARATION-AUDITS.md)の抜き取りと `dependency-diff` で確かめてください。
- PHP はメソッド呼び出し先が実行時に決まる言語なので、本物の構文解析器を使っても `$obj->m()` の行き先は分かりません。COBOL の依存は COPY と CALL の名前だけで決まります。この2言語では、本物の解析器を使っても得られる情報はあまり増えません。ただし同梱版が読むのは書かれた名前と、計算できるパス（`__DIR__`・`dirname(__FILE__)`・`DIRECTORY_SEPARATOR`・`DS`・`realpath()`）だけです。それ以外は `unresolved.tsv` に載ります。`"...{$this->t(Cls::class)}..."` やヒアドキュメントの `{$...}` の中はコードとして読みます（nowdoc は読みません。穴の中の `'Order'` のような引用符付きの文字列と `${name}` は名前として扱いません）。`class_alias(Orig::class, 'Old')`（`\class_alias('Orig', 'Old')` も）の別名はそのファイルが宣言するクラスとして扱い、別名が計算される場合は `unresolved.tsv` に載せます。PHP の文字列 callable は、コールバックを受け取る関数（`array_map`・`usort`・`call_user_func`・`add_action` など）の文字列引数と、`['Cls', 'm']` の形のときだけ、同名の関数・クラスへの辺にします。配列キーなどの普通の文字列は参照として扱いません。

## 解析器の結果を確かめる

1. 5ファイル試行：全体を作る前に5ファイルで実行し、`edges.tsv` と `unresolved.tsv` をユーザーに見せる
2. `unresolved.tsv` を全件確認する：外部ライブラリなら問題なし、リポジトリ内のファイルを指すべきものは `review-dependencies.json` に追記する
3. 除外ディレクトリ（各スクリプト冒頭のコメントに記載）が案件に合っているか確認する。ビルド出力（bin・obj・target・build・out）や vendor・packages は、`--root` 直下かビルドファイル（.csproj・pom.xml・composer.json など）の横にあるときだけ除外します。同じ名前のパッケージやフォルダは読みます。除外したディレクトリにソースがあれば警告（`WARN skipped ...`）が出ます。ディレクトリのシンボリックリンクはたどります（同じディレクトリが2つのパスで見えるときは両方のファイルとして読みます）。祖先を指すループだけは止めて `WARN symlink loop not followed` を出します
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
