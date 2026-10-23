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

Every mapper writes:

- `edges.tsv`: one edge per line (from → to, paths relative to `--root`)
- `order.txt`: migration order, dependencies first, a cycle on one line
- `cycles.txt`: cycles of two or more files
- `unresolved.tsv` (C#, Java, VB.NET, PHP, COBOL): references the mapper saw but could not tie to a file, with the reason: computed includes, CALL through a data item, reflection with a computed name, an import of a type the repository's package does not declare

The same input always gives byte-identical output. Shift_JIS (cp932) sources are read too: a file that is not UTF-8 is read as cp932, then Latin-1, with a warning.

## Accuracy (typed languages)

In C#, Java and VB.NET an import names a namespace, not a file, and types of the same namespace need no import. The mappers build a table of the types each file declares and resolve every name **written** in each file's code against it.

- **They lean towards extra edges.** When several visible types match a simple name, every candidate becomes an edge; a local variable named like a type becomes one too.
- **They miss types whose name is never written**: the type of `x` in `var x = F(); x.M();`, types in the middle of a call chain, lambda parameter types. The edge to the file declaring `F` is still there, so the migration order usually connects indirectly. Check that review evidence is complete with the [preparation audit](PREPARATION-AUDITS.md) samples and `dependency-diff`.
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
