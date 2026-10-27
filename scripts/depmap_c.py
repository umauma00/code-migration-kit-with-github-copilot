#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
# Copilot adaptation: dependency parsing/decoding updated on 2026-10-26; see NOTICE.
"""Deterministic dependency mapper for C/C++ codebases (stdlib only).

Implements the kit's dependency-map contract (prompts/01-dependency-map.md).
Parses `#include "..."` directives — quoted includes only. Angle-bracket
includes (<stdio.h>, <vector>) are system/third-party: neither edges nor
misses. Each .c/.cc/.cpp file is also linked to its same-stem header when one
exists, since implementation→own-header is a real migration-order edge.

This is a starter: it does not run the preprocessor, so includes hidden behind
#ifdef are all counted (conservative: more edges, never fewer). For production
runs on macro-heavy trees, generate edges with `gcc -MM` per file instead and
keep the output contract identical.

Usage:
  python3 depmap_c.py --root path/to/repo --out path/to/migration/depmap
Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)

Test: python3 scripts/depmap_c.py --root fixtures/c --out /tmp/depmap-c && diff /tmp/depmap-c/edges.tsv fixtures/c/expected_edges.tsv && diff /tmp/depmap-c/cycles.txt fixtures/c/expected_cycles.txt && diff /tmp/depmap-c/order.txt fixtures/c/expected_order.txt
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files as source_files, read_source, UNREADABLE, write_outputs, checked_source_roots  # noqa: E402

EXTS = {".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"}
INCLUDE_RE = re.compile(r'^[ \t]*#[ \t]*include\b[ \t]*(.*)', re.MULTILINE)
QUOTED_INCLUDE = re.compile(r'^"([^"]+)"')
# Keep include path strings, but remove comments and C++ raw literals before
# looking for directives. Otherwise a comment can invent a migration cycle.
# Ordinary string and character literals end at the line (continuations are
# joined first), so a stray apostrophe such as #error don't cannot hide code.
C_TEXT = re.compile(r'''R"(?P<delimiter>[^ ()\\\t\r\n]{0,16})\([\s\S]*?\)(?P=delimiter)"|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|//[^\r\n]*|/\*[\s\S]*?(?:\*/|$)''')
SKIP_DIRS = {".git", "build", "vendor", "third_party", "node_modules"}


def find_files(root: Path, warnings=None, source_roots=()):
    return source_files(root, EXTS, warnings=warnings, skip_all=SKIP_DIRS, source_roots=source_roots)


def include_code(text):
    text = re.sub(r"\\\r?\n", "", text)  # preprocessor line continuations
    def mask(m):
        value = m.group(0)
        if value.startswith(('//', '/*', 'R"')):
            return ''.join('\n' if c == '\n' else ' ' for c in value)
        return value
    return C_TEXT.sub(mask, text)


def extract_edges(files, root, warnings=None, unresolved=None):
    rel = {p: p.relative_to(root).as_posix() for p in files}
    by_rel = {v: k for k, v in rel.items()}
    edges = set()
    for path in files:
        text = include_code(read_source(path, warnings if warnings is not None else []))
        for expression in INCLUDE_RE.findall(text):
            match = QUOTED_INCLUDE.match(expression)
            if not match:
                if unresolved is not None and not expression.lstrip().startswith('<'):
                    unresolved.add((rel[path], expression.strip() or '#include', 'computed or malformed include path'))
                continue
            inc = match.group(1)
            found = False
            # resolve relative to including file, then repo root
            for cand in ((path.parent / inc), (root / inc)):
                try:
                    cand_rel = cand.resolve().relative_to(root).as_posix()
                except ValueError:
                    continue
                if cand_rel in by_rel:
                    found = True
                    if cand_rel != rel[path]:
                        edges.add((rel[path], cand_rel))
                    break
            if not found and unresolved is not None:
                unresolved.add((rel[path], inc, 'quoted include not found under --root; check include directories'))
        # implementation -> own header
        if path.suffix in {".c", ".cc", ".cpp", ".cxx"}:
            for hext in (".h", ".hpp", ".hxx"):
                hdr = path.with_suffix(hext)
                if hdr in rel and rel[hdr] != rel[path]:
                    edges.add((rel[path], rel[hdr]))
    return sorted(edges), sorted(rel.values())


def tarjan_scc(nodes, edges):
    adj = {n: [] for n in nodes}
    for a, b in edges:
        adj[a].append(b)
    for n in adj:
        adj[n].sort()
    counter = [0]
    stack, on_stack = [], set()
    index, low = {}, {}
    sccs = []
    for start in nodes:
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--source-root", action="append", default=[], help="source directory relative to --root; repeatable")
    args = ap.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        ap.error(f"--root is not a directory: {args.root}")
    warnings, unresolved = [], set()
    UNREADABLE.clear()
    files = find_files(root, warnings, checked_source_roots(root, args.source_root, ap))
    edges, nodes = extract_edges(files, root, warnings, unresolved)
    for source, reason in UNREADABLE.items():
        unresolved.add((source.relative_to(root).as_posix(), '(whole file)', reason))
    sccs = tarjan_scc(nodes, edges)
    cycles = [s for s in sccs if len(s) > 1]

    write_outputs(args.out, nodes, edges, unresolved)
    for warning in warnings:
        print(f"WARN {warning}", file=sys.stderr)
    print(f"files={len(files)} edges={len(edges)} batches={len(sccs)} cycles={len(cycles)}")
    if not files:
        print("WARN: no C/C++ source files under --root; check the language and source roots", file=sys.stderr)
    if len(files) > 1 and not edges:
        print(
            "WARN: 0 edges across multiple files. If these files include each "
            "other, --root is probably pointing at the wrong directory, or the "
            '#include paths only resolve against -I include dirs (quoted '
            "includes are resolved relative to the including file, then the "
            "repo root; angle brackets are never edges).",
            file=sys.stderr,
        )


if __name__ == "__main__":
    # A Windows console encoding (cp932, cp1252...) cannot print every path.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="backslashreplace")
    main()
