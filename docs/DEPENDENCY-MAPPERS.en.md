# Dependency mappers (bundled and project-written)

[日本語](DEPENDENCY-MAPPERS.md) | English

Phase 01's dependency map comes from a **deterministic mapper that only reads source text**. It never builds or runs the original application. [Source as the only specification](SOURCE-AS-SPEC.en.md) uses the same mappers.

## Bundled mappers

All of them need only the Python 3 standard library (nothing to install; Windows, macOS and Linux alike).

| Source language | Command | Where edges come from |
|---|---|---|
| Python | `python3 migration-kit/scripts/depmap_python.py --root src --out migration/depmap` | imports (parsed with ast) |
| JS / TS | `node migration-kit/scripts/depmap_ts.mjs --root src --out migration/depmap` | import / export from / require |
| C / C++ | `python3 migration-kit/scripts/depmap_c.py --root src --out migration/depmap` | `#include "..."`, same-stem header |
| C# | `python3 migration-kit/scripts/depmap_csharp.py --root src --out migration/depmap` | type names (namespaces, using, global using, aliases, using static, extension methods, partial types) |
| Java | `python3 migration-kit/scripts/depmap_java.py --root src --out migration/depmap` | type names (same package, imports, `pkg.*`, static imports, qualified names) |
| VB.NET | `python3 migration-kit/scripts/depmap_vbnet.py --root src --out migration/depmap` | type names and Module members (Imports, RootNamespace, case-insensitive) |
| PHP | `python3 migration-kit/scripts/depmap_php.py --root src --out migration/depmap` | include / require paths; class, function and constant names (namespace, use) |
| COBOL | `python3 migration-kit/scripts/depmap_cobol.py --root src --out migration/depmap` | COPY, EXEC SQL INCLUDE, CALL 'PROG', EXEC CICS LINK/XCTL |

On Windows use `py` or `python` instead of `python3`.

Extra options (comma-separated paths relative to `--root`):

- PHP: `--include-var phpbb_root_path=phpBB/,phpEx=php` gives the values of variables (`$NAME`) and constants (`NAME`) used in include paths (a directory is relative to `--root`). A variable inside a `"..."` string or heredoc (`"$IP/includes/x.php"`) is replaced too (`$IP` inside `'...'` is text). A constant every `define()` gives the same relative literal (`define('WPINC', 'wp-includes')`), and one defined as a path the mapper can compute (`define('DO_MAINTENANCE', dirname(__FILE__) . '/doMaintenance.php')`), is used without it, unless another `define()` of it gives a different value. Drupal's `.install`, `.test`, `.theme`, `.engine` and `.profile` files are read as PHP when they contain `<?php`. `--include-path lib,inc` gives PHP's include_path. A relative include is looked up there first, then next to the including file, then at `--root`. An explicit `./x` or `../x` is relative to the working directory and never uses include_path: it is looked up next to the including file and at `--root`; when those give two different files, both become edges and the include is listed in `unresolved.tsv`. `composer.json` autoload (PSR-4, PSR-0, classmap; not under vendor) is read automatically: a class declared in several files maps to the one autoload names.
- COBOL: `--copy-path copy,shared` gives the copybook search order (like SYSLIB or COBCPY). When a copybook name matches several files, the first listed directory wins; `COPY X OF LIB` looks first in a directory named LIB.

Every mapper writes:

- `edges.tsv`: one edge per line (from → to, paths relative to `--root`)
- `order.txt`: migration order, dependencies first, a cycle on one line
- `cycles.txt`: cycles of two or more files
- `unresolved.tsv` (C#, Java, VB.NET, PHP, COBOL): references the mapper saw but could not tie to a file, with the reason: computed includes, CALL through a data item, reflection with a computed name, an import of a type the repository's package does not declare

The same input always gives byte-identical output. Shift_JIS (cp932) sources are read too: a file that is not UTF-8 is read as cp932, then Latin-1, with a warning. A file that decodes as cp932 without a single kana or full-width punctuation mark (Western Windows-1252 text) is read as Latin-1.

## Accuracy (typed languages)

In C#, Java and VB.NET an import names a namespace, not a file, and types of the same namespace need no import. The mappers build a table of the types each file declares and resolve every name **written** in each file's code against it.

- **They follow types whose name is never written.** A table of each type's declared method, property and field types and its base types lets the mappers follow variables and call chains: in `var x = F(); x.M().N();` the return types of `F`, `M` and `N` become edges. Parameters, typed locals and foreach variables count; an element type such as `List<Order>` passes through indexers and LINQ-style calls.
- **Names resolve in the language's order.** Each name is looked up from the namespace block it is written in (a file with several blocks resolves each on its own). A using, alias or using static inside a block applies to that block and the blocks nested in it, not to another block of the same namespace. C# and VB.NET go from the innermost namespace outward one step at a time, and at each step look at that namespace's types, then at the aliases and usings written in its declaration (file-level and global usings form the last step; a using after `namespace N;` belongs to N); `global::X` / `Global.X` start at the root namespace; Java takes single-type imports, then its own package, then `pkg.*`. Candidates tied at the same level all become edges (leaning towards extra edges); a local variable named like a type becomes one too. `using static T` brings T's members and nested types, not the name T; `[Foo]` written as an attribute (`[Foo<int>]` and attributes on lambdas and finalizers too) counts both `Foo` and `FooAttribute` (C# takes the one that is an attribute), and `Foo` elsewhere (collection expressions such as `F([Foo])` or `{ [Foo] }` included) does not mean `FooAttribute`. A tuple or other non-name alias (`using P = (A a, B b);`) gives edges to its types from the file that writes it (for a global alias, that file only).
- **Project files narrow candidates.** C# and VB.NET read ProjectReference in `.csproj`/`.vbproj`; Java reads Maven (`pom.xml`) and Gradle (`build.gradle`) module dependencies. When a type name exists in several projects, only the referenced projects' files become edges. A file the build leaves out (`<Compile Remove>`, or missing from an old-style project's `<Compile Include>` list) declares nothing and is listed in `unresolved.tsv`. Include/Remove values are item lists (`a.cs;b.cs`). Wildcards follow MSBuild: `*` and `?` stay within one directory, `**` spans any depth. Attribute values may use either quote. An Include's `Exclude` applies to that Include only (`Include="**\*.cs" Exclude="Legacy\**"`); `Update` only changes metadata and is not read. Include and Remove apply in document order (`Include="Legacy\Keep.cs"` after `Remove="Legacy\**"` compiles Keep.cs again). Conditions and properties (`$(Gen)`) are not evaluated: a file added or left out only under a Condition (on the item, its ItemGroup, a `<Choose>` branch, or inside a `<Target>`) or by an item that uses a property keeps its declarations and is listed in `unresolved.tsv`. A file of another directory pulled in with `<Compile Include="..\Shared\X.cs" />` is also a file of the project that pulls it in (that project's global usings, references and VB RootNamespace apply; an alias that means a different type in each project gives an edge to each; and it is compiled even if its own project leaves it out). An SDK project that turns the default items off and lists no `<Compile>` makes its files "maybe" (an import the mapper does not read may list them). Default files need both `EnableDefaultItems` and `EnableDefaultCompileItems` on; either one set to false under a Condition makes the default files "maybe". ProjectReference paths ignore case. Gradle `project(":core")`, `project(path: ":core")`, Kotlin's `project(path = ":core")` and type-safe accessors (`projects.core`; `my-lib` is `projects.myLib`) are read. global using directives and aliases, `<Using Include>` and `<Import Include>` apply to the files of their own project. `global using static` (and `<Using Static="true">`) gives an edge from each file of the project that names a member of the type. A tag with a raw `<` in an attribute value (invalid XML that MSBuild cannot load either) is not read and is warned about with its line number. The files are read as text; MSBuild and Maven are never run.
- **Extension methods are narrowed by receiver type.** `x.Name()` gives an edge to an extension method `Name` of a visible namespace. A static call (`string.Join(...)`, `Math.Min(...)`) does not count. When `x`'s type is known (a variable, parameter, field or `this`), only extension methods whose receiver type matches become edges, and none when that type has a member of the name. When it is not known, the name is also a member of common framework types (`Add`, `Contains`, `Select`...) and the extension's receiver is a framework type too, the call is listed in `unresolved.tsv` instead of becoming an edge.
- **Nested types** (a class or delegate inside a class) are not duplicates of a same-named type. Inside the file that declares it, a nested type's name means that type (many Java classes each nesting a `DescriptorImpl` get no edges to each other's), and `Outer.Inner` means it anywhere; elsewhere, where a top-level type of that name exists, the name means it.
- A name a C# declaration introduces (`Schema`, `bar`, `Run` in `public string Schema {`, `Foo bar =`, `void Run(`) is not a type reference (a property named like a type gave a false edge).
- **A type declared without partial in two files**: the two are not linked to each other (that would be a false cycle). Files that use the type get an edge to both, and `unresolved.tsv` lists it as "also declared in ...". One copy is probably left out of the build or belongs to another project; check it. Members of VB modules (`Sub Log` in two modules) are not duplicates.
- **Still missed:** lambda parameter types, a top-level type used from another class of a file that nests a type of the same name (inside that file the name means the nested type), generic method type inference, overload resolution, `dynamic`, VB With blocks. Check that review evidence is complete with the [preparation audit](PREPARATION-AUDITS.md) samples and `dependency-diff`.
- A PHP declaration behind an existence check (`if (!function_exists('f')) { function f() ... }`, a back-compat fallback) is linked only where no unguarded `f` exists (core linked to every theme's fallback copy, a false cycle); when only guarded copies exist, they are the declarations.
- PHP decides `$obj->m()` at run time, so a full parser cannot resolve it either, and COBOL dependencies are just COPY and CALL names: for these two a real parser adds little. The bundled mappers still read only written names and paths they can compute (`__DIR__`, `dirname(__FILE__)`, `DIRECTORY_SEPARATOR`, `DS`, `realpath()`); the rest goes to `unresolved.tsv`. Code inside `{$...}` holes of `"..."` strings and heredocs counts (nowdocs are text; a quoted literal such as `'Order'` inside a hole and `${name}` are not names). A `class_alias(Orig::class, 'Old')` (or `\class_alias('Orig', 'Old')`) alias is a class of the file that calls it; a computed alias name is listed in `unresolved.tsv`. A PHP string callable gives an edge to the function or class of that name only as a string argument of a function that takes a callback (`array_map`, `usort`, `call_user_func`, `add_action`...) or in a `['Cls', 'm']` pair; array keys and other plain strings are not references.

## Checking a mapper's output

1. Five-file trial: run on five files before the whole tree and show `edges.tsv` and `unresolved.tsv` to the user.
2. Read every row of `unresolved.tsv`: external libraries are fine; anything that should point at a repository file goes into `review-dependencies.json`.
3. Check that the skipped directories (listed at the top of each script) suit the project. Build output (bin, obj, target, build, out), vendor and packages are skipped only at `--root` or beside a build file (.csproj, pom.xml, composer.json...); a package or folder with the same name is read. A skipped directory holding sources is printed as a warning (`WARN skipped ...`). Directory symlinks are followed (a directory seen under two paths is read under both); only a loop back to an ancestor is stopped, with `WARN symlink loop not followed`.
4. Summarise supported syntax, exclusions, unresolved references and audit results in `migration/depmap/report.md`.

## Languages without a bundled mapper: write an adapter

For a language with no bundled mapper (RPG, PL/I, Delphi, VB6, Perl...) or syntax the bundled one does not cover, the agent writes an **adapter** (a project-specific mapper). A dependency graph the agent guesses is not accepted.

### Rules

- **Static only.** Read source files. Never build, run or test the original (in source-as-spec projects the original is assumed not to run).
- **Put it under `migration/tools/depmap-<language>/`.** Do not change the kit (`migration-kit/`).
- **Same output contract as the bundled mappers.** `edges.tsv` (header `from<TAB>to`), `order.txt`, `cycles.txt`, `unresolved.tsv` (header `file<TAB>reference<TAB>reason`); `/`-separated paths relative to `--root`, sorted.
- **Deterministic.** Walk files in sorted order; the same input gives the same output; nothing depends on randomness, time or parallel scheduling.
- **Avoid installs.** Prefer the Python standard library. If a compiler library (Roslyn, JavaParser...) is needed, ask the user first: it needs network access or an SDK.
- **Prefer extra edges to missing ones.** When in doubt add the edge; never drop a reference you cannot resolve, write it to `unresolved.tsv`.
- **List skipped directories at the top of the script** so generated output, build output and third-party code exclusions are visible.

### Steps

1. List the constructs that create dependencies in the language (file inclusion, module references, type names, calls, wiring in configuration files).
2. Write a small fixture under `migration/tools/depmap-<language>/fixture/` with a cycle, a skipped directory, fake references inside comments and strings, and a dynamic reference.
3. Write the expected `expected_edges.tsv` and friends **by hand**, then implement the adapter and compare.
4. Run the five-file trial on the real source and show it to the user (phase 01 rule).
5. Generate the whole map and record supported and unsupported syntax, exclusions and unresolved references in `depmap/report.md`.

After changing the adapter, regenerate the map and redo phase 01's checks (five-file trial, audits, and the dependency declaration from `make_review_dependencies.mjs`).
