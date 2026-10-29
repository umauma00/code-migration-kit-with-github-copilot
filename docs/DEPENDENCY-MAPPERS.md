# 依存解析器（同梱版と自作アダプタ）

日本語 | [English](DEPENDENCY-MAPPERS.en.md)

工程01の依存マップは、**ソースを読むだけの決定的な解析器**で作ります。元のアプリをビルドしたり実行したりはしません。[ソースを唯一の仕様とする方式](SOURCE-AS-SPEC.md)でも同じ解析器を使います。

## 同梱の解析器

Python版はPython 3の標準ライブラリ、JS/TS版はNode.jsの標準機能だけで動きます（追加インストール不要）。source-as-specでは00b〜02の準備を続けて進めるため、00bの作業中にもこれらを使います。

| 元の言語 | コマンド | 辺の根拠 |
|---|---|---|
| Python | `python3 migration-kit/scripts/depmap_python.py --root src --out migration/depmap` | import（ast で解析） |
| JS / TS | `node migration-kit/scripts/depmap_ts.mjs --root src --out migration/depmap` | import / export from / require |
| C / C++ | `python3 migration-kit/scripts/depmap_c.py --root src --out migration/depmap` | `#include "..."`、実装と同名ヘッダ |
| C# | `python3 migration-kit/scripts/depmap_csharp.py --root src --out migration/depmap` | 型名（名前空間・using・global using・別名・using static・拡張メソッド・partial） |
| Java | `python3 migration-kit/scripts/depmap_java.py --root src --out migration/depmap` | 型名（同じパッケージ・import・`pkg.*`・static import・完全修飾名） |
| VB.NET | `python3 migration-kit/scripts/depmap_vbnet.py --root src --out migration/depmap` | 型名と Module のメンバー（Imports・RootNamespace・大文字小文字を区別しない） |
| PHP | `python3 migration-kit/scripts/depmap_php.py --root src --out migration/depmap` | include / require のパス、クラス・関数・定数の名前（namespace・use） |
| COBOL | `python3 migration-kit/scripts/depmap_cobol.py --root src --out migration/depmap` | COPY、EXEC SQL INCLUDE、CALL 'PROG'、EXEC CICS の PROGRAM(...)（LINK・XCTL・START・LOAD・HANDLE ABEND・RELEASE・ENABLE） |

Windows では `python3` の代わりに `py` または `python` を使います。

全言語で `--source-root DIR` を繰り返すと、`--root` からの相対ディレクトリを解析対象として選べます。選択は型・モジュールの索引を作る前に適用し、対象外の同名型が偽の依存を作ることを防ぎます。省略時は従来どおりroot全体です。共通親のプロジェクト設定は引き続き読みます。選択外に実依存がある場合は、未解決記録の監査で必要なrootを追加してください。

追加のオプション（どちらも `--root` からの相対パスをカンマ区切りで指定）：

- PHP：`--include-var phpbb_root_path=phpBB/,phpEx=php` で include パスに使われる変数（`$NAME`）や定数（`NAME`）の値を指定できます（ディレクトリは `--root` からの相対パス）。`"$IP/includes/x.php"` のように `"..."` の文字列やヒアドキュメントの中に書いた変数も置き換えます（`'...'` の中の `$IP` は文字なので置き換えません）。`define('WPINC', 'wp-includes')` のように全ファイルで同じ相対パスのリテラルを与える定数と、`define('DO_MAINTENANCE', dirname(__FILE__) . '/doMaintenance.php')` のように計算できるパスを与える定数は自動で使います（同じ定数に違う値の define があれば、同じファイルの if/else でも別のファイルでも、include は各値が指すファイル全部への辺になり、`unresolved.tsv` にも載ります。`define('BASE', $dir)` のようにリテラルでない値もあれば、値は絞らず従来どおり未解決にします）。`\define(...)` も `define(...)` と同じに読み、`const A = 1, B = 2;` はリストの全部の名前を宣言します。`const`（クラス定数・型付き定数も）や enum の `case` が宣言する名前は、同名のクラスへの参照として数えません。Drupal の `.install`・`.test`・`.theme`・`.engine`・`.profile` は `<?php` を含むときだけ PHP のファイルとして読みます。`--include-path lib,inc` で PHP の include_path を指定します。相対パスの include はまずここを探し、次に include したファイルの場所、最後に `--root` を探します。`./x` や `../x` のように明示した相対パスは作業ディレクトリ基準なので include_path は使わず、include したファイルの場所と `--root` だけを探します。この2つで別のファイルになるときは両方を辺にし、`unresolved.tsv` にも載せます。`composer.json`（vendor 以外）の autoload（PSR-4・PSR-0・classmap）は自動で読みます。同じクラスが複数のファイルにあるときは autoload が指すファイルを選びます
- COBOL：`--copy-path copy,shared` でコピーブックの検索順（SYSLIB や COBCPY に相当）を指定します。同じ名前のコピーブックが複数あるときは、先に書いたディレクトリのものを選びます。`COPY X OF LIB` は LIB という名前のディレクトリを先に探します。リテラルの中の `*>`（`DISPLAY '*>'`）はコメントではありません。タブは次の8の倍数の桁まで進むものとして固定形式を読みます。EXEC CICS の PROGRAM(...) は END-EXEC までの中だけを見ます

出力は共通です。

- `edges.tsv`：1行1辺（依存元 → 依存先、`--root` からの相対パス）
- `order.txt`：移行順（依存先が先、循環は1行にまとめる）
- `cycles.txt`：2ファイル以上の循環
- `unresolved.tsv`（全言語）：結び付けられない参照や解析できなかったファイルと理由。Pythonの構文・文字コード・AST上限、Cの未解決quoted include・マクロinclude、JS/TSの未解決相対import・読めないファイルも残します。型付き言語などでは動的include・CALL・リフレクション・未解決型も記録します。

同じ入力なら毎回バイト単位で同じ出力になります。PythonソースはPython自身の規則でUTF-8 BOM・coding宣言（cp932・Latin-1など）を読み、読めない構文・文字コードはファイル全体を未解析として記録します。C/C++・C#・Java・VB.NET・PHP・COBOLは共通のデコーダーでUTF-8、BOM付きUTF-16/32、cp932、EUC-JP、Latin-1を扱います。cp932・EUC-JPはかなの多い方を選び、かな・全角記号がない場合は欧文としてLatin-1を選びます。依存解析は import/include の名前（ASCII）を読むため、`migration/config.json` の `sourceEncoding` は解析器には渡しません（ワーカーへの入力にだけ使います）。BOMなしUTF-16は1バイトおきのNULで判定します。それ以外のNULや読取失敗は `(whole file)` として記録し、独立したファイルの解析を続けます。JS/TS版はUTF-8専用で、不正UTF-8・NULを未解析として記録します（ワーカーには読み替えて渡すため、このファイルは依存の宣言を手で補ってください）。

### 調査で修正したケース（2026-10-26）

- C#・VB.NETのliteral Importは再帰を使わず展開し、1200段の連鎖・循環を扱います。`--root` 外のImportは読まず警告します。MSBuildの実行・Condition評価は行いません。
- PHPのcomposer.jsonは値の型を確認し、不正なsection/pathを警告して除外します。他の正常なautoload設定と解析結果は保持します。Drupal形式の拡張子のPHPタグは文字コードの復号後に判定します。
- C/C++のコメント・raw string内のincludeを除外し、行継続・コメントを挟んだquoted includeを読みます。JS/TSはコメント・文字列・regex・template・JSXの本文を除外し、template/JSXの式内のliteral importと、出力拡張子 `.js/.mjs/.cjs` で書かれたTSソースへの参照を読みます。JSXの閉じタグ後も同じ行のimportを読みます。
- 共通のディレクトリ走査・PHP/Javaの設定ファイル探索は反復処理にし、深いツリーでの再帰例外を避けます。解析器はプロジェクトのソースを実行しません。

`source-spec check` の生成コマンドは複数sourceRootsの共通親をrootにして、`--source-root` で設定済みのソースだけを選び、空白や引用符を含むパスを引用します。manifest生成の `--map-root SOURCE=TARGET` はディレクトリの先頭だけを置換し、`--sub` による拡張子変更を後から適用します。複数rootは共通親からの相対配置を保ち、全対象をoutputRoots内へ配置する案を作ります。命名はRULEBOOKに合わせて確認してください。カンマ区切りのCLIオプションで、パス自体にカンマを含む形式は未対応です。

## 精度について（型の言語）

C#・Java・VB.NET では、`using` や `import` はファイルではなく名前空間を指し、同じ名前空間の型は import なしで使えます。そこで解析器は「各ファイルが宣言する型の表」を作り、各ファイルのコードに**書かれている名前**をその表で解決します。

- **名前が書かれていない型もたどります。** 各型のメソッド・プロパティ・フィールドの宣言型と継承元を表にして、`var x = F(); x.M().N();` のように変数やメソッドチェーンを通る型（`F` の戻り値の型、`M` と `N` の戻り値の型）を辺にします。引数・型付きのローカル変数・foreach の変数、`var c = x as IContent` や `var s = (ISession)f.Open()` で書いた型、C# の `new` 修飾子で隠したメンバー（`new IScopeUnit Get();`）、Java のワイルドカード（`Job<?, ?> job`、`List<? extends Item>`）も使います。変数は宣言した手続きの中だけで有効です。型の分からない変数や、見えている変数が無い名前（型引数の型を持つ継承したフィールドなど）は、同じファイルの別の手続きにある同名で型の分かる変数の型を借ります。`List<Order>` のような要素の型は、インデクサや LINQ 風の呼び出しを通しても引き継ぎます。
- **名前の解決は言語の優先順に従います。** 名前は書かれている名前空間ブロックから探します（1ファイルに複数のブロックがあっても、ブロックごとに解決します）。ブロック内の using・別名・using static は、そのブロックと内側のブロックにだけ効きます（同じ名前空間の別ブロックには効きません）。C#・VB.NET は内側の名前空間から外側へ1段ずつ探し、各段でその名前空間の型、次にその名前空間の宣言に書かれた別名・using を見ます（ファイル直下と global using は最後の段です。`namespace N;` の後の using は N の段に入ります）。`global::X` / `Global.X` はルートの名前空間から探します。Java は単一型 import、自分のパッケージ、`pkg.*` の順。同じ順位に複数の候補があるときは全部を辺にします（多めに出る方向）。Java では型と同名のローカル変数も辺になります。`using static T` が持ち込むのは T のメンバーと入れ子の型で、T という名前そのものではありません。属性の位置に書かれた `[Foo]`（`[Foo<int>]`、ラムダ・ファイナライザーの属性も含む）は、`Foo` と `FooAttribute` の両方を辺にします（C# はそのうち属性である方を選びます）。属性の位置でない `Foo`（`F([Foo])` や初期化子の `{ [Foo] }` などのコレクション式も含む）は `FooAttribute` を指しません。タプルなどの別名 `using P = (A a, B b);` は、中の型を別名が書かれたファイルからの辺にします（global using の場合も宣言ファイルだけです）。
- **プロジェクトファイルで候補を絞ります。** C#・VB.NET は `.csproj`/`.vbproj` の ProjectReference、Java は Maven（`pom.xml`）と Gradle（`build.gradle`）のモジュール依存を読み、同じ名前の型が複数のプロジェクトにあるときは、参照しているプロジェクト側だけを辺にします。ビルド対象外のファイル（`<Compile Remove>`、古い形式のプロジェクトで `<Compile Include>` に無いもの）は型を提供せず、`unresolved.tsv` に載ります。Include/Remove の値はアイテムのリスト（`a.cs;b.cs`）として読みます。ワイルドカードは MSBuild と同じく `*`・`?` が1階層の中だけ、`**` が任意の深さに一致します。属性値は `"` と `'` のどちらで囲んでも読みます。Include の `Exclude` はその Include にだけ効きます（`Include="**\*.cs" Exclude="Legacy\**"`）。`Update` はメタデータを変えるだけなので読みません。Include と Remove は書かれた順に適用します（`Remove="Legacy\**"` の後の `Include="Legacy\Keep.cs"` は Keep.cs をビルド対象に戻します）。Condition とプロパティ（`$(Gen)`）は評価しません。条件付き（項目・ItemGroup・`<Choose>` の分岐・`<Target>` の中）やプロパティを使った項目でだけ入る・外れるファイルは型を残したまま `unresolved.tsv` に載せます。別のディレクトリのファイルを `<Compile Include="..\Shared\X.cs" />` で取り込むと、取り込んだプロジェクトのファイルにもなります（そのプロジェクトの global using・参照範囲・VB の RootNamespace が効きます。プロジェクトごとに別名の行き先が違うときは全部を辺にします。元のプロジェクトが外していてもビルド対象です）。SDK 形式で既定の項目を切り、`<Compile>` を1つも書いていないプロジェクトは、読まない import が項目を足すかもしれないので「入るかもしれない」とします。既定のファイルが入るのは `EnableDefaultItems` と `EnableDefaultCompileItems` の両方が有効なときだけです（空の値 `<EnableDefaultCompileItems />` は SDK の既定どおり有効です）。どちらかを Condition の下で false にしている場合は、既定のファイルを「入るかもしれない」として扱います。ProjectReference はプロジェクトファイルのパスまで一致を確かめます（大文字小文字は区別しません）。そこに無いファイルを指していれば警告します。Maven の依存は groupId:artifactId で照合します。artifactId が同じでも groupId が違えば別のモジュールです。groupId がプロパティで書かれているなど読めないときは、同じ artifactId のモジュールを全部候補にして警告します。Gradle は `project(":core")`・`project(path: ":core")`・Kotlin の `project(path = ":core")` と型安全アクセサ（`projects.core`、`my-lib` は `projects.myLib`）を読みます。global using とその別名、`<Using Include>`・`<Import Include>` は同じプロジェクトのファイルにだけ効きます。プロジェクトファイルの上にある一番近い `Directory.Build.props`（前）と `Directory.Build.targets`（後）、そこやプロジェクトファイルが `--root` の中のパスで `<Import Project>` するファイル、`GetPathOfFileAbove` でつないだ上の階層の `Directory.Build.props` も、プロジェクトの一部として読みます（`<Using>`・`<ProjectReference>`・`<Compile>` など）。Condition 付きの `<Import>`（`ImportGroup` や `<Choose>` の中も）で読んだファイルの項目は条件付きとして扱います（読み込むファイル自身の `Exists('x.props')` だけの Condition は成り立つものとします。その中の `<Compile Remove>` で外れるファイルは宣言を残して `unresolved.tsv` に載せます）。MSBuild は同じファイルを最初の Import でしか読みませんが、その Import が条件付きなら、後で同じファイルを（別の Condition で、または無条件で）Import した方も条件付きとして読みます。VB の RootNamespace も `Directory.Build.props` と Import を展開したプロジェクトから読みます。Condition の外で最後に設定した値を使い（`<RootNamespace />` は空の名前空間です。`$(MSBuildProjectName)` はプロジェクト名です。他のプロパティはプロジェクト名のまま警告します）、それより後に Condition の下で設定した値があれば、その名前空間にも型を宣言したものとして警告します。`<Using Remove>`・VB の `<Import Remove>` はそれより前の項目を外します（大文字小文字は区別しません）。Condition の下にある Remove は評価せず、外さずに警告します。VB の `<Import Include="A;B">` もアイテムのリストとして読み、属性の順序は問いません。同じ別名に行き先が複数ある場合（Debug と Release で Condition を分けた `<Using Alias>` など）は、全部を辺にして警告します。`<Using Include="A;B">` はアイテムのリストとして読み、`Alias`・`Static` は子要素（`<Using Include="Lib.A"><Alias>X</Alias></Using>`）でも読みます。子要素に Condition があっても評価せず、成り立つものとして取り込み、警告します。同じ `<Using>` に条件の違う `<Alias>` が複数あれば、全部の別名を取り込みます。空の `<Alias>`（`<Alias Condition="..." />`）は「別名なし」の候補で、通常の using としても取り込みます。空の候補が無い条件付き `<Alias>` は、通常の using にはしません。プロパティを含む `<Using>`（`$(NS).A`）は評価できないので使わず、警告して `unresolved.tsv` にプロジェクトファイルの行として載せます（VB の `<Import Include>` も同じです）。VB の `Imports Global.X` はルートからの名前、行をまたぐ Imports も読みます。ビルド対象外のファイルに書かれた global using は、どのファイルにも効きません。プロジェクトファイルの XML コメント（`<!-- ... -->`）の中は読みません。どのプロジェクトのディレクトリにも無い共有ファイルを Condition 付きでだけ取り込んでいる場合も、`unresolved.tsv` に載せます。`global using static`（と `<Using Static="true">`）は、その型のメンバーを書いている同じプロジェクトのファイルから辺になります。属性値に生の `<` があるタグ（MSBuild 自身も読めない不正な XML）は読めないので、行番号付きの警告を出します。ファイルはテキストとして読むだけで、MSBuild や Maven は実行しません。
- **拡張メソッドは受け手の型で絞ります。** `x.Name()` は、見える名前空間にある拡張メソッド `Name` への辺になります。`string.Join(...)` や `Math.Min(...)` のような静的呼び出しは数えません。ただし `File`・`Path`・`Math` などの名前が、同じファイルの変数・引数・フィールド・プロパティの名前でもあれば（`void M(Thing File) { File.Save(); }`）、静的呼び出しとはみなしません。`x` の型が分かる（変数・引数・フィールド・`this`）ときは、受け手の型が合う拡張メソッドだけを辺にし、その型自身に同名のメンバーがあれば辺にしません。型が分からず、`Add`・`Contains`・`Select` のようにフレームワークの型にも同名のメンバーがあり、拡張メソッドの受け手もフレームワークの型のときは、辺にせず `unresolved.tsv` に載せます。
- **入れ子の型**（クラスの中のクラスや delegate）は同名の型の重複とはみなしません。入れ子の型の名前は、まずそれを宣言したファイルの中ではその型を指し（Java の `DescriptorImpl` のように多くのクラスが同名の入れ子を持っていても、別のファイルの入れ子へ辺を出しません）、`Outer.Inner` と書けばその型を指します。別のファイルからは単純名では見えないので、外側の名前空間にある入れ子の型が using 先の同名の型を隠すことはありません（ほかに候補が無いときだけ入れ子の型を辺にします）。それ以外で同じ名前のトップレベルの型があれば、その名前はトップレベルの型を指します。VB.NET も同じです。ただし Module の中の型は名前空間の型として扱われるので、入れ子とはみなしません。
- 宣言されている名前（C# の `public string Schema {`、`Foo bar =`、`void Run(` の `Schema`・`bar`・`Run`、Java の `int Customer;`・`void Order()`、VB の `Property Customer As Integer`・`Sub Order()`・引数やローカル変数の `customer As String`・`Dim order`）と enum のメンバー名（`enum EntityType { Customer, Order }`、値に書いた兄弟のメンバー `Both = Order | Customer` や Java の定数の引数 `Bar(Gadget)` も。定数に付けた Java のアノテーション `@Ann A`・`@a.b.Ann(x) A` はアノテーション型への参照です）は型の参照として数えません（同名の型へ偽の辺と偽の循環が出ていました）。コンパイラと同じく、その名前が見える範囲での後の使用も数えません。メソッドの引数とローカル変数（`message As String` の後の `message.Length`、`order += 1`、VB のラムダ引数 `Sub(order)`。引数とローカル変数はその手続きの中だけ、ラムダ引数はその行だけで見えます。別の手続きの `Order.Create()` はクラスです）、その型のメンバー（プロパティ `Category` を持つクラスの中の `Category == "food"`、`Log(Name, Category)`、`$"{Category}: {Name}"`、`Validate()`。partial の別の部分や基底クラスが宣言したメンバーも含みます）、VB の名前付き引数（`Create(order:=1)`）です。型しか書けない位置（`As Order`・`new Order()`・`(Order)x`・`List<Order>`・`Dictionary<int, Order>`・`Order x`・`Order? Order { get; set; }`・`Wrapper<int> Wrapper`・`(Order, int) pair`・`o is not Order`・`operator Order(...)`・属性、VB の `List(Of Order)`・`CType(x, Order)`・`DirectCast`/`TryCast` の第2引数・`TypeOf x Is Order`）では、その名前は型を指します。
- **同じ型を partial なしで2つのファイルが宣言しているとき**は、2つを互いに結びません（結ぶと偽の循環になります）。その型を使うファイルからは両方へ辺を出し、`unresolved.tsv` に「also declared in ...」と載せます。ビルドから片方が外れている、あるいはプロジェクトが分かれているはずなので確認してください。VB の Module のメンバー（`Sub Log` が2つの Module にある）は重複として扱いません。C# で型引数の数が違う同名の型（`Result` と `Result<T>`）も別の型です。`Result<int>` は総称の方、`Result`（`Result.Ok()` も）はもう一方を指します（`Result<(int Id, string Name)>` の型引数はタプル1個です）。partial も型引数の数が同じ部分だけを結びます（`Result` と `partial class Result<T>` は結びません）。VB の `Result` と `Result(Of T)` も同じく別の型です。VB は `Partial` を一部分にだけ書けばよいので（WinForms の `Public Class Form1` とデザイナーの `Partial Class Form1`）、どの部分も互いに結びます。
- **まだ見落とすもの：** ラムダ引数の型、入れ子の型と同じ名前のトップレベルの型を、同じファイルの別のクラスから使う参照（ファイル内では入れ子の型を指すとみなします）、ジェネリックメソッドの型推論、オーバーロードの選択、`dynamic`、VB の With ブロック。レビュー根拠（一緒に読むファイル）として不足していないかは、[準備監査](PREPARATION-AUDITS.md)の抜き取りと `dependency-diff` で確かめてください。
- PHP の名前は、書かれた位置で取りうるものだけを引きます。`f()` は関数、`new Foo`・`Foo::x`・`Foo $x`・`extends Foo`・属性 `#[Route('/home')]`・戻り値の型（`): Result`・`): ?Result`・`): A|B`）・union の引数型（`A|B $x`）はクラス、裸の `FOO` は定数です（同名の定数が無く、全部大文字の名前とクラスの綴りが同じときだけクラス）。`date()` や `define('DEBUG', ...)` は、クラス `Date`・`Debug` を指しません。
- PHP の関数・クラス・定数は、そのファイル自身が宣言していればそれを指します。複数のファイルが宣言しているときは、そのファイルの include（たどった先も含む）が読み込むものを選び、読み込む先に無ければ全部を辺にします（develop/ のスクリプトにコピーされた `define()` へ、本体から辺が出ていました）。
- PHP の `if (!function_exists('f')) { function f() ... }` のように存在チェックで囲んだ宣言（互換用の予備の定義）は、囲まれていない `f` の宣言があればそちらだけを辺にします（テーマの予備の定義へ core から辺が出て、偽の循環になっていました）。囲まれた宣言しかなければ、それを辺にします。
- PHP はメソッド呼び出し先が実行時に決まる言語なので、本物の構文解析器を使っても `$obj->m()` の行き先は分かりません。COBOL の依存は COPY と CALL の名前だけで決まります。この2言語では、本物の解析器を使っても得られる情報はあまり増えません。ただし同梱版が読むのは書かれた名前と、計算できるパス（`__DIR__`・`dirname(__FILE__)`・`DIRECTORY_SEPARATOR`・`DS`・`realpath()`）だけです。それ以外は `unresolved.tsv` に載ります。`"...{$this->t(Cls::class)}..."` やヒアドキュメントの `{$...}` の中はコードとして読みます（nowdoc は読みません。穴の中の `'Order'` のような引用符付きの文字列と `${name}` は名前として扱いません）。`class_alias(Orig::class, 'Old')`（`\class_alias('Orig', 'Old')` も）の別名はそのファイルが宣言するクラスとして扱い、別名が計算される場合は `unresolved.tsv` に載せます。PHP の文字列 callable は、コールバックを受け取る関数（`array_map`・`usort`・`call_user_func`・`add_action` など）のコールバックの位置にある文字列引数と、`['Cls', 'm']` の形のときだけ、同名の関数・クラスへの辺にします。`call_user_func('strtolower', 'business')` の `business` や `add_action('init', ...)` のフック名のようなデータの引数、配列キーなどの普通の文字列は、参照として扱いません。名前付き引数も、関数ごとの引数名で読みます（`call_user_func(callback: 'f')`、`preg_replace_callback_array(pattern: [...])`、`session_set_save_handler(open: ..., update_timestamp: ...)`。session のハンドラーは9つとも読み、ハンドラーオブジェクトを渡す形は `new Cls` ならそのクラス、変数なら `unresolved.tsv` です）。`['Cls', 'm']` は末尾カンマ付きでも、`array()` でも、メソッド名が変数（`['Cls', $method]`）でも、`Cls` への辺になります。`is_a($x, 'Cls')`・`is_subclass_of` の文字列はクラス名として扱います。コールバックの位置にある引数が、変数を含まない文字列・`null`・クロージャ・`f(...)`・クラスが決まっているペア（`[$this, 'm']`・`['Cls', 'm']`・`['Cls', $method]`・`[Cls::class, 'm']`・`[new Cls, 'm']`）のどれでもない場合（`call_user_func($cb)`・`usort($a, $this->cmp)`・`"on_$x"`・`'on_' . $x`・`get_callback()`・`[$class, 'm']` など）と、`$f()` のような変数関数の呼び出しは、`unresolved.tsv` に載せます。コールバックやクラス名を受け取る関数の表は閉じています（上の関数のほか `mb_ereg_replace_callback`・`xml_set_*_handler`・`stream_wrapper_register`・`new ReflectionClass`/`ReflectionMethod` を読みます）。それ以外の関数に渡した文字列は読みません。クラス名を受け取る位置の変数（`new ReflectionClass($name)`・`is_a($x, $cls)`）は、オブジェクトのことも多いので `unresolved.tsv` に載せません。式の中の include（`if (!include_once 'x.php') {`）は、その括弧や演算子までを include のパスとして読みます。`namespace\f()` は今の名前空間の f だけを指し（`use function` やグローバル関数には行きません）、名前空間の宣言ではありません。`--root` の中に無ければ、`\App\Billing\Invoice` と書いたときと同じく `external.tsv` に載ります。`use function A\f;` で取り込んだ `f()` もその関数だけを指します。式の中の include は `or` でも終わり、`include 'a.php' or fallback();` の右辺はコードとして読みます。`__DIR__` や `dirname(__FILE__)` で場所が決まる include は、そのパスにファイルが無ければ、別の場所の同名ファイルを辺にはせず `unresolved.tsv` に載せます。

## 対象範囲と既知の制限

同梱の解析器は、書かれたソースとプロジェクトファイルをテキストとして読む静的な近似です。コンパイラ・MSBuild・PHP の実行と同じ結果を目指すものではありません。今後の不具合の報告は、次の線で扱います。

**直すもの（不具合）**

- 普通に書かれたコードで、実際の依存の辺が出ない（見落とし）
- 実際には無い循環が出る（偽の循環）
- 解析器が落ちる、または同じ入力で出力が変わる
- 文書に書いた動作と実際の動作が違う
- 以前の版で正しかった出力が変わる（デグレ）

**直さないもの（既知の制限。ここに書いて終わりにします）**

- **MSBuild の評価。** Condition・プロパティ（`$(X)`）・SDK や NuGet パッケージが持ち込む .props/.targets・`--root` の外やプロパティで指す Import・Target の実行は評価しません。読める範囲は「精度について」に書いたとおりで、それを超える組み合わせ（プロパティで決まる RootNamespace、条件の真偽で変わる項目の順序など）はこれ以上まねません。分からないところは多めの辺・警告・`unresolved.tsv` のどれかで知らせます。
- **型推論とオーバーロード。** ラムダ引数の型、ジェネリックメソッドの型推論、オーバーロードの選択、`dynamic`、VB の With ブロックは追いません（「まだ見落とすもの」を参照）。
- **実行時に決まる名前。** PHP の変数関数・計算されるクラス名や include パス（`--include-var` で値を与えたものと、文書に書いた計算できる形を除く）、autoload（composer.json 以外）、C#・Java のリフレクション、COBOL の動的 CALL（同じファイルの VALUE/MOVE のリテラル以外）は `unresolved.tsv` に載せるだけです。
- **余分な辺。** 戻り値や変数を通る型の流れで出る、実際には使っていない辺は、見落としより安全な側として残します（偽の循環になる場合だけ直します）。

制限に当たるケースは、まず `unresolved.tsv` と警告に出ているかを確かめ、出ていなければ「直すもの」として扱います。出ていれば、そのファイルを `review-dependencies.json` に手で足してください。

## 解析器の結果を確かめる

1. 5ファイル試行：全体を作る前に5ファイルで実行し、`edges.tsv` と `unresolved.tsv` をユーザーに見せる
2. `unresolved.tsv` を全件確認する：外部ライブラリなら問題なし、リポジトリ内のファイルを指すべきものは `review-dependencies.json` に追記する
3. `external.tsv` で自作ライブラリが無いか見る：C#・VB.NET・Java・PHP の解析器は、どのファイルも宣言していない名前空間・パッケージ（using/Imports/import と、型の位置に書いた完全修飾名 `Acme.Billing.Invoice inv;`・`new`・継承リストと where 制約の各型・Java の extends/implements/throws の各型・属性・アノテーション。PHP は名前空間付きの名前）を、名前空間ごとに1行（名前空間、使っているファイル数、最初のファイル）で書きます。親の名前空間も載るときは親の行にまとめます（`log4net.Config` は `log4net` の行）。兄弟の名前空間（`com.fasterxml.jackson.databind` と `com.fasterxml.jackson.core`）は別の行です。System・Microsoft・Windows・Mono、java・javax・jakarta・jdk・sun・com.sun・org.w3c・org.xml などの標準ライブラリは載りません（javax・jakarta は丸ごと外すので、`javax.inject` や `jakarta.persistence` も載りません）。C#・VB.NET の本文中の完全修飾名は、名前空間の部分が2段以上（または `global::`）のときだけ数えます（`Environment.SpecialFolder` は標準クラスの入れ子かもしれないため）。`Imports System`／`using System` があるファイルでは、`Collections.Generic.List` のように System の下の名前空間（Collections・IO・Net・Text・Data など）から始まる名前は System からの相対とみなして数えません。ジェネリック引数（`List<Acme.X>`）・`?` 付き・タプルの要素・キャスト・Java の `Acme.X.class` に書いた完全修飾名は読みません（同じ名前空間を using/import でも書いていれば載ります）。Java はいつもパッケージ（先頭の小文字の段）で載せます（`import static a.b.Util.*` も `a.b`）。PHP はコードが書いた名前で決めます（`use Acme\Billing;` と `Billing\Invoice` なら `Acme\Billing`、どこでも使わない `use` はクラスとみなします）。PHP の名前空間は大文字小文字を区別せずにまとめ、PHP 自身の `Random`・`Dom`・`Pdo`・`BcMath`・`Uri`・`FFI` などは載せません。VB.NET は最初に書かれた大文字小文字で載せます。Spring や log4net のような一般の外部ライブラリは載りますが、問題ありません。自作ライブラリなのにソースが `--root` の外にあると辺が出ないので、ここに出たら、そのソースも入る親ディレクトリを `--root` にして作り直します。ソースが無い（DLL・JAR だけ）なら、移行計画でそのライブラリをどう扱うか（一緒に移す・そのまま使う）をユーザーと決めます
4. 除外ディレクトリ（各スクリプト冒頭のコメントに記載）が案件に合っているか確認する。ビルド出力（bin・obj・target・build・out）や vendor・packages は、`--root` 直下かビルドファイル（.csproj・pom.xml・composer.json など）の横にあるときだけ除外します。同じ名前のパッケージやフォルダは読みます。除外したディレクトリにソースがあれば警告（`WARN skipped ...`）が出ます。ディレクトリのシンボリックリンクはたどります（同じディレクトリが2つのパスで見えるときは両方のファイルとして読みます）。祖先を指すループだけは止めて `WARN symlink loop not followed` を出します
5. 軽い監査を1回だけ行う：`preparation_cli.mjs dependency-targets` が、`unresolved.tsv` に載ったファイル（行の多い順）と大きいファイルから約10件を選びます。新しい監査担当1人がその辺をソースから書き出し、`dependency-diff` で比べます。見落としは解析器のコピーか宣言を直して全体を作り直し、同じファイルで比べ直します。2人×20ファイルの抜き取りを何ラウンドも繰り返すことはせず、残った未解決は止めずに report.md に書きます（[準備監査](PREPARATION-AUDITS.md)）。source-as-spec ではこの監査も行わず、02 の仕様一式レビューで代えます
6. 結果は `migration/depmap/report.md` にまとめる（対応構文、除外、未解決、監査結果）

## 同梱されていない言語：アダプタを自作する

同梱版のない言語（RPG、PL/I、Delphi、VB6、Perl など）や、同梱版では足りない構文がある場合は、エージェントが**アダプタ（専用の解析器）**を書きます。エージェントが推測で書いた依存グラフは使えません。作り方のコツ（Python で同梱版をコピーして作るか、他の言語で作るかの選び方、どの同梱版から始めるか、フィクスチャの作り方）は **depmap-adapter スキル**にまとめてあります。VB6・VBA（`.frm`・`.bas`・`.cls`）は VB.NET の解析器では読めません（`.vb` だけを読みます）。`source-spec check` もアダプタの作成を案内し、解析器は読むファイルが0件のとき警告します。

### 守ること

- **静的解析だけ。** ソースファイルを読むだけにする。元のアプリのビルド・実行・テストはしない（ソースが唯一の仕様の案件では、元のアプリが動かないことが前提）
- **置き場所は `migration/tools/depmap-<言語>/`。** キット本体（`migration-kit/`）は変更しない
- **出力は同梱版と同じ契約。** `edges.tsv`（ヘッダー `from<TAB>to`）、`order.txt`、`cycles.txt`、`unresolved.tsv`（ヘッダー `file<TAB>reference<TAB>reason`）。外部ライブラリを見分けられるなら `external.tsv`（ヘッダー `namespace<TAB>files<TAB>first_file`）も。パスは `--root` からの相対パスで `/` 区切り、並びは整列済み
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

### 同梱版が落ちた・足りないとき

同梱の解析器がエラーで止まった、または案件の構文を読めない（`unresolved.tsv` に同じ理由の行が大量に出る、明らかな辺が出ない）ときは、作業を止めずに次の順で対処します。

1. **まずオプションで直せないか見る。** `--include-var`・`--include-path`・`--copy-path`、`--root` の取り方、除外ディレクトリの警告で解決することがあります
2. **直せなければ、同梱版をコピーして直してよい。** 解析器と、それが読み込む共通部分（`depmap_common.py`・`depmap_typed.py`・`depmap_projects.py` のうち必要なもの）を `migration/tools/depmap-<言語>/` にコピーし、そこで直します。キット本体（`migration-kit/`）のファイルは変更しません。直す前に、落ちる・読めない最小の例をフィクスチャとして作り、期待する出力を手で書きます（上の手順2・3と同じ）
3. **`depmap/report.md` に書く。** 元のエラー（またはどの構文を読めなかったか）、どこを直したか、フィクスチャ、同梱版との出力の違い（辺の数・循環・未解決の件数）
4. **ユーザーに知らせる。** 工程01の報告で、同梱版ではなく直したコピーを使ったことを伝えます。直し方が推測に頼るとき（その構文の意味が言語仕様から決まらないなど）は、使う前にユーザーに確認します

どの場合も、エージェントが推測で書いた依存グラフは使いません。
