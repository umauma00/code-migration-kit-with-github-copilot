# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Type-name resolution shared by the C#, Java and VB.NET mappers.

In these languages an import names a namespace (C#, VB.NET) or a package, not
a file, and code in the same namespace needs no import at all. A file-level
edge therefore comes from resolving every type name a file mentions against a
table of the types each file declares. Two passes:

  1. each file reports its namespace(s), the types (and C# extension methods /
     VB module members) it declares, its imports, and the dotted names its code
     mentions (comments and string contents removed);
  2. every mentioned name is resolved through the C#/Java/VB lookup rules
     approximated below, and each match is an edge.

The approximation is conservative: when a simple name matches several visible
types, every candidate becomes an edge (more edges, never fewer); a local
variable that happens to share a type's name also becomes an edge. Partial
types declared in several files link all their parts both ways.
"""

import re


class FileInfo:
    def __init__(self, rel):
        self.rel = rel
        self.namespaces = set()     # namespaces the file declares types in ("" = global)
        self.decls = []             # (namespace, name) of declared types/members
        self.extensions = []        # (namespace, name) of members called as x.Name (C# extension methods, VB module members)
        self.partial = set()        # FQNs declared partial in this file
        self.usings = set()         # imported namespaces (or types: Java on-demand of a type)
        self.aliases = {}           # alias -> dotted target
        self.direct = set()         # dotted targets imported one by one (Java import a.B, C# using static)
        self.names = []             # dotted name chains mentioned in code
        self.members = set()        # names written after "." (x.Name)
        self.strings = []           # string literal contents (reflection lookups)
        self.dynamic = []           # (reference, reason) the mapper could not resolve statically


def dotted(name, fold):
    name = name.replace(" ", "").replace("\t", "").replace("\n", "").replace("\r", "")
    if name.startswith("global::"):
        name = name[len("global::"):]
    name = name.replace("::", ".")
    if name.startswith("@"):
        name = name[1:]
    name = ".".join(part.lstrip("@") for part in name.split("."))
    return name.lower() if fold else name


def prefixes(ns):
    """'a.b.c' -> ['a.b.c', 'a.b', 'a', '']: a namespace and its parents."""
    parts = ns.split(".") if ns else []
    return [".".join(parts[:i]) for i in range(len(parts), -1, -1)]


def join(ns, name):
    return f"{ns}.{name}" if ns else name


def resolve(infos, fold=False, global_usings=(), attribute_suffix=None,
            nested_lookup=True):
    """Return (edges, unresolved) for the FileInfo list.

    nested_lookup: C# and VB.NET see the types of every enclosing namespace
    (code in a.b.c sees a.b and a) and accept names qualified relative to
    them; Java sees only its own package and fully qualified names.
    attribute_suffix: C# [Foo] may name FooAttribute.
    """
    types = {}          # fqn -> set(rel)
    extensions = {}     # fqn of an extension method -> set(rel)
    namespaces = set()
    for info in infos:
        for ns in info.namespaces:
            namespaces.update(prefixes(ns))
        for ns, name in info.decls:
            types.setdefault(join(ns, name), set()).add(info.rel)
        for ns, name in info.extensions:
            extensions.setdefault(join(ns, name), set()).add(info.rel)
    global_usings = {dotted(u, fold) for u in global_usings}

    edges, unresolved = set(), set()

    def lookup(fqn):
        return types.get(fqn, ())

    def add(src, targets):
        for t in targets:
            if t != src:
                edges.add((src, t))

    def longest_type_prefix(segs):
        for i in range(len(segs), 0, -1):
            hit = lookup(".".join(segs[:i]))
            if hit:
                return hit
        return ()

    for info in infos:
        src = info.rel
        # Partial parts of one type depend on each other.
        for fqn in info.partial:
            add(src, lookup(fqn))
        own = set(info.namespaces) or {""}
        enclosing = set()
        for ns in own:
            enclosing.update(prefixes(ns) if nested_lookup else [ns])
        roots = enclosing if nested_lookup else {""}
        usings = set(info.usings) | global_usings
        simple = {}     # simple name -> targets from direct imports
        for target in sorted(info.direct):
            segs = target.split(".")
            hit = longest_type_prefix(segs)
            if hit:
                add(src, hit)
                simple.setdefault(segs[-1], set()).update(hit)
            elif ".".join(segs[:-1]) in namespaces:
                unresolved.add((src, target, "import of a type the repository package does not declare"))
        for alias, target in sorted(info.aliases.items()):
            segs = target.split(".")
            hit = longest_type_prefix(segs)
            if hit:
                simple.setdefault(alias, set()).update(hit)
        for u in sorted(usings):
            hit = lookup(u)
            if hit:  # Java on-demand import of a type's members, C# using of a type
                add(src, hit)
        visible = enclosing | {u for u in usings if u in namespaces}

        def candidates(name):
            out = set()
            for ns in visible:
                out.update(lookup(join(ns, name)))
            out.update(simple.get(name, ()))
            return out

        for chain in info.names:
            segs = chain.split(".")
            if segs[0] in info.aliases:
                segs = info.aliases[segs[0]].split(".") + segs[1:]
            # Fully qualified, or qualified relative to an enclosing namespace.
            hit = ()
            for ns in sorted(roots, key=len, reverse=True):
                hit = longest_type_prefix((ns.split(".") if ns else []) + segs)
                if hit:
                    break
            if hit:
                add(src, hit)
                continue
            found = candidates(segs[0])
            if not found and attribute_suffix:
                found = candidates(segs[0] + attribute_suffix)
            add(src, found)
        # x.Name() may call an extension method of any visible namespace.
        for name in sorted(info.members):
            for ns in visible:
                add(src, extensions.get(join(ns, name), ()))
        for s in info.strings:
            name = s.split(",")[0].strip()
            name = name.lower() if fold else name
            if "." in name and lookup(name):
                add(src, lookup(name))
        for ref, why in info.dynamic:
            unresolved.add((src, ref, why))
    return edges, unresolved


def strip_c_like(text, csharp=False):
    """Remove comments and string/char contents from C# or Java source.

    Returns (code, strings): code keeps its line breaks, each string literal
    becomes "" and each comment a space; strings holds the literal contents.
    C# verbatim (@"..."), raw (\"\"\"...\"\"\") and interpolated ($"...{expr}...")
    strings are understood; an interpolation hole's expression is kept as code
    so the names it mentions still count. Java text blocks are raw strings.
    C# preprocessor lines are dropped: every #if branch is mapped.
    """
    out, strings = [], []
    i, n = 0, len(text)
    line_start = True
    while i < n:
        c = text[i]
        if csharp and line_start and c == "#":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c in " \t":
            out.append(c)
            i += 1
            continue
        line_start = c in "\r\n"
        if c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            out.append(" ")
            continue
        if c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            end = n if j < 0 else j + 2
            out.append(" " + "\n" * text.count("\n", i, end))
            line_start = False
            i = end
            continue
        if c == "'":
            j = i + 1
            while j < n and text[j] != "'" and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            out.append("''")
            i = j + 1
            continue
        # String prefixes: C# $, @, $@, @$ (and $$ raw interpolation).
        j = i
        interp = verbatim = False
        if csharp:
            while j < n and text[j] in "$@" and j - i < 4:
                interp |= text[j] == "$"
                verbatim |= text[j] == "@"
                j += 1
            if j == i or j >= n or text[j] != '"':
                j = i
                interp = verbatim = False
        if j < n and text[j] == '"':
            if text.startswith('"""', j):
                q = j
                while q < n and text[q] == '"':
                    q += 1
                fence = text[j:q]
                end = text.find(fence, q)
                end = n if end < 0 else end
                body = text[q:end]
                strings.append(body)
                out.append('""' + "\n" * body.count("\n"))
                i = end + len(fence)
                continue
            k = j + 1
            buf, holes = [], []
            while k < n:
                ch = text[k]
                if verbatim and ch == '"' and text.startswith('""', k):
                    buf.append('"')
                    k += 2
                    continue
                if not verbatim and ch == "\\":
                    buf.append(text[k:k + 2])
                    k += 2
                    continue
                if ch == '"' or (not verbatim and ch == "\n"):
                    break
                if interp and ch == "{":
                    if text.startswith("{{", k):
                        k += 2
                        continue
                    depth, h = 1, k + 1
                    while h < n and depth:
                        if text[h] == "{":
                            depth += 1
                        elif text[h] == "}":
                            depth -= 1
                        elif text[h] == '"':  # nested literal: skip it
                            h2 = text.find('"', h + 1)
                            h = n if h2 < 0 else h2
                        h += 1
                    holes.append(text[k + 1:h - 1])
                    k = h
                    continue
                buf.append(ch)
                k += 1
            strings.append("".join(buf))
            out.append('""' + "".join(f" ({hole.split(':')[0]}) " for hole in holes))
            i = k + 1
            continue
        out.append(c)
        i += 1
    return "".join(out), strings


TOKEN_RE = re.compile(r"@?[^\W\d]\w*|\S")
CHAIN_RE = re.compile(r"(?:global::)?@?[^\W\d]\w*(?:\s*(?:\.|::)\s*@?[^\W\d]\w*)*")


def chains(code, keywords, fold=False):
    """Dotted name chains in code, minus those headed by a language keyword."""
    out = []
    for m in CHAIN_RE.finditer(code):
        start = m.start()
        # A chain right after "." continues a call or index result
        # (f().Bar): member access on a value, not a type name.
        k = start - 1
        while k >= 0 and code[k] in " \t\r\n":
            k -= 1
        if k >= 0 and code[k] == ".":
            continue
        name = dotted(m.group(0), fold)
        # this.X, base.X, string.Join...: a value or a built-in, not a type.
        if name.split(".")[0] not in keywords:
            out.append(name)
    return out


MEMBER_RE = re.compile(r"\.\s*@?([^\W\d]\w*)")


def members(code, fold=False):
    """Names written after a dot: candidates for extension method calls."""
    return {m.group(1).lower() if fold else m.group(1) for m in MEMBER_RE.finditer(code)}
