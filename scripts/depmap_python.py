#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
# Copilot adaptation: dependency parsing/decoding updated on 2026-10-26; see NOTICE.
"""Deterministic dependency mapper for Python codebases (stdlib only).

Implements the kit's dependency-map contract (prompts/01-dependency-map.md):
  - parses imports via ast (never regex, never agent judgment)
  - in-repo edges only: stdlib and third-party imports are neither edges nor misses
  - emits edges.tsv (one edge per line), order.txt (topological migration order,
    SCC-condensed), cycles.txt (every strongly connected component > 1 file)
  - all output is repo-relative FILE PATHS (e.g. toml/decoder.py), matching
    depmap_ts.mjs / depmap_c.py and the queue/manifest contract; dotted module
    names are used internally for import matching only

Usage:
  python3 depmap_python.py --root path/to/repo --out path/to/migration/depmap

Test: python3 scripts/depmap_python.py --root fixtures/python --out /tmp/depmap-py && diff /tmp/depmap-py/edges.tsv fixtures/python/expected_edges.tsv && diff /tmp/depmap-py/cycles.txt fixtures/python/expected_cycles.txt && diff /tmp/depmap-py/order.txt fixtures/python/expected_order.txt

Determinism: files walked in sorted order, edges and outputs sorted. Two runs
on the same tree produce byte-identical output.
"""

import argparse
import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, write_outputs, checked_source_roots  # noqa: E402

# Directories never walked. Any path component in this set — or starting with
# "." — is excluded. Kept visible at the top per CONTRIBUTING's requirement
# that the exclusion list be inspectable without reading the walker.
SKIP_DIRS = {"venv", "node_modules", "__pycache__", "generated"}
# A repository-copy install (migration-kit/) and run metadata (migration/) are
# never sources to port. Skip them only at the top of --root and only when the
# marker proves it is the kit, so a real package named "migration" is kept.
KIT_DIRS = {"migration-kit": "scripts/run_migration.mjs", "migration": "config.json"}


def find_py_files(root: Path, warnings=None, source_roots=()):
    return find_files(root, {".py"}, warnings=warnings, skip_all=SKIP_DIRS, source_roots=source_roots)


def module_name(path: Path, root: Path) -> str:
    rel = path.relative_to(root).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) if parts else "__init__"


def build_module_index(files, root):
    return {module_name(p, root): p for p in files}


def resolve_import(node, current_mod, is_pkg, index):
    """Yield in-repo module names imported by this ast node. Unknown names are
    silently skipped — third-party is neither an edge nor a miss."""
    if isinstance(node, ast.Import):
        for alias in node.names:
            name = alias.name
            while name:
                if name in index:
                    yield name
                    break
                name = name.rpartition(".")[0]
    elif isinstance(node, ast.ImportFrom):
        if node.level:  # relative import
            # Anchor package: for pkg/__init__.py the module IS the package,
            # so level 1 means pkg itself; for pkg/mod.py drop the module name
            # first so level 1 also lands on pkg.
            base = current_mod.split(".")
            if not is_pkg:
                base = base[:-1]
            base = base[: max(0, len(base) - (node.level - 1))]
            mod = ".".join(base + ([node.module] if node.module else []))
        else:
            mod = node.module or ""
        candidates = [mod] + [f"{mod}.{alias.name}" for alias in node.names if mod]
        for cand in candidates:
            name = cand
            while name:
                if name in index:
                    yield name
                    break
                name = name.rpartition(".")[0]


def extract_edges(files, root, unresolved=None):
    """Return (sorted path edges, sorted path nodes). Import matching happens
    on dotted module names; edges are mapped back to repo-relative paths."""
    index = build_module_index(files, root)
    rel = {p: p.relative_to(root).as_posix() for p in files}
    edges = set()
    for path in files:
        src_mod = module_name(path, root)
        is_pkg = path.name == "__init__.py"
        try:
            # Parsing bytes honors Python's encoding cookie and UTF-8 BOM.
            # Replacing undecodable bytes changes identifiers and loses imports.
            tree = ast.parse(path.read_bytes(), filename=str(path))
        except (SyntaxError, ValueError, RecursionError, UnicodeError, LookupError, OSError) as e:
            print(f"WARN unparseable, no edges emitted: {path} ({e})", file=sys.stderr)
            if unresolved is not None:
                reason = getattr(e, 'msg', None) or getattr(e, 'strerror', None) or str(e)
                unresolved.add((rel[path], "(whole file)", f"Python source not parsed: {reason}"))
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for dep_mod in resolve_import(node, src_mod, is_pkg, index):
                    if dep_mod != src_mod:
                        edges.add((rel[path], rel[index[dep_mod]]))
    return sorted(edges), sorted(rel.values())


def tarjan_scc(nodes, edges):
    """Iterative Tarjan. Returns list of SCCs (each a sorted list of nodes),
    in reverse topological order of the condensation."""
    adj = {n: [] for n in nodes}
    for a, b in edges:
        adj[a].append(b)
    for n in adj:
        adj[n].sort()
    index_counter = [0]
    stack, on_stack = [], set()
    index, lowlink = {}, {}
    sccs = []

    for start in sorted(nodes):
        if start in index:
            continue
        work = [(start, 0)]
        while work:
            node, pi = work[-1]
            if pi == 0:
                index[node] = lowlink[node] = index_counter[0]
                index_counter[0] += 1
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
                    lowlink[node] = min(lowlink[node], index[succ])
            if recurse:
                continue
            if lowlink[node] == index[node]:
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
                lowlink[parent] = min(lowlink[parent], lowlink[node])
    return sccs


def migration_order(nodes, edges):
    """Topological order over the SCC condensation: dependencies first.
    Returns (ordered list of SCCs, cycles)."""
    sccs = tarjan_scc(nodes, edges)
    # Tarjan emits SCCs in reverse topological order of the condensation
    # (a component is finished only after everything it depends on);
    # dependencies-first = the order Tarjan finished them.
    cycles = [s for s in sccs if len(s) > 1]
    return sccs, cycles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--source-root", action="append", default=[], help="source directory relative to --root; repeatable")
    args = ap.parse_args()

    root = args.root.resolve()
    if not root.is_dir():
        ap.error(f"--root is not a directory: {args.root}")
    warnings = []
    files = find_py_files(root, warnings, checked_source_roots(root, args.source_root, ap))
    unresolved = set()
    edges, nodes = extract_edges(files, root, unresolved)
    order, cycles = migration_order(nodes, edges)

    write_outputs(args.out, nodes, edges, unresolved)
    for warning in warnings:
        print(f"WARN {warning}", file=sys.stderr)

    print(f"files={len(files)} edges={len(edges)} batches={len(order)} cycles={len(cycles)}")
    print(f"wrote {args.out}/edges.tsv, order.txt, cycles.txt")
    if not files:
        print("WARN: no Python source files under --root; check the language and source roots", file=sys.stderr)
    if len(files) > 1 and not edges:
        print(
            "WARN: 0 edges across multiple files. If these files import each "
            "other, --root is probably pointing at the package directory "
            "instead of the repo root (imports like 'pkg.mod' can't resolve "
            "when the module index says 'mod').",
            file=sys.stderr,
        )


if __name__ == "__main__":
    # A Windows console encoding (cp932, cp1252...) cannot print every path.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="backslashreplace")
    main()
