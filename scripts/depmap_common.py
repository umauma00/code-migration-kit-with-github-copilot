# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Shared parts of the stdlib-only dependency mappers (depmap_csharp.py,
depmap_java.py, depmap_php.py, depmap_vbnet.py, depmap_cobol.py).

Every mapper keeps the kit's dependency-map contract (prompts/01-dependency-map.md):
edges.tsv, order.txt and cycles.txt with repo-relative file paths, sorted and
byte-identical across runs. These mappers also write unresolved.tsv: every
reference the mapper saw but could not tie to a file (a dynamic include, a
CALL through a variable, a reflection lookup, an import of an in-repo package
that declares no such type). It is audit input, not proof of completeness.

The mappers read source text only. They never build or run the original.
"""

import argparse
import sys
from pathlib import Path

# Never walked, for every language. Any path component starting with "." is
# skipped too. Language-specific additions (bin/obj, vendor, target...) are
# passed by each mapper and printed in its header comment.
COMMON_SKIP = {"node_modules", "__pycache__", "generated"}
# A repository-copy install (migration-kit/) and run metadata (migration/)
# are never sources to port. Skipped only at the top of --root and only when
# the marker proves it is the kit, as in depmap_python.py.
KIT_DIRS = {"migration-kit": "scripts/run_migration.mjs", "migration": "config.json"}


def find_files(root: Path, exts, skip_dirs=()):
    """Sorted source files under root whose suffix (case-insensitive) is in exts."""
    skip = COMMON_SKIP | set(skip_dirs)
    kit = {name for name, marker in KIT_DIRS.items() if (root / name / marker).is_file()}
    out = []
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in exts:
            continue
        parts = p.relative_to(root).parts
        if parts[0] in kit:
            continue
        if any(part.startswith(".") or part.lower() in skip for part in parts[:-1]):
            continue
        out.append(p)
    return sorted(out)


def read_source(path: Path, warnings):
    """Decode a source file. Legacy trees are often Shift_JIS (cp932) or
    Latin-1, so UTF-8 is tried first, then cp932, then Latin-1 (never fails).
    A fallback is reported because identifiers outside ASCII depend on it."""
    data = path.read_bytes()
    for enc in ("utf-8-sig", "cp932"):
        try:
            text = data.decode(enc)
            if enc != "utf-8-sig":
                warnings.append(f"decoded as {enc}: {path}")
            return text
        except UnicodeDecodeError:
            continue
    warnings.append(f"decoded as latin-1: {path}")
    return data.decode("latin-1")


def tarjan_scc(nodes, edges):
    """Iterative Tarjan. Returns SCCs (each sorted), dependencies first."""
    adj = {n: [] for n in nodes}
    for a, b in edges:
        adj[a].append(b)
    for n in adj:
        adj[n].sort()
    counter = [0]
    stack, on_stack = [], set()
    index, low = {}, {}
    sccs = []
    for start in sorted(nodes):
        if start in index:
            continue
        work = [(start, 0)]
        while work:
            node, pi = work[-1]
            if pi == 0:
                index[node] = low[node] = counter[0]
                counter[0] += 1
                stack.append(node)
                on_stack.add(node)
            recurse = False
            for i in range(pi, len(adj[node])):
                succ = adj[node][i]
                if succ not in index:
                    work[-1] = (node, i + 1)
                    work.append((succ, 0))
                    recurse = True
                    break
                elif succ in on_stack:
                    low[node] = min(low[node], index[succ])
            if recurse:
                continue
            if low[node] == index[node]:
                scc = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    scc.append(w)
                    if w == node:
                        break
                sccs.append(sorted(scc))
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
    return sccs


def clean(text):
    # TSV cells: a tab or newline inside a reference would break the row.
    return " ".join(str(text).split())


def write_outputs(out: Path, nodes, edges, unresolved):
    """Write edges.tsv, order.txt, cycles.txt and unresolved.tsv; return
    (batches, cycles)."""
    edges = sorted(set(e for e in edges if e[0] != e[1]))
    sccs = tarjan_scc(nodes, edges)
    cycles = [s for s in sccs if len(s) > 1]
    rows = sorted(set((a, clean(r), clean(why)) for a, r, why in unresolved))
    out.mkdir(parents=True, exist_ok=True)

    def write(name, text):
        with open(out / name, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)

    write("edges.tsv", "from\tto\n" + "".join(f"{a}\t{b}\n" for a, b in edges))
    write("order.txt", "# migration order: one batch per line, dependencies first\n"
          + "".join("\t".join(s) + "\n" for s in sccs))
    write("cycles.txt", f"# strongly connected components > 1 file: {len(cycles)}\n"
          + "".join("\t".join(s) + "\n" for s in cycles))
    write("unresolved.tsv", "file\treference\treason\n"
          + "".join(f"{a}\t{r}\t{why}\n" for a, r, why in rows))
    return edges, sccs, cycles, rows


def run(description, mapper, options=()):
    """Command-line entry shared by the mappers. mapper(root, warnings, args)
    returns (files, edges, unresolved) with repo-relative POSIX paths.
    options: (flag, help) pairs for extra comma-separated list options."""
    for stream in (sys.stdout, sys.stderr):
        # A Windows console encoding (cp932, cp1252...) cannot print every path.
        stream.reconfigure(errors="backslashreplace")
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    for flag, text in options:
        ap.add_argument(flag, default="", help=text)
    args = ap.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        ap.error(f"--root is not a directory: {args.root}")
    warnings = []
    files, edges, unresolved = mapper(root, warnings, args)
    edges, sccs, cycles, rows = write_outputs(args.out, files, edges, unresolved)
    for w in warnings:
        print(f"WARN {w}", file=sys.stderr)
    print(f"files={len(files)} edges={len(edges)} batches={len(sccs)} cycles={len(cycles)} unresolved={len(rows)}")
    print(f"wrote {args.out}/edges.tsv, order.txt, cycles.txt, unresolved.tsv")
    if len(files) > 1 and not edges:
        print("WARN: 0 edges across multiple files. Check that --root covers the "
              "whole source tree, and read unresolved.tsv.", file=sys.stderr)


def path_list(value):
    """--opt a,b,c -> ['a', 'b', 'c'] as POSIX paths relative to --root."""
    return [p.strip().replace("\\", "/").strip("/") or "." for p in value.split(",") if p.strip()]


def nearest(rel, dirs):
    """The deepest directory of dirs (POSIX, relative, "" = root) holding rel."""
    parts = rel.split("/")[:-1]
    for k in range(len(parts), -1, -1):
        d = "/".join(parts[:k])
        if d in dirs:
            return d
    return None


def reachable(start, deps):
    """start plus everything deps (node -> iterable of nodes) reaches from it."""
    seen, todo = set(), [start]
    while todo:
        node = todo.pop()
        if node not in seen:
            seen.add(node)
            todo.extend(deps.get(node, ()))
    return seen
