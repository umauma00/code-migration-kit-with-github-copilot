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

# Reason of an unresolved row that is really an external library: such rows
# go to external.tsv (namespace, files using it, first file), not
# unresolved.tsv. The reason carries the file count after the marker.
EXTERNAL = "\x00external:"

# Never walked, for every language. Any path component starting with "." is
# skipped too.
COMMON_SKIP = {"node_modules", "__pycache__"}
# A repository-copy install (migration-kit/) and run metadata (migration/)
# are never sources to port. Skipped only at the top of --root and only when
# the marker proves it is the kit, as in depmap_python.py.
KIT_DIRS = {"migration-kit": "scripts/run_migration.mjs", "migration": "config.json"}


def find_files(root: Path, exts, skip_dirs=(), markers=(), warnings=None):
    """Sorted source files under root whose suffix (case-insensitive) is in exts.

    skip_dirs are build-output or third-party directory names (bin, target,
    vendor...). One is skipped only at the top of root or beside a build
    file (markers: file names such as "pom.xml", or suffixes such as
    ".csproj"), so a package or folder that happens to be called build or
    out is still walked. skip_dirs may also map each name to its own
    markers. Each skipped directory holding source files is reported in
    warnings."""
    if isinstance(skip_dirs, dict):
        skip = {d.lower(): {m.lower() for m in ms} for d, ms in skip_dirs.items()}
    else:
        skip = {d.lower(): {m.lower() for m in markers} for d in skip_dirs}
    kit = {name for name, marker in KIT_DIRS.items() if (root / name / marker).is_file()}

    def beside_marker(d, wanted):
        try:
            return any(f.is_file() and (f.name.lower() in wanted or f.suffix.lower() in wanted)
                       for f in d.iterdir())
        except OSError:
            return False

    out, skipped = [], []

    def walk(d, top, ancestors):
        # A directory symlink is followed, so two paths to one directory are
        # both mapped (as copies); one that points back at a directory being
        # walked (a loop) is not.
        try:
            real = d.resolve()
            if real in ancestors:
                if warnings is not None:
                    warnings.append(f"symlink loop not followed: {d.relative_to(root).as_posix()}/")
                return
            entries = sorted(d.iterdir())
        except OSError:
            return
        ancestors = ancestors | {real}
        for p in entries:
            if p.is_dir():
                name = p.name
                if name.startswith(".") or name.lower() in COMMON_SKIP or (top and name in kit):
                    continue
                if name.lower() in skip and (top or beside_marker(d, skip[name.lower()])):
                    skipped.append(p)
                    continue
                walk(p, False, ancestors)
            elif p.is_file() and p.suffix.lower() in exts:
                out.append(p)

    walk(root, True, frozenset())
    if warnings is not None:
        for d in skipped:
            if any(p.is_file() and p.suffix.lower() in exts for p in d.rglob("*")):
                warnings.append(f"skipped build-output/third-party directory with sources: "
                                f"{d.relative_to(root).as_posix()}/")
    return sorted(out)


# Byte order marks, longest first (the UTF-32 LE one starts like UTF-16 LE's).
BOMS = ((b"\xff\xfe\x00\x00", "utf-32-le"), (b"\x00\x00\xfe\xff", "utf-32-be"),
        (b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be"))
UNREADABLE = {}     # path -> reason: files read_source could not decode as text


def read_source(path: Path, warnings):
    """Decode a source file. A UTF-16/UTF-32 byte order mark is followed;
    otherwise UTF-8 is tried first, then cp932 (legacy trees are often
    Shift_JIS), then Latin-1 (never fails). A fallback is reported because
    identifiers outside ASCII depend on it. Text with NUL bytes and no mark
    is read as UTF-16 when every other byte is NUL; else it is not text, and
    run() lists the file in unresolved.tsv."""
    data = path.read_bytes()
    for bom, codec in BOMS:
        if data.startswith(bom):
            try:
                return data[len(bom):].decode(codec)
            except UnicodeDecodeError:
                UNREADABLE[path] = f"starts with a {codec} byte order mark but does not decode; not analysed"
                return ""
    if b"\x00" in data:
        for codec, nuls in (("utf-16-le", data[1::2]), ("utf-16-be", data[0::2])):
            if len(data) % 2 == 0 and nuls.count(0) >= len(nuls) * 0.9:
                try:
                    text = data.decode(codec)
                    warnings.append(f"decoded as {codec} (no byte order mark): {path}")
                    return text
                except UnicodeDecodeError:
                    break
        UNREADABLE[path] = "holds NUL bytes (binary, or an encoding without a byte order mark); not analysed"
        return ""
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    try:
        text = data.decode("cp932")
        # Western text (a (c) or an accented letter in a comment) often
        # decodes as cp932 too, into half-width katakana or a stray kanji;
        # Japanese text has kana or full-width punctuation.
        if any(0x3000 <= ord(c) <= 0x30FF or 0xFF01 <= ord(c) <= 0xFF5E for c in text):
            warnings.append(f"decoded as cp932: {path}")
            return text
    except UnicodeDecodeError:
        pass
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
    """Write edges.tsv, order.txt, cycles.txt, unresolved.tsv and
    external.tsv; return (edges, batches, cycles, unresolved rows, external
    rows)."""
    edges = sorted(set(e for e in edges if e[0] != e[1]))
    sccs = tarjan_scc(nodes, edges)
    cycles = [s for s in sccs if len(s) > 1]
    external = sorted(set((clean(r), int(why[len(EXTERNAL):]), a)
                          for a, r, why in unresolved if why.startswith(EXTERNAL)))
    rows = sorted(set((a, clean(r), clean(why)) for a, r, why in unresolved if not why.startswith(EXTERNAL)))
    out.mkdir(parents=True, exist_ok=True)

    def write(name, text):
        # A file name that is not UTF-8 (a Shift_JIS name unpacked on Linux)
        # keeps its original bytes, so the path still opens.
        with open(out / name, "w", encoding="utf-8", errors="surrogateescape", newline="\n") as f:
            f.write(text)

    write("edges.tsv", "from\tto\n" + "".join(f"{a}\t{b}\n" for a, b in edges))
    write("order.txt", "# migration order: one batch per line, dependencies first\n"
          + "".join("\t".join(s) + "\n" for s in sccs))
    write("cycles.txt", f"# strongly connected components > 1 file: {len(cycles)}\n"
          + "".join("\t".join(s) + "\n" for s in cycles))
    write("unresolved.tsv", "file\treference\treason\n"
          + "".join(f"{a}\t{r}\t{why}\n" for a, r, why in rows))
    write("external.tsv", "namespace\tfiles\tfirst_file\n"
          + "".join(f"{n}\t{k}\t{a}\n" for n, k, a in external))
    return edges, sccs, cycles, rows, external


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
    listed = set(files)
    for path, why in sorted(UNREADABLE.items()):
        try:
            rel = path.resolve().relative_to(root).as_posix()
        except ValueError:
            rel = None
        if rel in listed:
            unresolved = set(unresolved) | {(rel, "(whole file)", why)}
        else:
            warnings.append(f"{why}: {path}")
    for f in files:
        try:
            f.encode("utf-8")
        except UnicodeEncodeError:
            warnings.append(f"file name is not UTF-8; written with its original bytes: "
                            f"{f.encode('utf-8', 'backslashreplace').decode('ascii', 'replace')}. "
                            "Later steps (make_manifest.py, the kit CLI) need UTF-8 paths: "
                            "rename it to UTF-8 and map again before building the manifest")
    edges, sccs, cycles, rows, external = write_outputs(args.out, files, edges, unresolved)
    for w in warnings:
        print(f"WARN {w}", file=sys.stderr)
    print(f"files={len(files)} edges={len(edges)} batches={len(sccs)} cycles={len(cycles)} unresolved={len(rows)} external={len(external)}")
    print(f"wrote {args.out}/edges.tsv, order.txt, cycles.txt, unresolved.tsv, external.tsv")
    if not files:
        print("WARN: no source files of this language under --root. Check --root, and that the "
              "language is the one this mapper reads (VB6/VBA .frm/.bas/.cls need an adapter).", file=sys.stderr)
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
