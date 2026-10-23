#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Deterministic dependency mapper for C# codebases (stdlib only).

Implements the kit's dependency-map contract (prompts/01-dependency-map.md) by
reading .cs files as text. It never builds or runs the project.

A C# `using` names a namespace, not a file, so edges come from type names
(scripts/depmap_typed.py): each file's declared namespaces, types (class,
struct, interface, enum, record, delegate) and extension methods form a table,
and every name a file's code mentions is resolved through its enclosing
namespaces, using directives, global usings (in .cs files and
<Using Include> in .csproj), using aliases and using static. [Foo] also
matches FooAttribute. Fully qualified names, string literals that equal a
declared type's full name (Type.GetType("A.B")) and partial types (all parts
linked) count too.

Known limits, listed in unresolved.tsv where the source shows them:
  - a type used without its name being written (var x = F(); x.M(), chained
    calls, lambda parameters) gives no direct edge; the edge to F's file
    usually connects it indirectly. Audit these with the sample/diff CLI.
  - a local variable with a type's name gives an extra edge (conservative).
  - every #if branch is mapped; source generators and T4 output that is not
    checked in is invisible.
  - reflection with a computed name (Type.GetType(x), Activator.CreateInstance,
    Assembly.Load) is reported as unresolved.

Skipped directories: bin, obj, packages, plus node_modules, __pycache__,
generated and every directory starting with ".".

Usage:
  python3 depmap_csharp.py --root path/to/repo --out path/to/migration/depmap
Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)
and unresolved.tsv (file, reference, reason).

Test: python3 scripts/depmap_csharp.py --root fixtures/csharp --out /tmp/depmap-cs && diff /tmp/depmap-cs/edges.tsv fixtures/csharp/expected_edges.tsv
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, read_source, run  # noqa: E402
from depmap_typed import FileInfo, TOKEN_RE, chains, dotted, members, resolve, strip_c_like  # noqa: E402

EXTS = {".cs"}
SKIP_DIRS = {"bin", "obj", "packages"}
TYPE_KEYWORDS = {"class", "struct", "interface", "enum", "record"}
KEYWORDS = set("""abstract as base bool break byte case catch char checked class const continue
decimal default delegate do double else enum event explicit extern false finally fixed float for
foreach goto if implicit in int interface internal is lock long namespace new null object operator
out override params private protected public readonly ref return sbyte sealed short sizeof
stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe
ushort using virtual void volatile while var dynamic nameof await async yield when where get set
init value add remove partial global record nint nuint not and or with""".split())
REFLECTION_RE = re.compile(r"\b(Type\s*\.\s*GetType|Activator\s*\.\s*CreateInstance|Assembly\s*\.\s*Load\w*)\s*\(\s*((?:[^()]|\([^()]*\))+?)?\s*\)")
CSPROJ_USING_RE = re.compile(r'<Using\s+Include\s*=\s*"([^"]+)"(?![^>]*\bStatic\s*=\s*"true")', re.IGNORECASE)


def read_dotted(toks, j):
    """Dotted name starting at toks[j]; returns (name, next index)."""
    parts = []
    while j < len(toks):
        t = toks[j][0]
        if t == "global" and j + 2 < len(toks) and toks[j + 1][0] == ":" and toks[j + 2][0] == ":":
            j += 3
            continue
        if not (t[0].isalpha() or t[0] in "_@"):
            break
        parts.append(t.lstrip("@"))
        j += 1
        if j < len(toks) and toks[j][0] == ".":
            j += 1
            continue
        break
    return ".".join(parts), j


def scan(rel, text):
    info = FileInfo(rel)
    code, info.strings = strip_c_like(text, csharp=True)
    toks = [(m.group(0), m.start(), m.end()) for m in TOKEN_RE.finditer(code)]
    blank = []          # spans of directives, not counted as mentions
    globals_ = []
    depth, file_ns, stack = 0, "", []  # stack: (namespace, depth before its "{")

    def current():
        return ".".join(p for p in [file_ns] + [n for n, _ in stack] if p)

    i = 0
    while i < len(toks):
        t, start, _ = toks[i]
        prev = toks[i - 1][0] if i else ";"
        if t == "{":
            depth += 1
        elif t == "}":
            depth -= 1
            while stack and stack[-1][1] >= depth:
                stack.pop()
        elif t == "namespace":
            name, j = read_dotted(toks, i + 1)
            if j < len(toks) and toks[j][0] == ";":
                file_ns = name
            else:
                stack.append((name, depth))
            info.namespaces.add(current())
            blank.append((start, toks[j - 1][2] if j > i + 1 else toks[i][2]))
            i = j
            continue
        elif t == "using" and prev in {";", "{", "}", "]", "global"}:
            j = i + 1
            static = j < len(toks) and toks[j][0] == "static"
            j += static
            name, k = read_dotted(toks, j)
            if name and k < len(toks) and toks[k][0] in {";", "="}:
                if toks[k][0] == "=":
                    target, k2 = read_dotted(toks, k + 1)
                    info.aliases[name] = target
                    k = k2
                elif static:
                    info.direct.add(name)
                elif prev == "global":
                    globals_.append(name)
                else:
                    info.usings.add(name)
                while k < len(toks) and toks[k][0] != ";":
                    k += 1
                blank.append((toks[i - (prev == "global")][1], toks[min(k, len(toks) - 1)][2]))
                i = k + 1
                continue
        elif t in TYPE_KEYWORDS and prev not in {".", ":", ",", "<", "(", "new", "where"}:
            j = i + 1
            if t == "record" and j < len(toks) and toks[j][0] in {"class", "struct"}:
                j += 1
            if j < len(toks) and toks[j][0] not in KEYWORDS and (toks[j][0][0].isalpha() or toks[j][0][0] in "_@"):
                name = toks[j][0].lstrip("@")
                ns = current()
                info.namespaces.add(ns)
                info.decls.append((ns, name))
                k = i - 1
                while k >= 0 and toks[k][0] in KEYWORDS:
                    if toks[k][0] == "partial":
                        info.partial.add(f"{ns}.{name}" if ns else name)
                    k -= 1
        elif t == "delegate" and i + 1 < len(toks) and toks[i + 1][0] not in {"(", "{", "*"}:
            j = i + 1
            while j < len(toks) and toks[j][0] not in {"(", ";", "{"}:
                j += 1
            k = j - 1
            if k > i and toks[k][0] == ">":
                level = 0
                while k > i:
                    level += {">": 1, "<": -1}.get(toks[k][0], 0)
                    k -= 1
                    if level == 0:
                        break
            if k > i + 1 and toks[k][0] not in KEYWORDS:
                ns = current()
                info.namespaces.add(ns)
                info.decls.append((ns, toks[k][0].lstrip("@")))
        elif t == "(" and i + 2 < len(toks) and toks[i + 1][0] == "this" and toks[i - 1][0] not in KEYWORDS \
                and (toks[i + 2][0][0].isalpha() or toks[i + 2][0][0] == "_"):
            # Extension method: Name(this T x) or Name<T>(this T x).
            k = i - 1
            if toks[k][0] == ">":
                level = 0
                while k > 0:
                    level += {">": 1, "<": -1}.get(toks[k][0], 0)
                    k -= 1
                    if level == 0:
                        break
            name = toks[k][0]
            if name not in KEYWORDS and (name[0].isalpha() or name[0] == "_"):
                ns = current()
                info.namespaces.add(ns)
                info.extensions.append((ns, name))
        i += 1
    if not info.namespaces:
        info.namespaces.add("")
    for a, b in sorted(blank, reverse=True):
        code = code[:a] + " " * (b - a) + code[b:]
    info.names = chains(code, KEYWORDS)
    info.members = members(code)
    for m in REFLECTION_RE.finditer(code):
        arg = (m.group(2) or "").strip()
        if not arg.startswith('""'):
            info.dynamic.append((f"{dotted(m.group(1), False)}({arg})", "reflection with a computed type name"))
    return info, globals_


def mapper(root, warnings):
    files = find_files(root, EXTS, SKIP_DIRS)
    rels, infos, global_usings = [], [], set()
    for path in files:
        rel = path.relative_to(root).as_posix()
        info, globals_ = scan(rel, read_source(path, warnings))
        rels.append(rel)
        infos.append(info)
        global_usings.update(globals_)
    for proj in find_files(root, {".csproj"}, SKIP_DIRS):
        global_usings.update(CSPROJ_USING_RE.findall(read_source(proj, warnings)))
    edges, unresolved = resolve(infos, global_usings=global_usings, attribute_suffix="Attribute")
    return rels, edges, unresolved


if __name__ == "__main__":
    run("Map file dependencies of a C# codebase from its source text.", mapper)
