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
<Using Include> in .csproj), using aliases and using static. [Foo] in an
attribute list also matches FooAttribute. Fully qualified names, string literals that equal a
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
from depmap_projects import ATTRS, QUOTED, dotnet_projects, drop_not_compiled  # noqa: E402
from depmap_typed import BLOCK, CHAIN_RE, DOTNET_STANDARD, GLOBAL, Directives, FileInfo, PREDEFINED, TOKEN_RE, chains_at, dotted, flow_c_like, join, resolve, scan_or_none, strip_c_like  # noqa: E402

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
CSPROJ_USING_RE = re.compile(r"<Using\b" + ATTRS + r"/?>", re.IGNORECASE)
CSPROJ_ATTR_RE = re.compile(r"\b(Include|Alias|Static)\s*=\s*" + QUOTED, re.IGNORECASE)


# Words after which a name is a value, not a declaration (select x;, from
# x in, return x;): query keywords and contextual words.
VALUE_WORDS = set("""select where orderby group by into from in join on equals let ascending
descending await yield nameof when and or not with is as return throw case goto else new typeof
sizeof default checked unchecked""".split())


def declared_name_at(code, start, end, name):
    """Whether the name at code[start:end] is the name being declared in
    string Schema { get; }, Foo bar = ..., void Run(...): a simple name right
    after a type (an identifier, a predefined type, > ] ? or *) and before
    { ; = ( , or ). Such a name is not a reference to a type of that name
    (a property Schema is not the class Schema)."""
    if "." in name or name.startswith(GLOBAL):
        return False
    k = end
    while k < len(code) and code[k].isspace():
        k += 1
    if k >= len(code) or code[k] not in "{;=(,)":
        return False
    if code[k] == "=" and code[k + 1:k + 2] == "=":
        return False        # Foo == x is a comparison
    k = start - 1
    while k >= 0 and code[k].isspace():
        k -= 1
    if k < 0:
        return False
    if code[k] == "]":
        return True         # int[] Foo
    if code[k] in ">?*":
        # List<int> Foo, int? Foo, int* p: the type ends right at the mark;
        # a > Foo, c ? Foo(x) : y and a * Foo(x) are expressions.
        return k > 0 and not code[k - 1].isspace() and code[k - 1:k + 1] not in {"=>", "->"}
    j = k
    while j >= 0 and (code[j].isalnum() or code[j] in "_@"):
        j -= 1
    word = code[j + 1:k + 1].lstrip("@")
    if not word or word[0].isdigit():
        return False
    return word not in VALUE_WORDS and (word in PREDEFINED or word not in KEYWORDS)


def receiver_name(toks, j):
    """Simple name of the type at toks[j] (an extension method's receiver,
    after this and ref/in/scoped): string for string, List for
    System.Collections.Generic.List<T>."""
    while j < len(toks) and toks[j][0] in {"this", "ref", "in", "scoped", "readonly"}:
        j += 1
    name = ""
    while j < len(toks):
        t = toks[j][0]
        if t[0].isalpha() or t[0] in "_@":
            name = t.lstrip("@")
            j += 1
            if j < len(toks) and toks[j][0] in {".", ":"}:
                while j < len(toks) and toks[j][0] in {".", ":"}:
                    j += 1
                continue
        break
    return name


# Classes whose methods are static: Math.Min(...) and string.Join(...) are
# not calls of an extension method named Min or Join.
STATIC_RECEIVERS = set("""Math MathF Path File Directory Convert Console Environment Activator
Interlocked BitConverter Regex Enumerable Queryable String Array Enum Guid Task Debug Trace Marshal
Buffer Encoding TimeSpan DateTime DateTimeOffset Int16 Int32 Int64 UInt32 Double Single Decimal
Boolean Char Byte Object Type Assembly Thread ThreadPool Parallel Monitor Nullable GC Process
Tuple ValueTuple ArgumentNullException ObjectDisposedException""".split())
MEMBER_CALL_RE = re.compile(r"(@?[^\W\d]\w*)?\s*\.\s*@?([^\W\d]\w*)")


def member_calls(code):
    """(receiver, name) of every name written after a dot: receiver is the
    variable before the dot (x in x.Name) or "" when the receiver is an
    expression. A dot after a predefined type or a static-only class
    (string.Join, Math.Min) is a static call, never an extension method
    call, and is left out."""
    out = set()
    for m in MEMBER_CALL_RE.finditer(code):
        head = m.group(1)
        k = m.start(1) - 1 if head else -1
        while k >= 0 and code[k].isspace():
            k -= 1
        if head and k >= 0 and code[k] in ".)]":
            head = None         # a.Math.Min: Math is a member, not the class
        if head and (head in PREDEFINED or head in STATIC_RECEIVERS):
            continue
        out.add(((head or "").lstrip("@"), m.group(2)))
    return out


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
    file_ctx = None         # block context of a file-scoped namespace (namespace N;)
    contexts = [(0, "")]    # (offset, context from there on)
    type_depths = []        # (depth inside its body, name) of each enclosing type
    type_pending = None     # name of a type declaration whose body has not opened yet

    def current():
        return ".".join(p for p in [file_ns] + [n for n, _, _ in stack] if p)

    def context():
        """The namespace, tagged with the innermost namespace block (BLOCK):
        using directives belong to the block they are written in."""
        return stack[-1][2] if stack else file_ctx or current()

    i = 0
    while i < len(toks):
        t, start, _ = toks[i]
        prev = toks[i - 1][0] if i else ";"
        if t == "{":
            depth += 1
            if type_pending:
                type_depths.append((depth, type_pending))
                type_pending = None
        elif t == ";":
            type_pending = None     # record R(int X); has no body
        elif t == "}":
            if type_depths and type_depths[-1][0] == depth:
                type_depths.pop()
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
                # namespace N; is a block to the end of the file: a using
                # after it belongs to N, one before it to the file.
                file_ns = name
                blocks += 1
                file_ctx = f"{name}{BLOCK}{blocks}"
                info.blocks[file_ctx] = Directives(None)
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
                    if target and k2 < len(toks) and toks[k2][0] == ";":
                        (global_aliases if prev == "global" else where.aliases)[name] = target
                    else:
                        # using P = (A a, B b); or = List<A>; or = A[];: the
                        # names in the target count as mentions where the
                        # alias is written (only "using P =" is blanked).
                        if target and k2 < len(toks) and toks[k2][0] in {"<", "["}:
                            (global_aliases if prev == "global" else where.aliases)[name] = target
                        blank.append((toks[i - (prev == "global")][1], toks[k][2]))
                        while k < len(toks) and toks[k][0] != ";":
                            k += 1
                        i = k + 1
                        continue
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
                if type_depths:     # nested: a type of its own, not a copy of a same-named one
                    info.nested[join(ns, name)] = join(ns, ".".join(n for _, n in type_depths) + "." + name)
                type_pending = name
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
                if type_depths:
                    name = toks[k][0].lstrip("@")
                    info.nested[join(ns, name)] = join(ns, ".".join(n for _, n in type_depths) + "." + name)
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
                info.extension_receivers.setdefault(join(ns, name), set()).add(receiver_name(toks, i + 2))
        elif t == "extension" and prev in {"{", "}", ";", "]"} and i + 1 < len(toks) and toks[i + 1][0] in {"(", "<"}:
            # C# 14 extension block: extension(string s) { bool IsBlank => ...; }.
            # Its members are called as s.IsBlank, like extension methods.
            j, level = i + 1, 0
            while j < len(toks):
                level += {"(": 1, ")": -1, "<": 1, ">": -1}.get(toks[j][0], 0)
                j += 1
                if level == 0 and toks[j - 1][0] == ")":
                    break
            receiver = receiver_name(toks, next((m + 1 for m in range(i + 1, j) if toks[m][0] == "("), j))
            if j < len(toks) and toks[j][0] == "{":
                ns, level, j = current(), 0, j
                while j < len(toks):
                    tok = toks[j][0]
                    if tok == "{":
                        level += 1
                    elif tok == "}":
                        level -= 1
                        if level == 0:
                            break
                    elif level == 1 and j + 1 < len(toks) and toks[j + 1][0] in {"(", "=>", "{", "<"} \
                            and tok not in KEYWORDS and (tok[0].isalpha() or tok[0] == "_") \
                            and (toks[j - 1][0] in {">", "]", "?"} or toks[j - 1][0][0].isalnum() or toks[j - 1][0][0] == "_") \
                            and toks[j - 1][0] not in {"new", "return", "=>", "nameof", "typeof", "await"}:
                        info.namespaces.add(ns)
                        info.extensions.append((ns, tok.lstrip("@")))
                        info.extension_receivers.setdefault(join(ns, tok.lstrip("@")), set()).add(receiver)
                    j += 1
        i += 1
    if not info.namespaces:
        info.namespaces.add("")
    for a, b in sorted(blank, reverse=True):
        code = code[:a] + " " * (b - a) + code[b:]
    # Each name is resolved from the namespace it is written in.
    offsets = [o for o, _ in contexts]
    info.names, info.attribute_names = [], []
    brackets = Brackets(code)
    for pos, name in chains_at(code, KEYWORDS):
        end = CHAIN_RE.match(code, pos).end()
        if declared_name_at(code, pos, end, name):
            continue
        ref = (contexts[bisect.bisect_right(offsets, pos) - 1][1], name)
        info.names.append(ref)
        if attribute_name_at(code, pos, end, brackets):
            info.attribute_names.append(ref)
    info.member_calls = member_calls(code)
    info.members = {name for _, name in info.member_calls}
    info.type_members, info.type_bases, info.flow, info.type_ns = flow_c_like(
        [t for t, _, _ in toks], KEYWORDS, "csharp")
    for m in REFLECTION_RE.finditer(code):
        arg = (m.group(2) or "").strip()
        if not arg.startswith('""'):
            info.dynamic.append((f"{dotted(m.group(1), False)}({arg})", "reflection with a computed type name"))
    return info, (globals_, global_aliases, global_static)


# Attribute targets ([assembly: Foo], [return: Foo]).
ATTRIBUTE_TARGETS = {"assembly", "module", "field", "event", "method", "param",
                     "property", "return", "type", "typevar"}


class Brackets:
    """The bracket structure of code, computed once (linear): for each
    offset the innermost open bracket around it, and each bracket's match."""

    def __init__(self, code):
        self.code = code
        self.opens, self.inner, self.close = [], [], {}
        stack = []
        for k, c in enumerate(code):
            if c in "([{":
                stack.append(k)
                self.opens.append(k)
                self.inner.append(stack[-2] if len(stack) > 1 else -1)
            elif c in ")]}" and stack:
                self.close[stack.pop()] = k
                self.opens.append(k)
                self.inner.append(stack[-1] if stack else -1)
        # inner[i]: the open bracket around the text just after opens[i].

    def around(self, pos):
        """Offset of the innermost bracket open at pos, or -1."""
        i = bisect.bisect_right(self.opens, pos) - 1
        if i < 0:
            return -1
        k = self.opens[i]
        return k if self.code[k] in "([{" else self.inner[i]


def attribute_name_at(code, start, end, brackets=None):
    """Whether the name at code[start:end] is an attribute's name: the head
    of an item of a [...] attribute list (followed by "(", ",", "]" or a
    type argument list). A [ counts as an attribute list where a
    declaration may begin and when a declaration follows it, not after a
    value (a[Foo] is an indexer, x = [Foo] and F([Foo]) collections)."""
    brackets = brackets or Brackets(code)
    k = end
    while k < len(code) and code[k].isspace():
        k += 1
    if k >= len(code) or code[k] not in "(,]<":
        return False
    k = start - 1
    while k >= 0 and code[k].isspace():
        k -= 1
    if k >= 0 and code[k] == ":":       # [target: Foo]
        k -= 1
        while k >= 0 and code[k].isspace():
            k -= 1
        word_end = k + 1
        while k >= 0 and (code[k].isalnum() or code[k] == "_"):
            k -= 1
        if code[k + 1:word_end] not in ATTRIBUTE_TARGETS:
            return False
        while k >= 0 and code[k].isspace():
            k -= 1
    elif k >= 0 and code[k] == ",":     # [A, Foo]: the open [ around it
        k = brackets.around(k)
    if k < 0 or code[k] != "[":
        return False
    open_at = k
    k -= 1
    while k >= 0 and code[k].isspace():
        k -= 1
    before = code[k] if k >= 0 else ";"
    # What follows the list tells a declaration from an expression: an
    # attribute list is followed by what it applies to ([Foo] class C,
    # [Foo] int x, [Foo] T, [A][B], [Foo] ~C(), [Foo] () => 1) or ends the
    # file ([assembly: Foo]). A collection expression or an initializer's
    # index (F([Foo]), { [Foo] }, { [Foo] = 1 }) is followed by ")", ",",
    # "}", "=", ";" or an operator word.
    k = brackets.close.get(open_at)
    if k is None:
        return False
    k += 1
    while k < len(code) and code[k].isspace():
        k += 1
    if k == len(code):
        return before in ";{}]"
    if before in "=>":
        # x = [Foo] (int a) => a: a lambda's attributes (a collection is
        # never called).
        return code[k] == "("
    if before not in ";{}](<,":
        return False
    m = WORD_RE.match(code, k)
    if m:
        return m.group(0) not in EXPRESSION_WORDS
    return code[k] in "[(#~"


WORD_RE = re.compile(r"@?[^\W\d]\w*")
# Words that continue an expression after a collection ([a] is [..], [a] switch ...).
EXPRESSION_WORDS = {"is", "as", "switch", "with", "and", "or", "not", "when"}


def csproj_usings(text):
    """(usings, aliases, static usings) of the <Using> items of a .csproj.
    aliases maps a name to every target its items give: Conditions are not
    evaluated, so Debug's and Release's alias both stay."""
    usings, aliases, static = [], {}, []
    for m in CSPROJ_USING_RE.finditer(text):
        attrs = {k.lower(): a or b for k, a, b in CSPROJ_ATTR_RE.findall(m.group(1))}
        name = attrs.get("include", "").strip()
        if not name:
            continue
        if attrs.get("alias", "").strip():
            aliases.setdefault(attrs["alias"].strip(), []).append(name)
        elif attrs.get("static", "").strip().lower() == "true":
            static.append(name)
        else:
            usings.append(name)
    return usings, aliases, static


def mapper(root, warnings, args):
    files = find_files(root, EXTS, SKIP_DIRS, warnings=warnings)
    rels, infos, project_globals, deep = [], [], [], set()
    for path in files:
        rel = path.relative_to(root).as_posix()
        info, globals_ = scan_or_none(scan, rel, read_source(path, warnings), deep) or (FileInfo(rel), (set(), {}, set()))
        rels.append(rel)
        infos.append(info)
        project_globals.append(globals_)
    visible_files, not_compiled, projects_of, texts = dotnet_projects(root, rels, ".csproj", warnings)
    # global using, global using static, global aliases (and <Using> items in
    # the .csproj) apply to every file of their project; files outside any
    # project share one set. A file linked into several projects takes the
    # directives of each, and its own global usings apply to each. A file no
    # project compiles gives none; one compiled only under an unevaluated
    # Condition gives its own, and an alias it shares with another file
    # keeps both targets.
    usings, aliases, static = {}, {}, {}
    for info, (globals_, global_aliases, global_static) in zip(infos, project_globals):
        if info.rel in not_compiled and not not_compiled[info.rel][1]:
            continue
        for d in projects_of[info.rel] or (None,):
            usings.setdefault(d, set()).update(globals_)
            static.setdefault(d, set()).update(global_static)
            for name, target in global_aliases.items():
                aliases.setdefault(d, {}).setdefault(name, set()).add(target)
    for d, text in sorted(texts.items()):
        names, named, statics = csproj_usings(text)
        usings.setdefault(d, set()).update(names)
        static.setdefault(d, set()).update(statics)
        for name, targets in named.items():
            aliases.setdefault(d, {}).setdefault(name, set()).update(targets)
    for d, named in sorted(aliases.items(), key=lambda x: x[0] or ""):
        for name, targets in sorted(named.items()):
            if len(targets) > 1:
                warnings.append(f"{d or '.'}: global alias {name} has {len(targets)} targets ({', '.join(sorted(targets))}), "
                                "probably under Conditions that are not evaluated; files that use it get an edge to each")
    for info in infos:
        for d in projects_of[info.rel] or (None,):
            info.usings.update(dotted(u, False) for u in usings.get(d, ()))
            info.project_static.update(dotted(u, False) for u in static.get(d, ()))
            for name, targets in sorted(aliases.get(d, {}).items()):
                for target in sorted(targets):
                    if info.aliases.setdefault(name, target) != target:
                        info.alias_more.setdefault(name, set()).add(target)
    skipped = drop_not_compiled(infos, not_compiled)
    edges, unresolved = resolve(infos, attribute_suffix="Attribute", visible_files=visible_files,
                                 standard=DOTNET_STANDARD)
    return rels, edges, unresolved | skipped | deep


if __name__ == "__main__":
    run("Map file dependencies of a C# codebase from its source text.", mapper)
