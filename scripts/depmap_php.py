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

composer.json files under --root (not vendor/) are read: a class declared in
several files maps to the one its PSR-4/PSR-0 path or classmap names, and a
class no file is seen declaring maps to the file at its PSR-4/PSR-0 path.
--include-path DIR,DIR gives PHP's include_path: a relative include is
looked up there first, then next to the including file, then at --root.
An explicit ./x or ../x path is relative to the working directory, which
the source does not show: it is looked up next to the including file and at
--root only (never in include_path); when those give two different files,
both become edges and the include is listed in unresolved.tsv.

Known limits, listed in unresolved.tsv where the source shows them:
  - include/require of a computed path ($dir . $name) and `new $class`,
    `$class::m()`, call_user_func($x) are dynamic.
  - method calls ($obj->m()) have no static target; the class that built
    $obj is usually named elsewhere in the file and gives the edge.
  - a local name equal to a declared function or constant gives an extra edge.

Skipped directories: vendor at --root or beside composer.json, plus
node_modules, __pycache__ and every directory starting with ".". Each
skipped directory holding PHP files is printed as a warning.

Usage:
  python3 depmap_php.py --root path/to/repo --out path/to/migration/depmap [--include-path lib,inc]
Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)
and unresolved.tsv (file, reference, reason).

Test: python3 scripts/depmap_php.py --root fixtures/php --out /tmp/depmap-php && diff /tmp/depmap-php/edges.tsv fixtures/php/expected_edges.tsv
"""

import json
import posixpath
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, path_list, read_source, run  # noqa: E402

EXTS = {".php", ".inc", ".phtml", ".php3", ".php4", ".php5", ".module"}
# A function or class name in a string, maybe namespaced (App\Util\conv).
BARE_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*")
# Functions whose string arguments name a callback, class or function.
# Existence checks (function_exists, class_exists, is_callable...) are not
# references: two polyfills guarded by function_exists('f') would else
# depend on each other.
CALLBACK_FUNCTIONS = set("""array_map array_filter array_walk array_walk_recursive array_reduce
usort uasort uksort call_user_func call_user_func_array forward_static_call
forward_static_call_array is_subclass_of is_a register_shutdown_function register_tick_function
spl_autoload_register set_error_handler set_exception_handler iterator_apply
preg_replace_callback ob_start header_register_callback add_action add_filter
add_shortcode""".split())
SKIP_DIRS = {"vendor"}
MARKERS = {"composer.json"}        # SKIP_DIRS count only beside it (or at --root)
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
        self.includes = []      # (keyword, expression parts)
        self.strings = []
        self.callables = []     # names in string callables: ("function" | "class", name)
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
            info.includes.append((low, parts))
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
    # String callables: a string argument of a function that takes a
    # callback ('my_cb'), and the class of a ['Cls', 'm'] / array('Cls', 'm')
    # pair. Other strings that only equal a name are not references.
    for k, (t, _) in enumerate(toks):
        if not t.startswith(STR):
            continue
        name = string(t).strip().lstrip("\\").replace("\\\\", "\\")
        if not BARE_NAME_RE.fullmatch(name):
            continue
        before = at(k - 1)
        if (before == "[" or (before == "(" and at(k - 2).lower() == "array")) and at(k + 1) == "," \
                and at(k + 2).startswith(STR) and at(k + 3) in {"]", ")"}:
            info.callables.append(("class", name))
            continue
        level, j = 0, k - 1
        while j >= 0 and k - j < 200:
            tok = at(j)
            if tok in {")", "]"}:
                level += 1
            elif tok in {"(", "["}:
                if level == 0:
                    break
                level -= 1
            elif tok in {";", "{", "}"}:
                j = -1
                break
            j -= 1
        if j > 0 and at(j) == "(" and at(j - 1).lower().lstrip("\\") in CALLBACK_FUNCTIONS:
            info.callables.append(("function", name))
    return info


def resolve_include(src, parts, info, by_rel, by_tail, include_path=()):
    """Edge targets for one include expression, or a reason it is dynamic."""
    base, pieces, unknown_prefix = None, [], False
    k = 0
    toks = [p for p in parts if p not in {"(", ")"}]
    # require 'a.php' or die(...): only the path expression counts.
    stop = next((j for j, p in enumerate(toks) if p.lower() in {"or", "||"}), len(toks))
    toks = toks[:stop]
    while k < len(toks):
        t = toks[k]
        tl = t.lower()
        if tl in {"directory_separator", "ds"}:
            pieces.append("/")      # DS is the usual define('DS', DIRECTORY_SEPARATOR)
        elif tl == "realpath":
            pass                    # realpath(x) names the same file as x
        elif t.startswith(STR):
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
    if base is None and not unknown_prefix and path.replace("\\", "/").startswith(("./", "../")):
        # PHP resolves ./x and ../x against the working directory only, never
        # include_path. The working directory is not in the source: the
        # including file's directory and --root are the usual ones.
        cand = sorted({c for c in (posixpath.normpath(posixpath.join(posixpath.dirname(src), path)),
                                   posixpath.normpath(path)) if c in by_rel})
        if len(cand) == 1:
            return cand, None
        if cand:
            return cand, "explicit relative include depends on the working directory; edges to every candidate"
        return None, "explicit relative include depends on the working directory; no candidate found"
    if base is not None:
        cand = [posixpath.normpath(posixpath.join(base, path.lstrip("/") if path.startswith("/") else path))]
    elif unknown_prefix:
        cand = []
    else:
        # PHP tries include_path first, then the including file's directory.
        cand = [posixpath.normpath(posixpath.join(d, path)) for d in include_path] + [
            posixpath.normpath(posixpath.join(posixpath.dirname(src), path)),
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


def mapper(root, warnings, args):
    files = find_files(root, EXTS, SKIP_DIRS, MARKERS, warnings)
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
    include_path = [p for p in path_list(args.include_path) if p != "."]
    autoload = composer_autoload(root, warnings)
    declared, functions, constants = {}, {}, {}
    for info in infos:
        for c in info.classes:
            declared.setdefault(c.lower(), set()).add(info.rel)
        for f in info.functions:
            functions.setdefault(f.lower(), set()).add(info.rel)
        for c in info.constants:
            constants.setdefault(c, set()).add(info.rel)

    by_lower = {rel.lower(): rel for rel in rels}
    cache = {}

    def classes(key):
        """Files declaring a class (lower-cased name), narrowed by composer
        autoload rules: a class declared in several files maps to the one its
        PSR-4/PSR-0 path or classmap names; a class no scanned file declares
        maps to the file at its PSR-4/PSR-0 path, if that file exists."""
        if key not in cache:
            files = declared.get(key, set())
            by_path = {by_lower[p] for p in autoload.paths(key) if p in by_lower}
            if len(files) > 1:
                narrowed = (files & by_path) or {r for r in files if autoload.in_classmap(r)}
                cache[key] = narrowed or files
            else:
                cache[key] = files or by_path
        return cache[key]

    edges, unresolved = set(), set()
    for info in infos:
        src = info.rel

        def add(targets):
            for t in targets:
                if t != src:
                    edges.add((src, t))

        for keyword, parts in info.includes:
            hit, why = resolve_include(src, parts, info, by_rel, by_tail, include_path)
            if hit:
                add(hit)
            if why:     # unresolved, or resolved to several candidates
                expr = " ".join("'" + info.strings[int(p[1:-1])] + "'" if p.startswith(STR) else p for p in parts)
                unresolved.add((src, f"{keyword} {expr}", why))
        for ns, name, is_call, uses in info.refs:
            if name.startswith("\\"):
                full = name[1:]
                add(classes(full.lower()))
                add(functions.get(full.lower(), ()))
                add(constants.get(full, ()))
                continue
            head, _, rest = name.partition("\\")
            uses = uses or {"class": {}, "function": {}, "const": {}}
            if head.lower() in uses["class"]:
                full = uses["class"][head.lower()] + ("\\" + rest if rest else "")
            else:
                full = f"{ns}\\{name}".lstrip("\\")
            add(classes(full.lower()))
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
            if "\\" in name or "::" in s:
                add(classes(name.lower()))
        # A string callable names a function or class by its fully
        # qualified name (never namespace-relative).
        for kind, name in info.callables:
            add(functions.get(name.lower(), ()) if kind == "function" else classes(name.lower()))
        for ref, why in info.dynamic:
            unresolved.add((src, ref, why))
    return rels, edges, unresolved


COMPOSER_SKIP = {"vendor", "node_modules"}


class Autoload:
    """PSR-4, PSR-0 and classmap entries of every composer.json under --root
    (autoload and autoload-dev; vendor/ is not read)."""

    def __init__(self):
        self.psr4, self.psr0, self.classmap = [], [], []

    def paths(self, key):
        """Candidate files (root-relative, lower-cased class key) for a class."""
        out = []
        for prefix, base in self.psr4:
            if key.startswith(prefix):
                out.append(posixpath.normpath(posixpath.join(base, key[len(prefix):].replace("\\", "/") + ".php")))
        for prefix, base in self.psr0:
            if key.startswith(prefix):
                ns, _, cls = key.rpartition("\\")
                rel = (ns.replace("\\", "/") + "/" if ns else "") + cls.replace("_", "/") + ".php"
                out.append(posixpath.normpath(posixpath.join(base, rel)))
        return out

    def in_classmap(self, rel):
        return any(rel == p or rel.startswith(p.rstrip("/") + "/") for p in self.classmap)


def composer_autoload(root, warnings):
    """Autoload rules, matched case-insensitively against existing paths."""
    auto = Autoload()
    for path in sorted(root.rglob("composer.json")):
        parts = path.relative_to(root).parts
        if any(p.startswith(".") or p in COMPOSER_SKIP for p in parts[:-1]):
            continue
        base = path.parent.relative_to(root).as_posix()
        base = "" if base == "." else base
        try:
            data = json.loads(read_source(path, warnings))
        except ValueError as e:
            warnings.append(f"composer.json not parsed, autoload ignored: {path} ({e})")
            continue
        for section in ("autoload", "autoload-dev"):
            block = data.get(section) or {}
            for kind, target in (("psr-4", auto.psr4), ("psr-0", auto.psr0)):
                for prefix, dirs in (block.get(kind) or {}).items():
                    for d in [dirs] if isinstance(dirs, str) else dirs:
                        target.append((prefix.lower(), posixpath.normpath(posixpath.join(base, d)).lower()
                                       if d not in ("", ".") else base.lower()))
            for entry in block.get("classmap") or []:
                auto.classmap.append(posixpath.normpath(posixpath.join(base, entry)))
    # Longest prefix first, as composer does.
    auto.psr4.sort(key=lambda p: -len(p[0]))
    auto.psr0.sort(key=lambda p: -len(p[0]))
    return auto


if __name__ == "__main__":
    run("Map file dependencies of a PHP codebase from its source text.", mapper,
        [("--include-path", "comma-separated directories (relative to --root) PHP's include_path lists")])
