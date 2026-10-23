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

Known limits, listed in unresolved.tsv where the source shows them:
  - a type used without its name being written (Dim x = F(), With blocks,
    late binding on Object) gives no direct edge; the edge to F's file
    usually connects it indirectly. Audit these with the sample/diff CLI.
  - a local name equal to a type or module member gives an extra edge.
  - CreateObject/Activator/Type.GetType with a computed name is unresolved.
  - every #If branch is mapped. VB6 (.bas/.cls/.frm) is a different
    language and is not read.

Skipped directories: bin, obj, packages, My Project, plus node_modules,
__pycache__, generated and every directory starting with ".".

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
from depmap_typed import FileInfo, chains, members, resolve  # noqa: E402

EXTS = {".vb"}
SKIP_DIRS = {"bin", "obj", "packages", "my project"}
MODIFIERS = (r"(?:(?:public|private|friend|protected|partial|mustinherit|notinheritable|shadows|"
             r"shared|overloads|overrides|overridable|notoverridable|mustoverride|static|default|"
             r"readonly|writeonly|async|iterator|widening|narrowing|withevents|const|dim)\s+)*")
BLOCK_RE = re.compile(r"^\s*(?:<[^>]*>\s*)?" + MODIFIERS + r"(class|module|structure|interface|enum|namespace)\s+([\w.\[\]]+)", re.IGNORECASE)
END_RE = re.compile(r"^\s*end\s+(class|module|structure|interface|enum|namespace)\b", re.IGNORECASE)
DELEGATE_RE = re.compile(r"^\s*(?:<[^>]*>\s*)?" + MODIFIERS + r"delegate\s+(?:sub|function)\s+([\w\[\]]+)", re.IGNORECASE)
MEMBER_RE = re.compile(r"^\s*(?:<[^>]*>\s*)?" + MODIFIERS + r"(?:(sub|function|property|event|declare\s+(?:ansi\s+|unicode\s+|auto\s+)?(?:sub|function))\s+)?([\w\[\]]+)", re.IGNORECASE)
IMPORTS_RE = re.compile(r"^\s*imports\s+(?:([\w\[\]]+)\s*=\s*)?([\w.\[\]]+)\s*$", re.IGNORECASE)
ROOT_NS_RE = re.compile(r"<RootNamespace>\s*([^<]*?)\s*</RootNamespace>", re.IGNORECASE)
VBPROJ_IMPORT_RE = re.compile(r'<Import\s+Include\s*=\s*"([^"]+)"', re.IGNORECASE)
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
    (lines, strings). A trailing " _" joins the next physical line; ":"
    outside strings splits statements."""
    lines, strings, buf = [], [], []
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
        buf.append(line)
        joined = " ".join(buf)
        buf = []
        # ":" separates statements (but not ":=" named arguments).
        lines.extend(part for part in re.split(r":(?!=)", joined))
    if buf:
        lines.append(" ".join(buf))
    return lines, strings


def scan(rel, text, root_ns=""):
    info = FileInfo(rel)
    lines, strings = strip_vb(text)
    info.strings = strings
    stack = []      # (kind, name) of open Namespace/Class/Module... blocks
    body = []
    member = None   # "sub"/"function"/"property" body open inside a Module
    lines = [line for line in lines if line.strip()]

    def ns():
        parts = [name for kind, name in stack if kind == "namespace"]
        if parts and parts[0].startswith("global."):
            return ".".join([parts[0][len("global."):]] + parts[1:])
        return ".".join([root_ns] + parts if root_ns else parts)

    for idx, line in enumerate(lines):
        low = line.lower()
        if member:
            if re.match(rf"^\s*end\s+{member}\b", low):
                member = None
            body.append(line)
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
            body.append(line)
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
            body.append(line[m.end(2):])
            continue
        m = DELEGATE_RE.match(low)
        if m:
            info.namespaces.add(ns())
            info.decls.append((ns(), m.group(1).replace("[", "").replace("]", "")))
            body.append(line[m.end(1):])
            continue
        # Module members are visible like types in the module's namespace.
        if stack and stack[-1][0] == "module":
            m = MEMBER_RE.match(low)
            if m and (m.group(1) or re.match(r"^\s*(?:<[^>]*>\s*)?(?:public|friend|private|const|dim|shared|readonly)\b", low)):
                name = m.group(2).replace("[", "").replace("]", "")
                if name not in KEYWORDS:
                    info.decls.append((ns(), name))
                    info.extensions.append((ns(), name))  # <Extension> methods live in modules
                kind = (m.group(1) or "").split()[0] if m.group(1) else ""
                if kind in {"sub", "function"}:
                    member = kind
                elif kind == "property":
                    # An auto-implemented property has no Get/Set block.
                    nxt = lines[idx + 1].lower().lstrip() if idx + 1 < len(lines) else ""
                    nxt = re.sub(r"^(?:<[^>]*>\s*)?(?:(?:public|private|friend|protected)\s+)*", "", nxt)
                    if nxt.startswith(("get", "set")):
                        member = "property"
        body.append(line)
    if not info.namespaces:
        info.namespaces.add(root_ns)
    code = "\n".join(body).lower()
    info.names = chains(code, KEYWORDS)
    info.members = members(code)
    for m in REFLECTION_RE.finditer(code):
        arg = (m.group(2) or "").strip()
        if not arg.startswith('""'):
            info.dynamic.append((f"{m.group(1)}({arg})", "late binding or reflection with a computed name"))
    return info


def mapper(root, warnings):
    files = find_files(root, EXTS, SKIP_DIRS)
    rels, infos, global_imports, root_ns = [], [], set(), {}
    for proj in find_files(root, {".vbproj"}, SKIP_DIRS):
        text = read_source(proj, warnings)
        global_imports.update(VBPROJ_IMPORT_RE.findall(text))
        m = ROOT_NS_RE.search(text)
        root_ns.setdefault(proj.parent, (m.group(1).strip() if m else proj.stem).lower())
    for path in files:
        rel = path.relative_to(root).as_posix()
        project = next((root_ns[d] for d in path.parents if d in root_ns), "")
        infos.append(scan(rel, read_source(path, warnings), project))
        rels.append(rel)
    edges, unresolved = resolve(infos, fold=True, global_usings=global_imports)
    return rels, edges, unresolved


if __name__ == "__main__":
    run("Map file dependencies of a VB.NET codebase from its source text.", mapper)
