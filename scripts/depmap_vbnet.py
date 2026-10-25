#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Deterministic dependency mapper for VB.NET codebases (stdlib only).

Implements the kit's dependency-map contract (prompts/01-dependency-map.md) by
reading .vb files as text. It never builds or runs the project.

Like C#, an Imports statement names a namespace, so edges come from names
(scripts/depmap_typed.py), compared case-insensitively as VB does: each
file's namespaces and declared types (Class, Module, Structure, Interface,
Enum, Delegate) form a table, and so do the members of every Module, because
VB code calls a module's Sub/Function/Property/Const without naming the
module. Mentioned names are resolved through enclosing namespaces, Imports
(including aliases and project-level <Import Include> in .vbproj) and fully
qualified names. Partial types link all their parts.

Every namespace is placed under the project's root namespace, as the VB
compiler does: <RootNamespace> of the nearest .vbproj above the file, or the
.vbproj's file name; Namespace Global.X opts out.

Types used without their name being written are followed through declared
types (scripts/depmap_typed.py, type flow): `Dim x = F()` then `x.M().N()`
reaches F's return type, M's and N's, through Inherits/Implements too;
parameters, Dim ... As, For Each variables and List(Of T) elements count.

Each name is resolved from the Namespace block it is written in; Global.X
names from the root namespace only.

.vbproj files are read like .csproj ones: ProjectReference narrows names
declared in several projects; files a project does not compile declare
nothing and are listed in unresolved.tsv (a file left out only under a
Condition keeps its declarations and is listed too). <Import Include>
applies to the files of its own project.

Known limits, listed in unresolved.tsv where the source shows them:
  - With blocks, lambdas, late binding on Object and overload resolution
    are not followed. Audit these with the sample/diff CLI.
  - a local name equal to a type or module member gives an extra edge.
  - CreateObject/Activator/Type.GetType with a computed name is unresolved.
  - every #If branch is mapped. VB6 (.bas/.cls/.frm) is a different
    language and is not read.

Skipped directories: bin, obj and My Project at --root or beside a .vbproj,
packages at --root or beside a .sln, plus node_modules, __pycache__ and every directory
starting with ".". Each skipped directory holding .vb files is printed as
a warning.

Usage:
  python3 depmap_vbnet.py --root path/to/repo --out path/to/migration/depmap
Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)
and unresolved.tsv (file, reference, reason).

Test: python3 scripts/depmap_vbnet.py --root fixtures/vbnet --out /tmp/depmap-vb && diff /tmp/depmap-vb/edges.tsv fixtures/vbnet/expected_edges.tsv
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import EXTERNAL, find_files, read_source, run  # noqa: E402
from depmap_projects import ATTRS, COMMENT_RE, QUOTED, conditional_spans, dotnet_projects, drop_not_compiled  # noqa: E402
from depmap_typed import DOTNET_STANDARD, GLOBAL, PREDEFINED, TOKEN_RE, CHAIN_RE, FileInfo, chains, chains_at, is_ident, join, members, parse_expr, resolve, scan_or_none, type_written_at  # noqa: E402

EXTS = {".vb"}
# Build output and My Project beside a project, NuGet's packages/ beside a
# solution (or at --root).
SKIP_DIRS = {"bin": {".vbproj"}, "obj": {".vbproj"}, "my project": {".vbproj"}, "packages": {".sln"}}
MODIFIERS = (r"(?:(?:public|private|friend|protected|partial|mustinherit|notinheritable|shadows|"
             r"shared|overloads|overrides|overridable|notoverridable|mustoverride|static|default|"
             r"readonly|writeonly|async|iterator|widening|narrowing|withevents|const|dim)\s+)*")
BLOCK_RE = re.compile(r"^\s*(?:<[^>]*>\s*)?" + MODIFIERS + r"(class|module|structure|interface|enum|namespace)\s+([\w.\[\]]+)", re.IGNORECASE)
END_RE = re.compile(r"^\s*end\s+(class|module|structure|interface|enum|namespace)\b", re.IGNORECASE)
DELEGATE_RE = re.compile(r"^\s*(?:<[^>]*>\s*)?" + MODIFIERS + r"delegate\s+(?:sub|function)\s+([\w\[\]]+)", re.IGNORECASE)
MEMBER_RE = re.compile(r"^\s*(?:<[^>]*>\s*)?" + MODIFIERS + r"(?:(sub|function|property|event|operator|declare\s+(?:ansi\s+|unicode\s+|auto\s+)?(?:sub|function))\s+)?([\w\[\]]+)", re.IGNORECASE)
# "As [New] Type" after a member's name (and parameter list, if any).
MEMBER_TYPE_RE = re.compile(r"^(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*as\s+(?:new\s+)?([\w.\[\]]+(?:\s*\(\s*of\s+[^)]*\))?)")
INHERITS_RE = re.compile(r"^\s*(inherits|implements)\s+(.+)$")
PARAM_RE = re.compile(r"(?:byval\s+|byref\s+|optional\s+|paramarray\s+)*([a-z_]\w*)(?:\(\))?\s+as\s+([\w.]+(?:\s*\(\s*of\s+[^)]*\))?)")
DIM_RE = re.compile(r"^\s*(?:(?:dim|static|const|using|private|public|friend|protected|shared|readonly)\s+)+([a-z_]\w*)(?:\(\))?\s*(?:as\s+(?:new\s+)?([\w.]+(?:\s*\(\s*of\s+[^)]*\))?))?(?:\s*=\s*(.+))?")
FOREACH_RE = re.compile(r"^\s*for\s+each\s+([a-z_]\w*)(?:\s+as\s+([\w.]+(?:\s*\(\s*of\s+[^)]*\))?))?\s+in\s+(.+)$")
IMPORTS_RE = re.compile(r"^\s*imports\s+(.+?)\s*$", re.IGNORECASE)
IMPORT_CLAUSE_RE = re.compile(r"^(?:([\w\[\]]+)\s*=\s*)?([\w.\[\]]+)$")
ROOT_NS_RE = re.compile(r"<RootNamespace\b" + ATTRS + r"(?:/>|>\s*([^<]*?)\s*</RootNamespace\s*>)", re.IGNORECASE)
VBPROJ_IMPORT_RE = re.compile(r"<Import\b" + ATTRS + r"/?>", re.IGNORECASE)
VBPROJ_ATTR_RE = re.compile(r"\b(Include|Remove|Condition)\s*=\s*" + QUOTED, re.IGNORECASE)


def root_namespaces(text, stem, warnings, where):
    """RootNamespace candidates of a project, from its text with
    Directory.Build.props and imports expanded: the last value set outside
    a Condition (the project name if none), and every value set under a
    Condition after it, which is not evaluated (its types are declared under
    each, with a warning). $(MSBuildProjectName) is the project name; another
    property is not evaluated and leaves the project name, with a warning."""
    spans = conditional_spans(text)
    current, conditional = stem, []
    for m in ROOT_NS_RE.finditer(text):
        value = (m.group(2) or "").strip()      # <RootNamespace /> is the empty namespace
        value = re.sub(r"\$\(\s*MSBuildProjectName\s*\)", stem, value, flags=re.IGNORECASE)
        if "$(" in value:
            warnings.append(f"{where}: <RootNamespace>{value}</RootNamespace> uses an MSBuild property that is not "
                            f"evaluated; {stem} is used")
            value = stem
        if re.search(r"\bCondition\s*=", m.group(1), re.IGNORECASE) or any(a <= m.start() < b for a, b in spans):
            conditional.append(value)
        else:
            current, conditional = value, []
    written = list({v.lower(): v for v in reversed([current] + conditional)}.values())[::-1]
    if len(written) > 1:
        warnings.append(f"{where}: RootNamespace is set under a Condition that is not evaluated; "
                        f"types are declared under each of {', '.join(v or '(none)' for v in written)}")
    return [v.lower() for v in written]


def top_level_split(text):
    """text split at the commas outside parentheses (Imports A, L = D(Of B, C))."""
    parts, depth, start = [], 0, 0
    for i, ch in enumerate(text):
        depth += ch == "("
        depth -= ch == ")"
        if ch == "," and depth == 0:
            parts.append(text[start:i])
            start = i + 1
    return parts + [text[start:]]


def vbproj_imports(text, warnings=None, where="."):
    """Include values of the <Import Include> items of a .vbproj (any
    attribute order; <Import Project> is an MSBuild import, not an item),
    each an item list (A;B). A <Import Remove> drops the items before it;
    under a Condition it is not evaluated and the import is kept."""
    items = []
    spans = conditional_spans(text)
    for m in VBPROJ_IMPORT_RE.finditer(text):
        attrs = {k.lower(): a or b for k, a, b in VBPROJ_ATTR_RE.findall(m.group(1))}
        if "include" in attrs:
            items += [n.strip() for n in attrs["include"].split(";") if n.strip()]
        elif "remove" in attrs:
            names = {n.strip().lower() for n in attrs["remove"].split(";") if n.strip()}
            if "condition" in attrs or any(a <= m.start() < b for a, b in spans):
                if warnings is not None:
                    warnings.append(f"{where}: <Import Remove=\"{attrs['remove']}\"> is under a Condition "
                                    "that is not evaluated; it is not applied, so the import stays")
                continue
            items = [n for n in items if n.lower() not in names]
    return items
REFLECTION_RE = re.compile(r"\b(createobject|activator\s*\.\s*createinstance|type\s*\.\s*gettype|assembly\s*\.\s*load\w*)\s*\(\s*((?:[^()]|\([^()]*\))+?)?\s*\)", re.IGNORECASE)
# A bare name in an enum member's value: maybe a sibling member.
SIBLING_RE = re.compile(r"(?<![\w.])\[?[A-Za-z_]\w*\]?(?![\w\[\]]|\s*\.)")
# The name a declaration introduces: x As T, x() As T, Dim x, Const x.
DECLARED_RE = re.compile(r"(?:^|(?<=[\s(,]))\[?([a-z_]\w*)\]?(?:\s*\(\s*\))?\??\s+as\b|\b(?:dim|const|static)\s+\[?([a-z_]\w*)")
# Words before a name that make it a type (As Acme.Billing.Invoice).
TYPE_BEFORE = {"as", "new", "inherits", "implements", "of", "gettype("}
KEYWORDS = set("""addhandler addressof alias and andalso as boolean byref byte byval call case catch cbool
cbyte cchar cdate cdbl cdec char cint class clng cobj const continue csbyte cshort csng cstr ctype
cuint culng cushort date decimal declare default delegate dim directcast do double each else elseif
end endif enum erase error event exit false finally for friend function get gettype getxmlnamespace
global gosub goto handles if implements imports in inherits integer interface is isnot let lib like
long loop me mod module mustinherit mustoverride mybase myclass namespace narrowing new next not
nothing notinheritable notoverridable object of on operator option optional or orelse overloads
overridable overrides paramarray partial private property protected public raiseevent readonly redim
rem removehandler resume return sbyte select set shadows shared short single static step stop string
structure sub synclock then throw to true try trycast typeof uinteger ulong ushort using variant wend
when while widening with withevents writeonly xor async await iterator yield value""".split())


def strip_vb(text):
    """Logical lines with comments and string contents removed. Returns
    (lines, strings). A trailing " _" joins the next physical line, and so
    do VB 10's implicit continuations: an open ( or { and a line ending in
    , ( { & + = or a dot. ":" outside strings splits statements."""
    lines, strings, buf = [], [], []
    depth = 0           # ( and { left open by the lines in buf
    withs = 0           # open With blocks
    for raw in text.splitlines():
        out, i, n = [], 0, len(raw)
        while i < n:
            c = raw[i]
            if c == '"':
                # $"..." interpolates; s$ is a type character on a name.
                interp = (bool(out) and out[-1] == "$"
                          and not (len(out) > 1 and (out[-2].isalnum() or out[-2] in "_]")))
                if interp:
                    out.pop()
                j = i + 1
                s, holes = [], []
                while j < n:
                    if raw[j] == '"' and j + 1 < n and raw[j + 1] == '"':
                        s.append('"')
                        j += 2
                        continue
                    if raw[j] == '"':
                        break
                    if interp and raw[j] == "{":
                        if raw.startswith("{{", j):
                            j += 2
                            continue
                        # $"...{expr:format}...": the expression is code.
                        nest, h, expr = 1, j + 1, []
                        while h < n and nest:
                            ch = raw[h]
                            if ch == '"':       # a literal inside the hole
                                end = raw.find('"', h + 1)
                                h = n if end < 0 else end + 1
                                expr.append('""')
                                continue
                            nest += {"{": 1, "}": -1}.get(ch, 0)
                            if nest:
                                expr.append(ch)
                            h += 1
                        expr = "".join(expr)
                        level = 0
                        for k, ch in enumerate(expr):
                            level += {"(": 1, ")": -1}.get(ch, 0)
                            if ch == ":" and level <= 0:
                                expr = expr[:k]
                                break
                        holes.append(expr)
                        j = h
                        continue
                    s.append(raw[j])
                    j += 1
                strings.append("".join(s))
                out.append('""' + "".join(f" ({h}) " for h in holes))
                i = j + 1
                if i < n and raw[i] in "cC":  # "x"c char literal
                    i += 1
                continue
            if c in "'‘’" or (raw[i:i + 3].lower() == "rem" and (i == 0 or not raw[i - 1].isalnum())
                                        and (i + 3 == n or not raw[i + 3].isalnum()) and not "".join(out).strip()):
                break
            if c == "#" and not "".join(out).strip():  # #If/#Region directive
                break
            out.append(c)
            i += 1
        line = "".join(out).rstrip()
        if line.endswith(" _") or line == "_":
            buf.append(line[:-1])
            continue
        depth = max(0, depth + line.count("(") + line.count("{") - line.count(")") - line.count("}"))
        if line and (depth or line[-1] in ",({&+=."):
            buf.append(line)
            continue
        buf.append(line)
        joined = " ".join(buf)
        buf, depth = [], 0
        # ":" separates statements (but not ":=" named arguments).
        parts = re.split(r":(?!=)", joined)
        # VB 14: a line that starts with "." continues the previous one
        # (Dim r = F()  /  .Run()), except inside With, where .X is a member
        # of the With object.
        head = parts[0].strip().lower()
        if head.startswith(".") and not withs:
            k = len(lines) - 1
            while k >= 0 and not lines[k].strip():
                k -= 1
            if k >= 0:
                lines[k] = lines[k].rstrip() + " " + parts[0].strip()
                parts = parts[1:]
        for part in parts:
            low = part.strip().lower()
            if re.match(r"with\b", low):
                withs += 1
            elif re.match(r"end\s+with\b", low):
                withs = max(0, withs - 1)
        lines.extend(parts)
    if buf:
        lines.append(" ".join(buf))
    return lines, strings


def vb_type(text):
    """Chains of a written VB type: Foo, Ns.Foo, List(Of Foo) -> element Foo."""
    text = text.strip()
    m = re.match(r"([\w.\[\]]+)(?:\s*\(\s*of\s+(.*)\))?", text)
    if not m:
        return []
    head = m.group(1).replace("[", "").replace("]", "")
    if head.startswith("global."):      # Global.Ns.Foo: from the root namespace
        head = GLOBAL + head[len("global."):]
    chains = [] if head in PREDEFINED or head in KEYWORDS else [(head, False)]
    for arg in re.findall(r"[a-z_][\w.]*", m.group(2) or ""):
        if arg not in KEYWORDS and arg not in PREDEFINED and arg != "of":
            chains.append((arg, True))
    return chains


def vb_expr(text):
    """First member-access chain of an expression (see parse_expr)."""
    toks = TOKEN_RE.findall(text)
    if toks and toks[0] == "await":
        toks = toks[1:]
    parsed = parse_expr(toks, 0, KEYWORDS) if toks else None
    return parsed[0] if parsed else None


def scan(rel, text, root_ns=""):
    info = FileInfo(rel)
    lines, strings = strip_vb(text)
    info.strings = strings
    stack = []      # (kind, name) of open Namespace/Class/Module... blocks
    body = []
    member = None   # "sub"/"function"/"property"/"operator" body being read
    enum_members = set()    # member names of the enum being read
    lines = [line for line in lines if line.strip()]

    def ns():
        parts = [name for kind, name in stack if kind == "namespace"]
        if parts and parts[0].startswith("global."):
            return ".".join([parts[0][len("global."):]] + parts[1:])
        return ".".join([root_ns] + parts if root_ns else parts)

    def declare(name):
        """A type (or delegate) declared at this point. One nested in a class
        is a type of its own (N.A.Inner and N.B.Inner); a Module's members,
        nested types too, are promoted to its namespace."""
        info.namespaces.add(ns())
        info.decls.append((ns(), name))
        outer = [n for kind, n in stack if kind != "namespace"]
        if outer and stack[-1][0] != "module":
            info.nested[join(ns(), name)] = join(ns(), ".".join(outer + [name]))

    def enclosing():
        return [join(ns(), name) for kind, name in reversed(stack) if kind != "namespace"]

    def bind_params(low):
        for name, typ in PARAM_RE.findall(low[low.find("("):] if "(" in low else ""):
            chains = vb_type(typ)
            if chains:
                info.flow.append(("bind", name, enclosing(), [], chains, False, ns()))

    def body_line(low):
        m = DIM_RE.match(low)
        if m:
            name, typ, value = m.group(1), m.group(2), m.group(3)
            chains = vb_type(typ) if typ else []
            expr = vb_expr(value) if value else None
            if chains or expr:
                info.flow.append(("bind", name, enclosing(), [expr] if expr else [], chains, False, ns()))
        m = FOREACH_RE.match(low)
        if m:
            name, typ, value = m.group(1), m.group(2), m.group(3)
            expr = vb_expr(value)
            info.flow.append(("bind", name, enclosing(), [expr] if expr else [], vb_type(typ) if typ else [], True, ns()))
        toks = TOKEN_RE.findall(low)
        for i, t in enumerate(toks):
            if i and toks[i - 1] == ".":
                continue
            if t in {"new", "me", "mybase"} or (is_ident(t) and t not in KEYWORDS):
                parsed = parse_expr(toks, i, KEYWORDS)
                if parsed and (parsed[0][2] or parsed[0][0] == "new"):
                    info.flow.append(("use", enclosing(), parsed[0], ns()))

    for idx, line in enumerate(lines):
        low = line.lower()
        if member:
            if re.match(rf"^\s*end\s+{member}\b", low):
                member = None
            else:
                body_line(low)
            body.append((ns(), line))
            continue
        m = IMPORTS_RE.match(low)
        if m:
            # Imports A, B = C.D: one clause per comma. XML namespace
            # imports (<xmlns:...>) name no type and are skipped.
            for clause in top_level_split(m.group(1)):
                # Imports L = List(Of Acme.Order): the alias stands for the
                # generic type, and the type arguments are names this file uses.
                clause, paren, args = clause.partition("(")
                if paren:
                    body.append((ns(), "(" + args))
                c = IMPORT_CLAUSE_RE.match(re.sub(r"\s+", "", clause))
                if not c:
                    continue
                alias, target = c.group(1), c.group(2).replace("[", "").replace("]", "")
                if target.startswith("global."):    # Imports Global.Core: Core from the root
                    target = target[len("global."):]
                if alias:
                    info.aliases[alias.replace("[", "").replace("]", "")] = target
                else:
                    info.usings.add(target)
            continue
        m = END_RE.match(low)
        if m:
            kind = m.group(1)
            while stack:
                if stack.pop()[0] == kind:
                    break
            body.append((ns(), line))
            continue
        m = BLOCK_RE.match(low)
        if m:
            kind, name = m.group(1), m.group(2).replace("[", "").replace("]", "")
            enum_members = set()
            if kind == "enum":
                # All member names first: a value may name a later sibling.
                for later in lines[idx + 1:]:
                    if END_RE.match(later.lower()):
                        break
                    e = re.match(r"^\s*(?:<[^>]*>\s*)?([\w\[\]]+)", later)
                    if e:
                        enum_members.add(e.group(1).replace("[", "").replace("]", "").lower())
            if kind == "namespace":
                stack.append((kind, name))
                info.namespaces.add(ns())
                continue
            declare(name)
            if re.search(r"\bpartial\b", low[:m.start(1)]):
                info.partial.add(f"{ns()}.{name}" if ns() else name)
            stack.append((kind, name))
            info.type_members.setdefault(join(ns(), name), {})
            info.type_ns.setdefault(join(ns(), name), ns())
            body.append((ns(), line[m.end(2):]))
            continue
        m = DELEGATE_RE.match(low)
        if m:
            declare(m.group(1).replace("[", "").replace("]", ""))
            body.append((ns(), line[m.end(1):]))
            continue
        if stack and stack[-1][0] == "enum":
            # An enum member (Customer, Order = 2) is declared, not a type reference.
            # So is a sibling written bare in a value (Both = Order Or Customer).
            m = re.match(r"^(\s*(?:<[^>]*>\s*)?)([\w\[\]]+)", line)
            if m:
                enum_members.add(m.group(2).replace("[", "").replace("]", "").lower())
                rest = SIBLING_RE.sub(lambda x: " " * len(x.group(0)) if x.group(0).replace("[", "").replace("]", "").lower()
                                      in enum_members else x.group(0), line[m.end(2):])
                line = line[:m.start(2)] + " " * (m.end(2) - m.start(2)) + rest
            body.append((ns(), line))
            continue
        in_type = stack and stack[-1][0] in {"class", "module", "structure", "interface"}
        if in_type:
            owner = join(ns(), stack[-1][1])
            m = INHERITS_RE.match(low)
            if m:
                for base in m.group(2).split(","):
                    info.type_bases.setdefault(owner, []).extend(c for c, elem in vb_type(base) if not elem)
                body.append((ns(), line))
                continue
            m = MEMBER_RE.match(low)
            declared = m and (m.group(1) or re.match(r"^\s*(?:<[^>]*>\s*)?(?:public|friend|private|protected|const|dim|shared|readonly)\b", low))
            if declared:
                name = m.group(2).replace("[", "").replace("]", "")
                # The declared name (Property Customer As Integer) is not a type reference.
                line = line[:m.start(2)] + " " * (m.end(2) - m.start(2)) + line[m.end(2):]
                kind = (m.group(1) or "").split()[0] if m.group(1) else ""
                if name not in KEYWORDS:
                    typ = MEMBER_TYPE_RE.search(low[m.end(2):])
                    info.type_members[owner].setdefault(name, []).extend(vb_type(typ.group(1)) if typ else [])
                    if stack[-1][0] == "module":
                        # Module members are visible like types in the module's namespace.
                        info.decls.append((ns(), name))
                        info.member_decls.add(join(ns(), name))
                        info.extensions.append((ns(), name))  # <Extension> methods live in modules
                abstract = re.search(r"\bmustoverride\b", low[:m.start(2)]) or stack[-1][0] == "interface"
                if kind in {"sub", "function", "operator"} and not abstract:
                    member = kind
                    bind_params(low)
                elif kind == "property" and not abstract:
                    # An auto-implemented property has no Get/Set block.
                    nxt = lines[idx + 1].lower().lstrip() if idx + 1 < len(lines) else ""
                    nxt = re.sub(r"^(?:<[^>]*>\s*)?(?:(?:public|private|friend|protected)\s+)*", "", nxt)
                    if re.match(r"(?:get|set)\b", nxt):     # not Settings As ...
                        member = "property"
                        bind_params(low)
                elif not kind:
                    # A field initializer: Private _x As New Foo(), Dim y = Bar.Create()
                    body_line(low)
        body.append((ns(), line))
    if not info.namespaces:
        info.namespaces.add(root_ns)
    code = "\n".join(line for _, line in body).lower()
    # Each name is resolved from the namespace block it is written in.
    for ctx, line in body:
        low = line.lower()
        # Names a parameter, local or loop variable declares (o As Order,
        # Dim order = 1, For Each customer As String) are not types.
        declared = {m.start(1) if m.group(1) else m.start(2) for m in DECLARED_RE.finditer(low)}
        for pos, name in chains_at(low, KEYWORDS, fold=True):
            if pos in declared and "." not in name:
                continue
            info.names.append((ctx, name))
            if "." in name and type_written_at(low, pos, CHAIN_RE.match(low, pos).end(), TYPE_BEFORE):
                info.type_chains.append((ctx, name))
    info.members = members(code)
    for m in REFLECTION_RE.finditer(code):
        arg = (m.group(2) or "").strip()
        if not arg.startswith('""'):
            info.dynamic.append((f"{m.group(1)}({arg})", "late binding or reflection with a computed name"))
    return info


def merge_info(info, other):
    """Add what other (the same file scanned under another RootNamespace)
    declares and names to info."""
    for key, value in vars(other).items():
        mine = getattr(info, key)
        if isinstance(mine, list):
            mine.extend(v for v in value if v not in mine)
        elif isinstance(mine, set):
            mine |= value
        elif isinstance(mine, dict):
            for k, v in value.items():
                mine.setdefault(k, v)


def mapper(root, warnings, args):
    files = find_files(root, EXTS, SKIP_DIRS, warnings=warnings)
    rels = [path.relative_to(root).as_posix() for path in files]
    visible_files, not_compiled, projects_of, texts = dotnet_projects(root, rels, ".vbproj", warnings)
    root_ns = {}        # project dir -> RootNamespace candidates
    for proj in find_files(root, {".vbproj"}, SKIP_DIRS):
        d = proj.parent.relative_to(root).as_posix()
        d = "" if d == "." else d
        if d not in root_ns:
            text = texts[d] if d in texts else COMMENT_RE.sub("", read_source(proj, warnings))
            root_ns[d] = root_namespaces(text, proj.stem, warnings, d or ".")
    infos, deep = [], set()
    spelled = {}        # lower-cased namespace (and each prefix) -> as first written, for external.tsv
    def spell(name):
        segs = name.replace("[", "").replace("]", "").split(".")
        for k in range(1, len(segs) + 1):
            spelled.setdefault(".".join(segs[:k]).lower(), ".".join(segs[:k]))
    for path, rel in zip(files, rels):
        # A file linked into several projects is compiled under each one's
        # RootNamespace: it declares its types in every one of them.
        spaces = sorted({space for d in projects_of[rel] if d in root_ns for space in root_ns[d]})
        if not spaces:
            spaces = next((root_ns[d] for d in sorted(root_ns, key=len, reverse=True)
                           if d == "" or rel.startswith(d + "/")), [""])
        text = read_source(path, warnings)
        # Logical lines, without comments: Imports Acme.Billing ' note, and
        # every dotted name (a full name written inline).
        for line in strip_vb(text)[0]:
            m = IMPORTS_RE.match(line)
            for clause in (top_level_split(m.group(1)) if m else ()):
                c = IMPORT_CLAUSE_RE.match(re.sub(r"\s+", "", clause.partition("(")[0]))
                if c:
                    spell(re.sub(r"(?i)^global\.", "", c.group(2)))
            for name in chains(line, ()):
                if "." in name:
                    spell(re.sub(r"(?i)^global(?:::|\.)", "", name))
        info = scan_or_none(scan, rel, text, deep, spaces[0]) or FileInfo(rel)
        for space in spaces[1:]:
            other = scan_or_none(scan, rel, text, deep, space)
            if other:
                merge_info(info, other)
        infos.append(info)
    # Project-level <Import Include> applies to the files of its projects only.
    computed = set()        # (project dir, Include holding an MSBuild property)
    imports_of = {d: vbproj_imports(text, warnings, d or ".") for d, text in sorted(texts.items())}
    for info in infos:
        for d in projects_of[info.rel]:
            for name in imports_of.get(d, ()):
                if "$(" in name or "@(" in name or "%(" in name:
                    computed.add((d, name.strip()))
                elif name.strip():
                    info.usings.add(name.strip().lower())
                    spell(name.strip())
    computed_rows = set()
    project_file = {}
    for proj in find_files(root, {".vbproj"}, SKIP_DIRS):
        rel = proj.relative_to(root).as_posix()
        project_file.setdefault(rel.rpartition("/")[0], rel)
    for d, name in sorted(computed):
        warnings.append(f"{d or '.'}: <Import Include=\"{name}\"> uses an MSBuild property that is not evaluated; "
                        "it is not applied, so names it would import may be missing")
        computed_rows.add((project_file.get(d, d or "."), f'<Import Include="{name}">',
                           "MSBuild property not evaluated; the names it imports may be missing"))
    skipped = drop_not_compiled(infos, not_compiled)
    edges, unresolved = resolve(infos, fold=True, visible_files=visible_files, standard=DOTNET_STANDARD)
    # Names are matched case-insensitively; external.tsv shows them as written.
    unresolved = {(a, spelled.get(r, r) if why.startswith(EXTERNAL) else r, why) for a, r, why in unresolved}
    return rels, edges, unresolved | skipped | deep | computed_rows


if __name__ == "__main__":
    run("Map file dependencies of a VB.NET codebase from its source text.", mapper)
