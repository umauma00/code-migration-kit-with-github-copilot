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

Types used without their name being written are followed through declared
types (scripts/depmap_typed.py, type flow): `var x = F(); x.M().N()` reaches
F's return type, M's and N's, through members inherited from base types too;
parameters, typed locals and foreach variables count, and an element type
(List<Order>) passes through indexers and LINQ-style calls.

Each name is resolved from the namespace block it is written in; global::
names from the root namespace only. A using, alias or using static inside
a namespace block applies to that block and the blocks nested in it.
global using directives and aliases (and <Using> items in .csproj) apply to
every file of their project; global using static gives an edge from the
files that name a member of its type.

.csproj files are read as text: a name declared in several projects only
gives edges into the projects the file's project references
(ProjectReference, transitively), and a file the project does not compile
(<Compile Remove>, or left out of an old-style project's <Compile Include>
list) declares nothing and is listed in unresolved.tsv. A file left out
only under a Condition keeps its declarations and is listed too.

Known limits, listed in unresolved.tsv where the source shows them:
  - lambda parameters, generic method type inference, overload resolution,
    `dynamic` and user-defined conversions are not followed. Audit these
    with the sample/diff CLI.
  - a local variable with a type's name gives an extra edge (conservative).
  - every #if branch is mapped (when a branch leaves a brace open, only
    the first branch's braces count); source generators and
    T4 output that is not checked in is invisible.
  - reflection with a computed name (Type.GetType(x), Activator.CreateInstance,
    Assembly.Load) is reported as unresolved.

Skipped directories: bin and obj at --root or beside a .csproj, packages at
--root or beside a .sln (a namespace folder with one of these names is
still walked), plus
node_modules, __pycache__ and every directory starting with ".". Each
skipped directory holding .cs files is printed as a warning.

Usage:
  python3 depmap_csharp.py --root path/to/repo --out path/to/migration/depmap
Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)
and unresolved.tsv (file, reference, reason).

Test: python3 scripts/depmap_csharp.py --root fixtures/csharp --out /tmp/depmap-cs && diff /tmp/depmap-cs/edges.tsv fixtures/csharp/expected_edges.tsv
"""

import bisect
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, read_source, run  # noqa: E402
from depmap_projects import QUOTED, dotnet_projects, drop_not_compiled  # noqa: E402
from depmap_typed import BLOCK, GLOBAL, Directives, FileInfo, TOKEN_RE, chains_at, dotted, flow_c_like, members, resolve, strip_c_like  # noqa: E402

EXTS = {".cs"}
# Build output beside a project, NuGet's packages/ beside a solution (or at --root).
SKIP_DIRS = {"bin": {".csproj"}, "obj": {".csproj"}, "packages": {".sln"}}
TYPE_KEYWORDS = {"class", "struct", "interface", "enum", "record"}
KEYWORDS = set("""abstract as base bool break byte case catch char checked class const continue
decimal default delegate do double else enum event explicit extern false finally fixed float for
foreach goto if implicit in int interface internal is lock long namespace new null object operator
out override params private protected public readonly ref return sbyte sealed short sizeof
stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe
ushort using virtual void volatile while var dynamic nameof await async yield when where get set
init value add remove partial global record nint nuint not and or with""".split())
REFLECTION_RE = re.compile(r"\b(Type\s*\.\s*GetType|Activator\s*\.\s*CreateInstance|Assembly\s*\.\s*Load\w*)\s*\(\s*((?:[^()]|\([^()]*\))+?)?\s*\)")
CSPROJ_USING_RE = re.compile(r"<Using\b([^>]*?)/?>", re.IGNORECASE)
CSPROJ_ATTR_RE = re.compile(r"\b(Include|Alias|Static)\s*=\s*" + QUOTED, re.IGNORECASE)


def read_dotted(toks, j):
    """Dotted name starting at toks[j]; returns (name, next index). A
    global::-qualified name keeps the GLOBAL mark."""
    parts, root = [], False
    while j < len(toks):
        t = toks[j][0]
        if t == "global" and j + 2 < len(toks) and toks[j + 1][0] == ":" and toks[j + 2][0] == ":":
            root = not parts
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
    name = ".".join(parts)
    return (GLOBAL + name if root and name else name), j


def unrooted(name):
    """A directive's name without the GLOBAL mark (outside a namespace block
    every using is from the root anyway)."""
    return name[len(GLOBAL):] if name.startswith(GLOBAL) else name


def scan(rel, text):
    info = FileInfo(rel)
    code, info.strings = strip_c_like(text, csharp=True)
    toks = [(m.group(0), m.start(), m.end()) for m in TOKEN_RE.finditer(code)]
    blank = []          # spans of directives, not counted as mentions
    globals_, global_aliases, global_static = [], {}, []
    depth, file_ns, stack = 0, "", []  # stack: (namespace, depth before its "{", block context)
    blocks = 0
    contexts = [(0, "")]    # (offset, context from there on)

    def current():
        return ".".join(p for p in [file_ns] + [n for n, _, _ in stack] if p)

    def context():
        """The namespace, tagged with the innermost namespace block (BLOCK):
        using directives belong to the block they are written in."""
        return stack[-1][2] if stack else current()

    i = 0
    while i < len(toks):
        t, start, _ = toks[i]
        prev = toks[i - 1][0] if i else ";"
        if t == "{":
            depth += 1
        elif t == "}":
            depth -= 1
            popped = False
            while stack and stack[-1][1] >= depth:
                stack.pop()
                popped = True
            if popped:
                contexts.append((start, context()))
        elif t == "namespace":
            name, j = read_dotted(toks, i + 1)
            if j < len(toks) and toks[j][0] == ";":
                file_ns = name
            else:
                blocks += 1
                parent = stack[-1][2] if stack else None
                stack.append((name, depth, None))
                ctx = f"{current()}{BLOCK}{blocks}"
                stack[-1] = (name, depth, ctx)
                info.blocks[ctx] = Directives(parent)
            info.namespaces.add(current())
            contexts.append((start, context()))
            blank.append((start, toks[j - 1][2] if j > i + 1 else toks[i][2]))
            i = j
            continue
        elif t == "using" and prev in {";", "{", "}", "]", "global"}:
            j = i + 1
            static = j < len(toks) and toks[j][0] == "static"
            j += static
            name, k = read_dotted(toks, j)
            if name and k < len(toks) and toks[k][0] in {";", "="}:
                # global using applies to the whole project; a using inside a
                # namespace block to that block; any other to the file.
                block = info.blocks.get(context())
                where = block or info
                if toks[k][0] == "=":
                    target, k2 = read_dotted(toks, k + 1)
                    (global_aliases if prev == "global" else where.aliases)[name] = target
                    k = k2
                elif static:
                    if prev == "global":
                        global_static.append(unrooted(name))
                        info.direct.add(unrooted(name))     # the declaring file names the type
                    else:
                        # A block keeps global:: (its usings are otherwise relative).
                        where.direct.add(name if block else unrooted(name))
                elif prev == "global":
                    globals_.append(unrooted(name))
                else:
                    where.usings.add(name if block else unrooted(name))
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
    # Each name is resolved from the namespace it is written in.
    offsets = [o for o, _ in contexts]
    info.names = [(contexts[bisect.bisect_right(offsets, pos) - 1][1], name)
                  for pos, name in chains_at(code, KEYWORDS)]
    info.members = members(code)
    info.type_members, info.type_bases, info.flow, info.type_ns = flow_c_like(
        [t for t, _, _ in toks], KEYWORDS, "csharp")
    for m in REFLECTION_RE.finditer(code):
        arg = (m.group(2) or "").strip()
        if not arg.startswith('""'):
            info.dynamic.append((f"{dotted(m.group(1), False)}({arg})", "reflection with a computed type name"))
    return info, (globals_, global_aliases, global_static)


def csproj_usings(text):
    """(usings, aliases, static usings) of the <Using> items of a .csproj."""
    usings, aliases, static = [], {}, []
    for m in CSPROJ_USING_RE.finditer(text):
        attrs = {k.lower(): a or b for k, a, b in CSPROJ_ATTR_RE.findall(m.group(1))}
        name = attrs.get("include", "").strip()
        if not name:
            continue
        if attrs.get("alias", "").strip():
            aliases[attrs["alias"].strip()] = name
        elif attrs.get("static", "").strip().lower() == "true":
            static.append(name)
        else:
            usings.append(name)
    return usings, aliases, static


def mapper(root, warnings, args):
    files = find_files(root, EXTS, SKIP_DIRS, warnings=warnings)
    rels, infos, project_globals = [], [], []
    for path in files:
        rel = path.relative_to(root).as_posix()
        info, globals_ = scan(rel, read_source(path, warnings))
        rels.append(rel)
        infos.append(info)
        project_globals.append(globals_)
    visible_files, not_compiled, owner, texts = dotnet_projects(root, rels, ".csproj", warnings)
    # global using, global using static, global aliases (and <Using> items in
    # the .csproj) apply to every file of their project; files outside any
    # project share one set.
    usings, aliases, static = {}, {}, {}
    for info, (globals_, global_aliases, global_static) in zip(infos, project_globals):
        d = owner[info.rel]
        usings.setdefault(d, set()).update(globals_)
        static.setdefault(d, set()).update(global_static)
        for name, target in global_aliases.items():
            aliases.setdefault(d, {}).setdefault(name, target)
    for d, text in sorted(texts.items()):
        names, named, statics = csproj_usings(text)
        usings.setdefault(d, set()).update(names)
        static.setdefault(d, set()).update(statics)
        for name, target in named.items():
            aliases.setdefault(d, {}).setdefault(name, target)
    for info in infos:
        d = owner[info.rel]
        info.usings.update(dotted(u, False) for u in usings.get(d, ()))
        info.project_static.update(dotted(u, False) for u in static.get(d, ()))
        for name, target in aliases.get(d, {}).items():
            info.aliases.setdefault(name, target)
    skipped = drop_not_compiled(infos, not_compiled)
    edges, unresolved = resolve(infos, attribute_suffix="Attribute", visible_files=visible_files)
    return rels, edges, unresolved | skipped


if __name__ == "__main__":
    run("Map file dependencies of a C# codebase from its source text.", mapper)
