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
from depmap_common import find_files, read_source, run  # noqa: E402
from depmap_projects import QUOTED, attr_values, dotnet_projects, drop_not_compiled  # noqa: E402
from depmap_typed import GLOBAL, PREDEFINED, TOKEN_RE, FileInfo, chains, is_ident, join, members, parse_expr, resolve  # noqa: E402

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
IMPORTS_RE = re.compile(r"^\s*imports\s+(?:([\w\[\]]+)\s*=\s*)?([\w.\[\]]+)\s*$", re.IGNORECASE)
ROOT_NS_RE = re.compile(r"<RootNamespace>\s*([^<]*?)\s*</RootNamespace>", re.IGNORECASE)
VBPROJ_IMPORT_RE = re.compile(r"<Import\s+Include\s*=\s*" + QUOTED, re.IGNORECASE)
REFLECTION_RE = re.compile(r"\b(createobject|activator\s*\.\s*createinstance|type\s*\.\s*gettype|assembly\s*\.\s*load\w*)\s*\(\s*((?:[^()]|\([^()]*\))+?)?\s*\)", re.IGNORECASE)
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
    for raw in text.splitlines():
        out, i, n = [], 0, len(raw)
        while i < n:
            c = raw[i]
            if c == '"':
                j = i + 1
                s = []
                while j < n:
                    if raw[j] == '"' and j + 1 < n and raw[j + 1] == '"':
                        s.append('"')
                        j += 2
                        continue
                    if raw[j] == '"':
                        break
                    s.append(raw[j])
                    j += 1
                strings.append("".join(s))
                out.append('""')
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
        lines.extend(part for part in re.split(r":(?!=)", joined))
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
    lines = [line for line in lines if line.strip()]

    def ns():
        parts = [name for kind, name in stack if kind == "namespace"]
        if parts and parts[0].startswith("global."):
            return ".".join([parts[0][len("global."):]] + parts[1:])
        return ".".join([root_ns] + parts if root_ns else parts)

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
            alias, target = m.group(1), m.group(2).replace("[", "").replace("]", "")
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
            if kind == "namespace":
                stack.append((kind, name))
                info.namespaces.add(ns())
                continue
            info.namespaces.add(ns())
            info.decls.append((ns(), name))
            if re.search(r"\bpartial\b", low[:m.start(1)]):
                info.partial.add(f"{ns()}.{name}" if ns() else name)
            stack.append((kind, name))
            info.type_members.setdefault(join(ns(), name), {})
            info.type_ns.setdefault(join(ns(), name), ns())
            body.append((ns(), line[m.end(2):]))
            continue
        m = DELEGATE_RE.match(low)
        if m:
            info.namespaces.add(ns())
            info.decls.append((ns(), m.group(1).replace("[", "").replace("]", "")))
            body.append((ns(), line[m.end(1):]))
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
                kind = (m.group(1) or "").split()[0] if m.group(1) else ""
                if name not in KEYWORDS:
                    typ = MEMBER_TYPE_RE.search(low[m.end(2):])
                    info.type_members[owner].setdefault(name, []).extend(vb_type(typ.group(1)) if typ else [])
                    if stack[-1][0] == "module":
                        # Module members are visible like types in the module's namespace.
                        info.decls.append((ns(), name))
                        info.extensions.append((ns(), name))  # <Extension> methods live in modules
                abstract = re.search(r"\bmustoverride\b", low[:m.start(2)]) or stack[-1][0] == "interface"
                if kind in {"sub", "function", "operator"} and not abstract:
                    member = kind
                    bind_params(low)
                elif kind == "property" and not abstract:
                    # An auto-implemented property has no Get/Set block.
                    nxt = lines[idx + 1].lower().lstrip() if idx + 1 < len(lines) else ""
                    nxt = re.sub(r"^(?:<[^>]*>\s*)?(?:(?:public|private|friend|protected)\s+)*", "", nxt)
                    if nxt.startswith(("get", "set")):
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
    info.names = [(ctx, name) for ctx, line in body for name in chains(line.lower(), KEYWORDS, fold=True)]
    info.members = members(code)
    for m in REFLECTION_RE.finditer(code):
        arg = (m.group(2) or "").strip()
        if not arg.startswith('""'):
            info.dynamic.append((f"{m.group(1)}({arg})", "late binding or reflection with a computed name"))
    return info


def mapper(root, warnings, args):
    files = find_files(root, EXTS, SKIP_DIRS, warnings=warnings)
    rels, infos, root_ns = [], [], {}
    for proj in find_files(root, {".vbproj"}, SKIP_DIRS):
        m = ROOT_NS_RE.search(read_source(proj, warnings))
        root_ns.setdefault(proj.parent, (m.group(1).strip() if m else proj.stem).lower())
    for path in files:
        rel = path.relative_to(root).as_posix()
        project = next((root_ns[d] for d in path.parents if d in root_ns), "")
        infos.append(scan(rel, read_source(path, warnings), project))
        rels.append(rel)
    visible_files, not_compiled, owner, texts = dotnet_projects(root, rels, ".vbproj", warnings)
    # Project-level <Import Include> applies to the files of its project only.
    for info in infos:
        text = texts.get(owner[info.rel], "")
        info.usings.update(name.lower() for name in attr_values(VBPROJ_IMPORT_RE, text) if name.strip())
    skipped = drop_not_compiled(infos, not_compiled)
    edges, unresolved = resolve(infos, fold=True, visible_files=visible_files)
    return rels, edges, unresolved | skipped


if __name__ == "__main__":
    run("Map file dependencies of a VB.NET codebase from its source text.", mapper)
