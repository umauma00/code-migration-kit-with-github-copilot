# 00b〜02の言語別依存解析の精査

同梱8系統と共通処理、source-as-specのコマンド生成からmanifest・レビュー用依存宣言までを確認した。
依存マップそのものは通常01の処理だが、source-as-specでは00b〜02をまとめて準備するため、00bの作業中にも使う。
元のPython/PHP/C#/Java等のアプリは実行せず、ソースとプロジェクト設定の静的な読み取りで検証した。

## 再現して修正した不具合

| 対象 | 原因・影響 | 修正と確認 |
|---|---|---|
| Python | UTF-8を文字列として固定復号したためBOMで構文エラー、coding宣言付き非UTF-8識別子を置換して依存を欠落。`.py`というディレクトリもファイルとして読む | astへ元bytesを渡してPythonの復号規則を使用。ディレクトリを除外し、構文/AST/読取の失敗はwhole-file unresolvedとして保持。BOM・Latin-1・cp932識別子、深い式で検証 |
| PHP | composer.jsonのroot・autoload・PSR/classmap値の型が想定外だとAttributeError/TypeError。タグ付きDrupal拡張子を生bytesで判定してUTF-16ソースを落とす | スキーマの型を確認して不正部分を警告し、正常な設定を保持。タグを復号後に判定。異常なJSON構造とUTF-16 `.install` を確認 |
| C#・VB.NET | literal Importを再帰展開し、長い連鎖でRecursionError。`--root`外のImportも読んでしまう | 反復展開と循環検出に変更。1200段の末尾のUsing/Importsまで読む。外のImportは警告し、解析対象のmembershipを変更させない |
| Java | 共通ディレクトリ走査・Gradle設定のrglobが深いディレクトリで再帰に依存 | 反復走査へ統一。1050段のツリーを確認。Maven/Gradleの宣言先だけに同名型を解決する試験も実施 |
| C/C++ | `.h`というディレクトリを読むと例外。コメント・raw string内のincludeで偽の辺/循環。空白なし・コメント・行継続付きincludeを欠落 | ファイルだけを選択し、字句の除外と行継続を処理。未解決quoted includeとmacro includeはunresolvedへ |
| JS/TS | コメント・文字列・regex/template本文を依存と誤認。`.js/.mjs/.cjs`表記からTSソースへ戻れない。`require('./'+name)`を`./`と読んでindex.jsへの偽の辺を作る | 字句の除外、template式のliteral import、出力suffixの解決を追加。計算されたspecifierは未解決として記録。UTF-8不正・NUL・相対import失敗も残す |
| COBOL | 専用scannerの新たなクラッシュは今回のケースでは検出しなかった | 共通走査/読取の修正を適用。UTF-16/32・binaryの未解析記録・CALL依存・生成コマンドを確認 |
| 全言語のコマンド | sourceRootsの先頭しか解析しない。空白/引用符入りrootを引用せず失敗。複数rootのmanifest配置が未対応で、単純substitutionが途中の同名ディレクトリも置換 | 全rootの共通親を使い、シェル引数を引用。`--map-root SOURCE=TARGET`で先頭prefixだけを一度置換し、全対象をoutputRoots内へ配置する案を生成。8言語で後続まで実行 |
| 共通のI/O | ソースの読取失敗で全解析が例外終了。深いwalkや設定探索が再帰に依存 | 読取不可を明示的なwhole-file unresolvedにし、独立したファイルを継続。walk/設定探索を反復化し、リンクのループ検出と除外を保持 |

## 検証方法

- 最終 `npm test` は422件中420成功、失敗0、Windows専用skip 2。追加の言語別34件はすべて成功。`npm run demo` もcontinuousモードで成功し、12ケースの比較差分・skipとも0。`git diff --check` 成功。
- `tests/dependency-parsers.test.mjs`：言語別の最小再現、UTF-16/32・BOM・coding cookie・binary・読取失敗、設定の異常値、1200段Import/循環、1050段のディレクトリ、コメント由来の偽の循環を検証。
- source-as-specから提案されたコマンドを8言語すべてで実行し、両rootのファイルがmanifestにあり、AからBへの依存がレビュー用JSONまで届くことを確認。引用符を含むパスもPOSIX環境で実行した。
- 8系統をそれぞれ3回、Pythonはhash seed 0・1・42で動かし、edges/order/cycles/unresolvedのbytes一致を確認。
- 既存のPython/C/TSの期待出力と、C#/Java/VB.NET/PHP/COBOLの全既存fixtureを変更せず照合。既存の条件付きMSBuild・重複型・名前空間・autoload・書式等の検証を維持。
- 補助的な調査ではC#/Java/PHP/VB.NET scannerへ各800個の短い構文断片を与え、計3200ケースで想定外の例外がないことを確認。これは正しい意味解析や全構文の網羅を証明するものではない。

## 制限と適用範囲

解析器はstdlibによる静的な近似。MSBuildのCondition/プロパティ、コンパイラの型推論、実行時に決まる参照、tsconfig path aliases等は引き続き既知の制限。
Pythonは実行中のPythonが対応する構文のASTを使う。JS/TSのregex/文脈判断もコンパイラの完全な構文解析を置き換えない。
未解析・未解決の情報と警告を工程の監査で確認し、推測で依存を埋めたり、未解析ファイルを完了扱いにしない。
カンマ区切りCLIオプションのパス内カンマは未対応。Node/manifest/runnerへ渡すパスはUTF-8が必要。
移行先の実案件・画像のプロジェクトはこのworkspaceに無く、実データでの結果一致・Windows実機の動作は未確認。
