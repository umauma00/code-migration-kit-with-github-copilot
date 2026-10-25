#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Deterministic dependency mapper for COBOL codebases (stdlib only).

Implements the kit's dependency-map contract (prompts/01-dependency-map.md) by
reading COBOL source as text. It never compiles or runs a program.

Edges (names compared case-insensitively):
  - COPY name [OF|IN library] and EXEC SQL INCLUDE name END-EXEC -> the
    copybook file named name (with or without an extension: .cpy .cob .cbl
    .copy .inc .cobol), preferring the copying file's directory, then a
    directory named after the library, then a unique match anywhere under
    --root. SQLCA and SQLDA are the database's own and are not edges.
    Copybooks that COPY other copybooks get their own edges.
  - CALL 'PROG' / CALL "PROG", and EXEC CICS LINK/XCTL/START PROGRAM('PROG')
    -> the file whose PROGRAM-ID is PROG (or, failing that, whose name is PROG).

--copy-path DIR,DIR is the copybook library concatenation (SYSLIB, COBCPY):
when a copybook name matches several files, the first listed directory
holding it wins, and COPY X OF LIB looks first in a listed directory named
LIB.

Fixed format (sequence area in columns 1-6, indicator in column 7, code in
8-72) is assumed unless the file says >>SOURCE FORMAT FREE / $SET
SOURCEFORMAT"FREE", or its lines visibly start in column 1. A tab advances
to the next multiple of 8 columns. Comment lines (* or / in column 7, *>
anywhere outside a literal) are ignored.

Known limits, listed in unresolved.tsv:
  - CALL identifier and PROGRAM(identifier) are dynamic: the program name is
    data. A copybook or program that is not under --root (vendor or system
    libraries) is unresolved too, as is a name that matches several files.
  - COPY ... REPLACING is followed to the copybook but the replacement is
    not applied; JCL, PROCs and BMS maps are not read.

Skipped directories: node_modules, __pycache__ and every directory
starting with ".".

Usage:
  python3 depmap_cobol.py --root path/to/repo --out path/to/migration/depmap [--copy-path copy,shared]
Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)
and unresolved.tsv (file, reference, reason).

Test: python3 scripts/depmap_cobol.py --root fixtures/cobol --out /tmp/depmap-cobol && diff /tmp/depmap-cobol/edges.tsv fixtures/cobol/expected_edges.tsv
"""

import re
import sys
from pathlib import PurePosixPath, Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, path_list, read_source, run  # noqa: E402

PROGRAM_EXTS = {".cbl", ".cob", ".cobol", ".pco", ".sqb", ".ccp"}
COPY_EXTS = {".cpy", ".copy", ".inc", ".cpb"}
EXTS = PROGRAM_EXTS | COPY_EXTS
SYSTEM_INCLUDES = {"sqlca", "sqlda", "oraca"}
WORD = r"[A-Za-z0-9][A-Za-z0-9_-]*"
# Keywords are matched only as whole COBOL words: ON-CALL, WS-COPY and
# END-CALL are data names or scope terminators, not CALL or COPY.
LITERAL = r"""(?:'([^']*)'|"([^"]*)")"""
COPY_RE = re.compile(rf"(?<![\w-])COPY\s+(?:{LITERAL}|({WORD}))(?:\s+(?:OF|IN)\s+(?:{LITERAL}|({WORD})))?", re.IGNORECASE)
SQL_INCLUDE_RE = re.compile(rf"(?<![\w-])EXEC\s+SQL\s+INCLUDE\s+(?:{LITERAL}|({WORD}))", re.IGNORECASE)
CALL_RE = re.compile(rf"(?<![\w-])CALL\s+(?:{LITERAL}|({WORD}))", re.IGNORECASE)
CICS_RE = re.compile(rf"(?<![\w-])EXEC\s+CICS\s+(LINK|XCTL|START|LOAD|RELEASE|ENABLE|HANDLE\s+ABEND)\b(?:(?!END-EXEC)[^.])*?\bPROGRAM\s*\(\s*(?:{LITERAL}|({WORD}))\s*\)", re.IGNORECASE | re.DOTALL)
PROGRAM_ID_RE = re.compile(rf"\bPROGRAM-ID\s*\.?\s*(?:{LITERAL}|({WORD}))", re.IGNORECASE)
FREE_RE = re.compile(r">>\s*SOURCE\s+(?:FORMAT\s+)?(?:IS\s+)?FREE|\$\s*SET\s+SOURCEFORMAT\s*\(?\s*[\"']?FREE", re.IGNORECASE)
FREE_START_RE = re.compile(r"^(?:IDENTIFICATION|ID|PROCEDURE|DATA|ENVIRONMENT)\s+DIVISION\b|^(?:0[1-9]|[1-4][0-9]|66|77|88)\s+[A-Za-z]", re.IGNORECASE)


def code_lines(text):
    """Source text without sequence area, indicator column and comments."""
    # A tab moves to the next multiple of 8 columns, as editors of fixed
    # format show it (a leading tab puts the code in Area A).
    lines = [line.expandtabs(8) for line in text.splitlines()]
    free = bool(FREE_RE.search(text)) or any(FREE_START_RE.match(line) for line in lines)
    out = []
    for line in lines:
        if free:
            body = line
            if body.lstrip().startswith(("*", "/")) and not body.lstrip().startswith("*>"):
                body = ""
        else:
            indicator = line[6:7]
            if indicator in {"*", "/"}:
                continue
            body = line[7:72]
            if indicator == "-":
                # Continuation: glue to the previous line (a continued literal
                # restarts with a quote that the previous line left open).
                cont = body.lstrip()
                if out and cont[:1] in {"'", '"'}:
                    out[-1] = out[-1].rstrip() + cont[1:]
                elif out:
                    out[-1] = out[-1].rstrip() + " " + cont
                continue
        out.append(body[:comment_start(body)])
    return mask_literals("\n".join(out))


def comment_start(body):
    """Where a floating *> comment starts in body (len(body) if none). A
    *> inside a literal (DISPLAY '*>') is text."""
    quote = None
    for i, c in enumerate(body):
        if quote:
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif body.startswith("*>", i):
            return i
    return len(body)


OPERAND_RE = re.compile(r"(?:(?<![\w-])CALL|(?<![\w-])COPY|(?<![\w-])INCLUDE|\bPROGRAM\s*\(|\bPROGRAM-ID\s*\.?|(?<![\w-])OF|(?<![\w-])IN|(?<![\w-])CANCEL)\s*$", re.IGNORECASE)
STRING_RE = re.compile(r"'[^'\n]*'|\"[^\"\n]*\"")


def mask_literals(text):
    """Blank every literal that is not a program or copybook name, so that
    DISPLAY "CALL 'X'" is not read as a CALL."""
    def repl(m):
        # The keyword may sit lines above the literal (CALL / 'X' on its own line).
        before = text[max(0, m.start() - 400):m.start()].rstrip()
        if OPERAND_RE.search(before[-24:]):
            return m.group(0)
        return m.group(0)[0] + " " * (len(m.group(0)) - 2) + m.group(0)[-1]
    return STRING_RE.sub(repl, text)


def name_of(m, first):
    """The literal or word captured by a pattern's groups starting at first."""
    for g in range(first, first + 3):
        if m.group(g) is not None:
            return m.group(g).strip()
    return None


def mapper(root, warnings, args):
    files = find_files(root, EXTS, warnings=warnings)
    rels = [p.relative_to(root).as_posix() for p in files]
    texts = {rel: code_lines(read_source(path, warnings)) for rel, path in zip(rels, files)}

    by_stem, by_name, programs = {}, {}, {}
    for rel in rels:
        p = PurePosixPath(rel)
        by_stem.setdefault(p.stem.lower(), []).append(rel)
        by_name.setdefault(p.name.lower(), []).append(rel)
        for m in PROGRAM_ID_RE.finditer(texts[rel]):
            programs.setdefault(name_of(m, 1).lower(), []).append(rel)

    copy_paths = [p for p in path_list(args.copy_path)]

    def copybook(src, name, lib):
        key = name.lower()
        cands = by_name.get(key) or [r for r in by_stem.get(key, []) if PurePosixPath(r).suffix.lower() in COPY_EXTS] \
            or by_stem.get(PurePosixPath(key).stem, [])
        if not cands:
            return None, "copybook not found under --root"
        # --copy-path is the library concatenation (SYSLIB, COBCPY): the
        # first directory in it holding the copybook wins; COPY X OF LIB
        # looks first in a listed directory named LIB.
        order = sorted(copy_paths, key=lambda d: not lib or PurePosixPath(d).name.lower() != lib.lower())
        for d in order:
            here_hits = [c for c in cands if str(PurePosixPath(c).parent).lower() == d.lower()]
            if len(here_hits) == 1:
                return here_hits, None
        if len(cands) == 1:
            return cands, None
        here = str(PurePosixPath(src).parent)
        same = [c for c in cands if str(PurePosixPath(c).parent) == here]
        if len(same) == 1:
            return same, None
        if lib:
            in_lib = [c for c in cands if lib.lower() in (part.lower() for part in PurePosixPath(c).parts[:-1])]
            if len(in_lib) == 1:
                return in_lib, None
        return None, f"copybook name matches {len(cands)} files"

    def program(name):
        key = name.lower()
        cands = programs.get(key) or [r for r in by_stem.get(key, []) if PurePosixPath(r).suffix.lower() in PROGRAM_EXTS]
        if not cands:
            return None, "called program not found under --root"
        if len(cands) > 1:
            return None, f"program name matches {len(cands)} files"
        return cands, None

    edges, unresolved = set(), set()
    for src in rels:
        text = texts[src]
        for m in COPY_RE.finditer(text):
            name, lib = name_of(m, 1), name_of(m, 4)
            hit, why = copybook(src, name, lib)
            if hit:
                edges.update((src, t) for t in hit)
            else:
                unresolved.add((src, f"COPY {name}" + (f" OF {lib}" if lib else ""), why))
        for m in SQL_INCLUDE_RE.finditer(text):
            name = name_of(m, 1)
            if name.lower() in SYSTEM_INCLUDES:
                continue
            hit, why = copybook(src, name, None)
            if hit:
                edges.update((src, t) for t in hit)
            else:
                unresolved.add((src, f"EXEC SQL INCLUDE {name}", why))
        for m in CALL_RE.finditer(text):
            literal = m.group(1) if m.group(1) is not None else m.group(2)
            if literal is None:
                unresolved.add((src, f"CALL {m.group(3)}", "program name held in a data item (dynamic CALL)"))
                continue
            hit, why = program(literal.strip())
            if hit:
                edges.update((src, t) for t in hit)
            else:
                unresolved.add((src, f"CALL '{literal.strip()}'", why))
        for m in CICS_RE.finditer(text):
            verb = " ".join(m.group(1).upper().split())
            literal = m.group(2) if m.group(2) is not None else m.group(3)
            if literal is None:
                unresolved.add((src, f"EXEC CICS {verb} PROGRAM({m.group(4)})", "program name held in a data item"))
                continue
            hit, why = program(literal.strip())
            if hit:
                edges.update((src, t) for t in hit)
            else:
                unresolved.add((src, f"EXEC CICS {verb} PROGRAM('{literal.strip()}')", why))
    return rels, edges, unresolved


if __name__ == "__main__":
    run("Map file dependencies of a COBOL codebase from its source text.", mapper,
        [("--copy-path", "comma-separated copybook directories (relative to --root), searched in order like SYSLIB/COBCPY")])
