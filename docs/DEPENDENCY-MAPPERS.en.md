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

- PHP: `--include-path lib,inc` gives PHP's include_path. A relative include is looked up there first, then next to the including file, then at `--root`. An explicit `./x` or `../x` is relative to the working directory and never uses include_path: it is looked up next to the including file and at `--root`; when those give two different files, both become edges and the include is listed in `unresolved.tsv`. `composer.json` autoload (PSR-4, PSR-0, classmap; not under vendor) is read automatically: a class declared in several files maps to the one autoload names.
- COBOL: `--copy-path copy,shared` gives the copybook search order (like SYSLIB or COBCPY). When a copybook name matches several files, the first listed directory wins; `COPY X OF LIB` looks first in a directory named LIB.

Every mapper writes:

- `edges.tsv`: one edge per line (from → to, paths relative to `--root`)
- `order.txt`: migration order, dependencies first, a cycle on one line
- `cycles.txt`: cycles of two or more files
- `unresolved.tsv` (C#, Java, VB.NET, PHP, COBOL): references the mapper saw but could not tie to a file, with the reason: computed includes, CALL through a data item, reflection with a computed name, an import of a type the repository's package does not declare

The same input always gives byte-identical output. Shift_JIS (cp932) sources are read too: a file that is not UTF-8 is read as cp932, then Latin-1, with a warning.

## Accuracy (typed languages)

In C#, Java and VB.NET an import names a namespace, not a file, and types of the same namespace need no import. The mappers build a table of the types each file declares and resolve every name **written** in each file's code against it.

- **They follow types whose name is never written.** A table of each type's declared method, property and field types and its base types lets the mappers follow variables and call chains: in `var x = F(); x.M().N();` the return types of `F`, `M` and `N` become edges. Parameters, typed locals and foreach variables count; an element type such as `List<Order>` passes through indexers and LINQ-style calls.
- **Names resolve in the language's order.** Each name is looked up from the namespace block it is written in (a file with several blocks resolves each on its own). C# and VB.NET look from the innermost namespace outward, then through using/Imports; `global::X` / `Global.X` start at the root namespace; Java takes single-type imports, then its own package, then `pkg.*`. Candidates tied at the same level all become edges (leaning towards extra edges); a local variable named like a type becomes one too.
- **Project files narrow candidates.** C# and VB.NET read ProjectReference in `.csproj`/`.vbproj`; Java reads Maven (`pom.xml`) and Gradle (`build.gradle`) module dependencies. When a type name exists in several projects, only the referenced projects' files become edges. A file the build leaves out (`<Compile Remove>`, or missing from an old-style project's `<Compile Include>` list) declares nothing and is listed in `unresolved.tsv`. Include/Remove values are item lists (`a.cs;b.cs`). Conditions are not evaluated: a file left out only under a Condition (on the item, its ItemGroup or a `<Choose>` branch) keeps its declarations and is listed in `unresolved.tsv`. global using directives and aliases, `<Using Include>` and `<Import Include>` apply to the files of their own project. The files are read as text; MSBuild and Maven are never run.
- **Still missed:** lambda parameter types, generic method type inference, overload resolution, `dynamic`, VB With blocks. Check that review evidence is complete with the [preparation audit](PREPARATION-AUDITS.md) samples and `dependency-diff`.
- PHP decides `$obj->m()` at run time, so a full parser cannot resolve it either, and COBOL dependencies are just COPY and CALL names: for these two the bundled mappers lose almost nothing to a real parser.

## Checking a mapper's output

1. Five-file trial: run on five files before the whole tree and show `edges.tsv` and `unresolved.tsv` to the user.
2. Read every row of `unresolved.tsv`: external libraries are fine; anything that should point at a repository file goes into `review-dependencies.json`.
3. Check that the skipped directories (listed at the top of each script) suit the project.
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
