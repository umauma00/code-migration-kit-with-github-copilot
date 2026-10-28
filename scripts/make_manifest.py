#!/usr/bin/env python3
# Copilot adaptation: migration control and instructions updated on 2026-10-08; see NOTICE.
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
r"""Build migration/manifest.tsv from a depmap order.txt (stdlib only, deterministic).

Reads order.txt (one tab-separated batch of source file paths per line; `#`
lines are comments), derives each target path by applying the --sub
substitutions (repeatable, applied in order, simple string replacement), and
writes a TSV with header `source\ttarget`, preserving batch order —
dependencies first, so queue_runner.mjs hands out work in migration order.

--ext .OLD=.NEW (repeatable) replaces a file extension at the end of the
path only; source-spec check fills it in from the source and target languages.

--map-root SOURCE=TARGET (repeatable) remaps only a leading directory prefix,
longest match first, before --sub. Use it for generated multi-root suggestions;
the old --sub behavior remains a global text substitution.

Targets must come out matching the rulebook's naming rules (RULEBOOK.md §4) —
the --sub substitutions are how you encode those rules. If any derived target
equals its source (the substitutions didn't apply), the script refuses and
exits 1 rather than write a manifest that points targets back at sources.

Usage:
  python3 make_manifest.py --order migration/depmap/order.txt \
      --out migration/manifest.tsv --sub 'src_prefix=dst_prefix' --sub '.py=.ts'

  When the parser ran with --root src, its paths are relative to src; add
  --prefix src/ so manifest sources stay repository-relative. When it ran
  from the repository root, --include src/ keeps only the source roots.

Test: python3 scripts/make_manifest.py --order fixtures/python/expected_order.txt --out /tmp/manifest.tsv --sub 'pkg/=ts/' --sub '.py=.ts' && diff /tmp/manifest.tsv fixtures/python/expected_manifest.tsv
"""

import argparse
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--order", required=True, type=Path,
                    help="depmap order.txt (batches of source paths, deps first)")
    ap.add_argument("--out", required=True, type=Path,
                    help="manifest TSV to write (header: source\\ttarget)")
    ap.add_argument("--sub", action="append", default=[], metavar="OLD=NEW",
                    help="substitution old=new, repeatable, applied in order")
    ap.add_argument("--ext", action="append", default=[], metavar=".OLD=.NEW",
                    help="replace the file extension .OLD at the end of a path with .NEW (repeatable); "
                         "applied after --map-root, before --sub")
    ap.add_argument("--map-root", action="append", default=[], metavar="SOURCE=TARGET",
                    help="map a source directory prefix to a target directory (repeatable, longest prefix first); applied before --sub")
    ap.add_argument("--prefix", default="", metavar="DIR/",
                    help="prepend to every order.txt path; use when the parser ran with "
                         "--root DIR so its paths are relative to DIR")
    ap.add_argument("--include", action="append", default=[], metavar="DIR/",
                    help="keep only sources under these directories (repeatable); "
                         "use when the parser walked more than the source roots")
    args = ap.parse_args()

    for value in args.sub + args.ext:
        if "SOURCE_EXT" in value or "TARGET_EXT" in value:
            print(f"ERROR: {value!r} still holds the placeholder; name the real extensions, "
                  "for example --ext '.cs=.ts'", file=sys.stderr)
            sys.exit(1)
    exts = []
    for value in args.ext:
        old, sep, new = value.partition("=")
        if not sep or not old.startswith(".") or "/" in old + new:
            print(f"ERROR: --ext must look like '.old=.new', got: {value!r}", file=sys.stderr)
            sys.exit(1)
        exts.append((old, new))
    exts.sort(key=lambda e: -len(e[0]))
    subs = []
    for s in args.sub:
        old, sep, new = s.partition("=")
        if not sep or not old:
            print(f"ERROR: --sub must look like 'old=new', got: {s!r}", file=sys.stderr)
            sys.exit(1)
        subs.append((old, new))

    root_maps = {}
    for value in args.map_root:
        old, sep, new = value.partition('=')
        for directory in (old, new):
            if not directory or (directory != '.' and (directory.startswith('/') or
                    any(part in ('', '.', '..') for part in directory.split('/')) or
                    any(c in directory for c in ('\\', ':', '\t', '\n', '\r', '\x00')))):
                ap.error('--map-root needs normalized relative directories: SOURCE=TARGET')
        if not sep or old in root_maps:
            ap.error('--map-root needs unique SOURCE=TARGET mappings')
        root_maps[old] = new
    ordered_maps = sorted(root_maps, key=lambda p: (-len(p), p))

    try:
        order = args.order.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        print(f"ERROR: {args.order} is not UTF-8 (byte {e.start}). A source file name that is "
              "not UTF-8 (a Shift_JIS name unpacked on Linux, for example) cannot go into the "
              "manifest: rename those files to UTF-8 (the dependency mapper listed them as "
              "warnings) and run the mapper again.", file=sys.stderr)
        sys.exit(1)
    rows = []
    for line in order.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        for source in line.split("\t"):
            if not source:
                continue
            if args.prefix:
                source = args.prefix.rstrip("/") + "/" + source
            if args.include and not any(source.startswith(p.rstrip("/") + "/") for p in args.include):
                continue
            target = source
            if root_maps:
                selected = next((p for p in ordered_maps if p == '.' or source.startswith(p + '/')), None)
                if selected is None:
                    raise SystemExit(f"ERROR: no --map-root mapping for source: {source!r}")
                suffix = source if selected == '.' else source[len(selected) + 1:]
                target = suffix if root_maps[selected] == '.' else root_maps[selected] + '/' + suffix
            for old, new in exts:
                if target.lower().endswith(old.lower()):
                    target = target[:-len(old)] + new
                    break
            for old, new in subs:
                target = target.replace(old, new)
            if target == source:
                print(
                    f"ERROR: derived target equals source for {source!r} — the "
                    "--sub substitutions didn't apply. Refusing to write a "
                    "manifest whose targets point back at the sources.",
                    file=sys.stderr,
                )
                sys.exit(1)
            rows.append((source, target))

    seen_sources, seen_targets = set(), set()
    for source, target in rows:
        for value in (source, target):
            if value.startswith('/') or any(part in ('', '.', '..') for part in value.split('/')) or any(c in value for c in ('\\', ':', '\n', '\r', '\x00')):
                raise SystemExit(f"ERROR: invalid relative path: {value!r}")
        if source.casefold() in seen_sources or target.casefold() in seen_targets:
            raise SystemExit(f"ERROR: duplicate source/target mapping: {source} -> {target}")
        seen_sources.add(source.casefold())
        seen_targets.add(target.casefold())
    if any(target.casefold() in seen_sources for _, target in rows):
        raise SystemExit("ERROR: a target overlaps a source file")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write("source\ttarget\n")
        for source, target in rows:
            f.write(f"{source}\t{target}\n")
    print(f"wrote {args.out}: {len(rows)} units")


if __name__ == "__main__":
    # A Windows console encoding (cp932, cp1252...) cannot print every path.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="backslashreplace")
    main()
