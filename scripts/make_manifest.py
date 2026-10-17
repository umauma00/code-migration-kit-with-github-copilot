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

Targets must come out matching the rulebook's naming rules (RULEBOOK.md §4) —
the --sub substitutions are how you encode those rules. If any derived target
equals its source (the substitutions didn't apply), the script refuses and
exits 1 rather than write a manifest that points targets back at sources.

Usage:
  python3 make_manifest.py --order migration/depmap/order.txt \
      --out migration/manifest.tsv --sub 'src_prefix=dst_prefix' --sub '.py=.ts'

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
    ap.add_argument("--include", action="append", default=[], metavar="DIR/",
                    help="keep only sources under these directories (repeatable); "
                         "use when the parser walked more than the source roots")
    args = ap.parse_args()

    subs = []
    for s in args.sub:
        old, sep, new = s.partition("=")
        if not sep or not old:
            print(f"ERROR: --sub must look like 'old=new', got: {s!r}", file=sys.stderr)
            sys.exit(1)
        subs.append((old, new))

    rows = []
    for line in args.order.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        for source in line.split("\t"):
            if not source:
                continue
            if args.include and not any(source.startswith(p.rstrip("/") + "/") for p in args.include):
                continue
            target = source
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
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("source\ttarget\n")
        for source, target in rows:
            f.write(f"{source}\t{target}\n")
    print(f"wrote {args.out}: {len(rows)} units")


if __name__ == "__main__":
    main()
