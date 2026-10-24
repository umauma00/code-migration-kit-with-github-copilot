---
name: depmap-adapter
description: Write or fix a dependency-map adapter for phase 01 of a code migration when no bundled mapper covers the source language, or a bundled mapper fails or cannot read the project's syntax. Not for running or building the original application.
---

# Dependency-map adapter

Read [dependency mappers](../../../docs/DEPENDENCY-MAPPERS.md) for the output contract
and the rules; this skill adds how to choose and how to build. A dependency
graph the agent guesses is never accepted, and the original application is
never built, run or tested to map it.

## 1. Try the bundled mapper first

Run the bundled mapper with its options (`--include-var`, `--include-path`,
`--copy-path`, the choice of `--root`) and read its warnings. Most "it misses
edges" cases are a wrong `--root` or a missing option. An in-house library
whose source is outside `--root` shows up in `unresolved.tsv` as "namespace no
file under --root declares": put its source under `--root` (map the parent
directory) rather than writing an adapter.

## 2. Choose the implementation language

| Choose | When |
|---|---|
| **Python, standard library only** (default) | Always possible: the kit already needs Python. Copying the bundled mappers is allowed and is the fastest start. |
| **Another language** (the source language, e.g. a Roslyn or JavaParser syntax tree, or the target language) | Only when its runtime is already installed, the adapter reads source text only (a syntax tree, never a compile or run of the project), and the user agreed: a parser library needs a download and an SDK. |

Either way the adapter lives in `migration/tools/depmap-<language>/`, never in
`migration-kit/`, and writes the same four files.

## 3. Copy the closest bundled mapper (Python)

| Source looks like | Start from |
|---|---|
| Types and namespaces/packages (Delphi, Kotlin, Scala, Go, Swift) | `depmap_java.py` or `depmap_csharp.py` with `depmap_typed.py` |
| Line-oriented, `Imports`-style (VB6, VBA) | `depmap_vbnet.py` with `depmap_typed.py` |
| File includes and global names (Perl, Ruby, ASP classic) | `depmap_php.py` |
| Copybooks and program calls (PL/I, RPG, JCL) | `depmap_cobol.py` |
| `#include` (other C dialects) | `depmap_c.py` |

Copy the mapper and every `depmap_*.py` it imports. Prefer one built on
`depmap_common.py` (all but `depmap_c.py` and `depmap_python.py`): it gives the
file walk, encoding fallback, SCC order and the output writer.
Keep `run()` and `write_outputs()` unchanged so the contract holds; change only
the scanner and the resolver.

## 4. Build it fixture first

1. List the syntax that creates a dependency: file includes, module or
   package imports, type names, calls, configuration that binds names.
2. Write a small fixture tree in `migration/tools/depmap-<language>/fixture/`
   with: a cycle, a reference inside a comment and inside a string (not an
   edge), a dynamic reference (an `unresolved.tsv` row), two files declaring
   the same name, a nested or qualified name, and an excluded build directory.
3. Write `expected_edges.tsv`, `expected_cycles.txt` and
   `expected_unresolved.tsv` by hand, then make the adapter match them.
4. When fixing a bundled-mapper failure, the smallest file that fails is the
   first fixture.

## 5. Habits that kept the bundled mappers right

- **Strip comments and strings first**, keeping line numbers; read names from
  the code that remains. Interpolated strings are code inside their holes.
- **Index declarations, then resolve.** Scan every file for what it declares,
  then resolve each reference against that index in the language's lookup
  order. Do not guess from file names.
- **More edges rather than fewer, but never a false cycle.** When candidates
  tie, add them all, except two copies of one declaration: never link copies
  to each other. A name the file itself declares (a property, a parameter, a
  nested type) means that declaration.
- **Undecidable goes to `unresolved.tsv`**, with a reason a person can act on.
- **Deterministic:** walk files sorted, sort every set before output, and run
  twice with different `PYTHONHASHSEED` values to compare.
- **Linear time:** never rescan a file per token; time the largest file of the
  real tree.
- **Run with `python -I`** and keep the adapter's imports beside it.

## 6. Check on the real tree and report

Run the five-file trial and show it (phase 01 rule). Then run the whole tree:
sample ten edges and ten `unresolved.tsv` rows against the source, open the
largest cycle and check a few of its edges. Write in `depmap/report.md` the
supported and unsupported syntax, the exclusions, the unresolved count and, for
a fixed copy, the original error and the output difference from the bundled
mapper. After any change, regenerate the map and redo phase 01's checks.
