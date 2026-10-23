#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Deterministic dependency mapper for PHP codebases (stdlib only).

Implements the kit's dependency-map contract (prompts/01-dependency-map.md) by
reading PHP files as text. It never runs PHP or the application.

Two kinds of edges:
  - include/require(_once) with a path PHP can be seen to compute: a literal,
    __DIR__ or dirname(__FILE__) / dirname(__DIR__) joined with literals. The
    path is resolved against the including file's directory, then --root;
    a path behind an unknown constant (APP_ROOT . '/lib/a.php') is matched by
    its literal tail when exactly one file ends with it.
  - names: classes, interfaces, traits and enums (case-insensitive, as PHP),
    top-level functions (case-insensitive, with PHP's fallback to the global
    namespace) and constants (define() / const, case-sensitive). Every name
    the code mentions is resolved through the current namespace, `use`
    imports (grouped, aliased, function, const) and fully qualified \\names.
    Legacy code without namespaces resolves in the global namespace, so an
    autoloader is not needed to find the declaring file. A string literal that
    equals a declared class's full name ('App\\Models\\User', 'Foo::bar') counts.

Only code between <?php / <?= and ?> is read; inline HTML is not.

Known limits, listed in unresolved.tsv where the source shows them:
  - include/require of a computed path ($dir . $name) and `new $class`,
    `$class::m()`, call_user_func($x) are dynamic.
  - method calls ($obj->m()) have no static target; the class that built
    $obj is usually named elsewhere in the file and gives the edge.
  - a local name equal to a declared function or constant gives an extra edge.

Skipped directories: vendor, plus node_modules, __pycache__, generated and
every directory starting with ".".

Usage:
  python3 depmap_php.py --root path/to/repo --out path/to/migration/depmap
Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)
and unresolved.tsv (file, reference, reason).

Test: python3 scripts/depmap_php.py --root fixtures/php --out /tmp/depmap-php && diff /tmp/depmap-php/edges.tsv fixtures/php/expected_edges.tsv
"""

import posixpath
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, read_source, run  # noqa: E402

EXTS = {".php", ".inc", ".phtml", ".php3", ".php4", ".php5", ".module"}
SKIP_DIRS = {"vendor"}
KEYWORDS = set("""abstract and array as break callable case catch class clone const continue declare
default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval
exit extends final finally fn for foreach function global goto if implements include include_once
instanceof insteadof interface isset list match namespace new or print private protected public
readonly require require_once return static switch throw trait try unset use var while xor yield
self parent true false null int float bool string void mixed never object iterable die from""".split())
NAME_RE = re.compile(r"\\?[A-Za-z_\x80-\uffff][\w\x80-\uffff]*(?:\\[A-Za-z_\x80-\uffff][\w\x80-\uffff]*)*")
STR = "\x01"   # string placeholder: \x01<index>\x02 (never part of a name)


def php_code(text):
    """Code between PHP open and close tags, comments removed and each string
    replaced by a placeholder. Returns (code, strings)."""
    out, strings = [], []
    i, n = 0, len(text)
    in_php = False
    while i < n:
        if not in_php:
            j = text.find("<?", i)
            if j < 0:
                break
            out.append("\n" * text.count("\n", i, j) + ";")
            i = j + 2
            if text.startswith("php", i):
                i += 3
            elif text.startswith("=", i):
                i += 1
            in_php = True
            continue
        c = text[i]
        if c == "?" and text.startswith("?>", i):
            out.append(";")
            in_php = False
            i += 2
            continue
        if c == "#" and not text.startswith("#[", i) or c == "/" and text.startswith("//", i):
            j = i
            while j < n and text[j] != "\n" and not text.startswith("?>", j):
                j += 1
            i = j
            continue
        if c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            end = n if j < 0 else j + 2
            out.append(" " + "\n" * text.count("\n", i, end))
            i = end
            continue
        if c in "'\"":
            j, buf = i + 1, []
            while j < n and text[j] != c:
                if text[j] == "\\" and j + 1 < n:
                    nxt = text[j + 1]
                    buf.append(nxt if nxt in "\\'\"$" else text[j:j + 2])
                    j += 2
                    continue
                buf.append(text[j])
                j += 1
            strings.append("".join(buf))
            out.append(f"{STR}{len(strings) - 1}\x02" + "\n" * text.count("\n", i, j))
            i = j + 1
            continue
        if c == "<" and text.startswith("<<<", i):
            m = re.match(r"<<<[ \t]*(['\"]?)([A-Za-z_]\w*)\1\r?\n", text[i:])
            if m:
                tag = m.group(2)
                end = re.compile(r"^[ \t]*" + re.escape(tag) + r"\b", re.MULTILINE).search(text, i + m.end())
                stop = n if not end else end.end()
                body = text[i + m.end():end.start() if end else n]
                strings.append(body)
                out.append(f"{STR}{len(strings) - 1}\x02" + "\n" * body.count("\n"))
                i = stop
                continue
        out.append(c)
        i += 1
    return "".join(out), strings


class FileInfo:
    def __init__(self, rel):
        self.rel = rel
        self.classes, self.functions, self.constants = [], [], []   # declared FQNs
        self.refs = []          # (namespace, name, is_call, uses)
        self.includes = []      # (expression parts) or None for dynamic
        self.strings = []
        self.dynamic = []


def lower(name):
    return name.lower()


def scan(rel, text):
    info = FileInfo(rel)
    code, info.strings = php_code(text)
    toks = [(m.group(0), m.start()) for m in re.finditer(
        r"\x01\d+\x02|" + NAME_RE.pattern + r"|\$[\w\x80-\uffff]+|->|\?->|::|\S", code)]
    ns = ""
    uses = {"class": {}, "function": {}, "const": {}}   # alias -> fqn
    class_depth = []    # brace depth at which each open class body started
    depth = 0
    i, n = 0, len(toks)

    def at(k):
        return toks[k][0] if 0 <= k < n else ""

    def string(tok):
        return info.strings[int(tok[1:-1])]

    while i < n:
        t = at(i)
        prev = at(i - 1)
        low = t.lower()
        if t == "{":
            depth += 1
        elif t == "}":
            depth -= 1
            if class_depth and class_depth[-1] == depth:
                class_depth.pop()
        elif low == "namespace" and prev not in {"\\"} and (NAME_RE.fullmatch(at(i + 1)) or at(i + 1) == "{"):
            if at(i + 1) == "{":
                ns = ""
            else:
                ns = at(i + 1).lstrip("\\")
                i += 1
            uses = {"class": {}, "function": {}, "const": {}}
        elif low == "use" and not class_depth and at(i + 1) != "(":
            # use A\B; use A\B as C; use function a\f; use A\{B, C as D, function e};
            kind, group = "class", None
            j = i + 1
            if at(j).lower() in {"function", "const"}:
                kind = at(j).lower()
                j += 1
            while j < n and at(j) != ";":
                tok = at(j)
                if NAME_RE.fullmatch(tok) and at(j + 1) == "\\" and at(j + 2) == "{":
                    group = tok.lstrip("\\")
                    j += 3
                    continue
                if NAME_RE.fullmatch(tok) and tok.lower() != "as":
                    item = kind
                    if group is not None and tok.lower() in {"function", "const"} and NAME_RE.fullmatch(at(j + 1)):
                        item = tok.lower()
                        j += 1
                        tok = at(j)
                    tok = tok.lstrip("\\")
                    full = group + "\\" + tok if group else tok
                    alias = full.rsplit("\\", 1)[-1]
                    if at(j + 1).lower() == "as":
                        alias = at(j + 2)
                        j += 2
                    uses[item][alias if item == "const" else alias.lower()] = full
                    info.refs.append((ns, "\\" + full, item == "function", None))
                j += 1
            i = j
            continue
        elif low in {"class", "interface", "trait", "enum"} and prev not in {"::", "new", "->", "?->"} \
                and NAME_RE.fullmatch(at(i + 1)) and at(i + 1).lower() not in KEYWORDS:
            name = at(i + 1)
            info.classes.append(f"{ns}\\{name}".lstrip("\\"))
            # The body starts at the next "{" at this depth.
            class_depth.append(depth)
            i += 2
            continue
        elif low == "function" and NAME_RE.fullmatch(at(i + 1)) and at(i + 2) == "(" and not class_depth:
            info.functions.append(f"{ns}\\{at(i + 1)}".lstrip("\\"))
            i += 2
            continue
        elif low == "function" and at(i + 1) == "&" and NAME_RE.fullmatch(at(i + 2)) and not class_depth:
            info.functions.append(f"{ns}\\{at(i + 2)}".lstrip("\\"))
            i += 3
            continue
        elif low == "const" and not class_depth and NAME_RE.fullmatch(at(i + 1)):
            info.constants.append(f"{ns}\\{at(i + 1)}".lstrip("\\"))
            i += 2
            continue
        elif low == "define" and at(i + 1) == "(" and at(i + 2).startswith(STR):
            info.constants.append(string(at(i + 2)).lstrip("\\"))
        elif low in {"include", "include_once", "require", "require_once"}:
            j, parts = i + 1, []
            while j < n and at(j) not in {";"}:
                parts.append(at(j))
                j += 1
            info.includes.append(parts)
            i = j
            continue
        elif low == "new" and at(i + 1).lower() == "class":
            class_depth.append(depth)   # anonymous class: its methods are not global
            i += 2
            continue
        elif low == "new" and at(i + 1).startswith("$"):
            info.dynamic.append((f"new {at(i + 1)}", "class name computed at run time"))
        elif t.startswith("$") and at(i + 1) == "::":
            info.dynamic.append((f"{t}::", "class name computed at run time"))
        elif NAME_RE.fullmatch(t) and low not in KEYWORDS and prev not in {"->", "?->", "::"}:
            if not (prev.lower() in {"function", "const"} and not t.startswith("\\")):
                info.refs.append((ns, t, at(i + 1) == "(", uses))
        i += 1
    return info


def resolve_include(src, parts, info, by_rel, by_tail):
    """Edge targets for one include expression, or a reason it is dynamic."""
    base, pieces, unknown_prefix = None, [], False
    k = 0
    toks = [p for p in parts if p not in {"(", ")"}]
    while k < len(toks):
        t = toks[k]
        tl = t.lower()
        if t.startswith(STR):
            piece = info.strings[int(t[1:-1])]
            if "$" in piece:
                return None, "include path computed at run time"
            pieces.append(piece)
        elif tl == "__dir__":
            base = posixpath.dirname(src)
        elif tl == "dirname" and k + 1 < len(toks) and toks[k + 1].lower() in {"__file__", "__dir__"}:
            # dirname(__FILE__) is the file's directory; dirname(__DIR__, 2)
            # climbs two levels from it.
            base = src if toks[k + 1].lower() == "__file__" else posixpath.dirname(src)
            levels = 1
            if k + 3 < len(toks) and toks[k + 2] == "," and toks[k + 3].isdigit():
                levels = int(toks[k + 3])
            for _ in range(levels):
                base = posixpath.dirname(base)
            k += 4 if k + 2 < len(toks) and toks[k + 2] == "," else 2
            continue
        elif t == ".":
            pass
        elif NAME_RE.fullmatch(t) and t.upper() == t and not pieces:
            unknown_prefix = True       # APP_ROOT . '/x.php'
        else:
            return None, "include path computed at run time"
        k += 1
    if not pieces:
        return None, "include path computed at run time"
    path = "".join(pieces)
    if base is not None:
        cand = [posixpath.normpath(posixpath.join(base, path.lstrip("/") if path.startswith("/") else path))]
    elif unknown_prefix:
        cand = []
    else:
        cand = [posixpath.normpath(posixpath.join(posixpath.dirname(src), path)),
                posixpath.normpath(path.lstrip("/"))]
    for c in cand:
        if c in by_rel:
            return [c], None
    tail = posixpath.normpath(path.lstrip("./").lstrip("/"))
    hits = by_tail.get(tail.lower(), [])
    if len(hits) == 1:
        return hits, None
    if len(hits) > 1:
        return None, f"include path matches {len(hits)} files"
    return None, "included file not found under --root"


def mapper(root, warnings):
    files = find_files(root, EXTS, SKIP_DIRS)
    rels, infos = [], []
    for path in files:
        rel = path.relative_to(root).as_posix()
        infos.append(scan(rel, read_source(path, warnings)))
        rels.append(rel)
    by_rel = set(rels)
    by_tail = {}
    for rel in rels:
        parts = rel.split("/")
        for k in range(len(parts)):
            by_tail.setdefault("/".join(parts[k:]).lower(), []).append(rel)
    classes, functions, constants = {}, {}, {}
    for info in infos:
        for c in info.classes:
            classes.setdefault(c.lower(), set()).add(info.rel)
        for f in info.functions:
            functions.setdefault(f.lower(), set()).add(info.rel)
        for c in info.constants:
            constants.setdefault(c, set()).add(info.rel)

    edges, unresolved = set(), set()
    for info in infos:
        src = info.rel

        def add(targets):
            for t in targets:
                if t != src:
                    edges.add((src, t))

        for parts in info.includes:
            hit, why = resolve_include(src, parts, info, by_rel, by_tail)
            if hit:
                add(hit)
            else:
                expr = " ".join("'" + info.strings[int(p[1:-1])] + "'" if p.startswith(STR) else p for p in parts)
                unresolved.add((src, f"include {expr}", why))
        for ns, name, is_call, uses in info.refs:
            if name.startswith("\\"):
                full = name[1:]
                add(classes.get(full.lower(), ()))
                add(functions.get(full.lower(), ()))
                add(constants.get(full, ()))
                continue
            head, _, rest = name.partition("\\")
            uses = uses or {"class": {}, "function": {}, "const": {}}
            if head.lower() in uses["class"]:
                full = uses["class"][head.lower()] + ("\\" + rest if rest else "")
            else:
                full = f"{ns}\\{name}".lstrip("\\")
            add(classes.get(full.lower(), ()))
            if not rest:
                fn = uses["function"].get(name.lower())
                add(functions.get((fn or full).lower(), ()) or functions.get(name.lower(), ()))
                cn = uses["const"].get(name)
                add(constants.get(cn or full, ()) or constants.get(name, ()))
            else:
                add(functions.get(full.lower(), ()))
                add(constants.get(full, ()))
        for s in info.strings:
            name = s.strip().lstrip("\\").split("::")[0].replace("\\\\", "\\")
            if ("\\" in name or "::" in s) and name.lower() in classes:
                add(classes[name.lower()])
        for ref, why in info.dynamic:
            unresolved.add((src, ref, why))
    return rels, edges, unresolved


if __name__ == "__main__":
    run("Map file dependencies of a PHP codebase from its source text.", mapper)
