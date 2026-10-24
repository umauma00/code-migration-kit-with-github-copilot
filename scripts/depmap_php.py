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
from depmap_common import EXTERNAL, find_files, path_list, reachable, read_source, run  # noqa: E402

EXTS = {".php", ".inc", ".phtml", ".php3", ".php4", ".php5", ".module"}
# Drupal's PHP files (.install, .test, .theme, .engine, .profile): mapped
# when they open a <?php tag, since other projects use these extensions for
# data.
PHP_IF_TAGGED = {".install", ".test", ".theme", ".engine", ".profile"}
# A function or class name in a string, maybe namespaced (App\Util\conv).
BARE_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*")
# Functions that take a callback, and the 0-based positions of their
# callback arguments: call_user_func('strtolower', 'business') names
# strtolower, not business. Existence checks (function_exists,
# class_exists, is_callable...) are not references: two polyfills guarded
# by function_exists('f') would else depend on each other.
CALLBACK_FUNCTIONS = {
    **dict.fromkeys("""array_map call_user_func call_user_func_array forward_static_call
forward_static_call_array register_shutdown_function register_tick_function spl_autoload_register
set_error_handler set_exception_handler ob_start header_register_callback""".split(), (0,)),
    **dict.fromkeys("""array_filter array_walk array_walk_recursive array_reduce usort uasort uksort
iterator_apply preg_replace_callback add_action add_filter add_shortcode""".split(), (1,)),
}
CALLBACK_PARAM = "callback"     # the parameter's name in each of them (named arguments)
# Functions whose string arguments name a class: positions and parameter names.
CLASS_NAME_FUNCTIONS = {"is_subclass_of": ((0, 1), ("object_or_class", "class")),
                        "is_a": ((0, 1), ("object_or_class", "class"))}
# Existence checks that guard a fallback declaration (!function_exists('f')).
GUARDS = {"function_exists": "function", "class_exists": "class", "interface_exists": "class",
          "trait_exists": "class", "enum_exists": "class", "defined": "const"}
SKIP_DIRS = {"vendor"}
MARKERS = {"composer.json"}        # SKIP_DIRS count only beside it (or at --root)
KEYWORDS = set("""abstract and array as break callable case catch class clone const continue declare
default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval
exit extends final finally fn for foreach function global goto if implements include include_once
instanceof insteadof interface isset list match namespace new or print private protected public
readonly require require_once return static switch throw trait try unset use var while xor yield
self parent true false null int float bool string void mixed never object iterable die from""".split())
# Keywords that older PHP allowed as class names (class Enum before 8.1,
# class Match before 8.0, From never reserved). Away from their keyword
# use (enum Name, match (...), yield from) they are names.
SOFT = {"enum", "match", "from"}
NAME_RE = re.compile(r"\\?[A-Za-z_\x80-\uffff][\w\x80-\uffff]*(?:\\[A-Za-z_\x80-\uffff][\w\x80-\uffff]*)*")
STR = "\x01"   # string placeholder: \x01<index>\x02 (never part of a name)


def hole_end(text, i):
    """text[i] is the { of a string hole; the index after its closing }.
    Quoted literals inside the hole are skipped whole."""
    level, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in "'\"":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            i = j + 1
            continue
        level += {"{": 1, "}": -1}.get(c, 0)
        i += 1
        if not level:
            break
    return i


def php_holes(body):
    """Code inside the {$...} and ${...} holes of an interpolated string
    ("...{$this->t(Hd::class)}..."), each wrapped in parentheses. Quoted
    literals inside a hole are text ("{$a['Order']}" names no class), but
    the holes of a "..." literal inside one are code again. ${name} is a
    variable."""
    out, i, n = [], 0, len(body)
    while i < n:
        if body[i] == "\\":
            i += 2
            continue
        if body.startswith("{$", i) or body.startswith("${", i):
            j = hole_end(body, i if body[i] == "{" else i + 1)
            start = i + 1 if body[i] == "{" else i + 2
            code = body[start:j - 1]
            if body[i] == "$":
                # ${name} and ${name[...]} are the variable $name.
                m = re.match(r"\s*[A-Za-z_]\w*\s*(?=\[|$)", code)
                if m:
                    code = code[m.end():]
            code = re.sub(r"'(?:\\.|[^'\\])*'|\"((?:\\.|[^\"\\])*)\"",
                          lambda m: " 0 " + (php_holes(m.group(1)) if m.group(1) else ""), code)
            out.append(" (" + code.replace("\n", " ") + ")")
            i = j
            continue
        i += 1
    return "".join(out)


def php_code(text):
    """Code between PHP open and close tags, comments removed and each string
    replaced by a placeholder. Returns (code, strings, interpolated): the
    indexes of the "..." strings and heredocs, whose $name is a variable.
    The code inside their holes follows the placeholder."""
    out, strings, interpolated = [], [], set()
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
                if c == '"' and (text.startswith("{$", j) or text.startswith("${", j)):
                    # A hole may hold quotes of its own: "{$a["k"]}".
                    k = hole_end(text, j + 1 if text[j] == "$" else j)
                    buf.append(text[j:k])
                    j = k
                    continue
                if text[j] == "\\" and j + 1 < n:
                    nxt = text[j + 1]
                    buf.append(nxt if nxt in "\\'\"$" else text[j:j + 2])
                    j += 2
                    continue
                buf.append(text[j])
                j += 1
            strings.append("".join(buf))
            if c == '"':
                interpolated.add(len(strings) - 1)
            holes = php_holes(text[i + 1:j]) if c == '"' else ""
            out.append(f"{STR}{len(strings) - 1}\x02" + holes + "\n" * text.count("\n", i, j))
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
                holes = php_holes(body) if m.group(1) != "'" else ""     # not a nowdoc
                if m.group(1) != "'":
                    interpolated.add(len(strings) - 1)
                out.append(f"{STR}{len(strings) - 1}\x02" + holes + "\n" * body.count("\n"))
                i = stop
                continue
        out.append(c)
        i += 1
    return "".join(out), strings, interpolated


class FileInfo:
    def __init__(self, rel):
        self.rel = rel
        self.classes, self.functions, self.constants = [], [], []   # declared FQNs
        self.refs = []          # (namespace, name, is_call, uses)
        self.includes = []      # (keyword, expression parts)
        self.strings = []
        self.interpolated = set()   # indexes of strings whose $name is a variable
        self.callables = []     # names in string callables: ("function" | "class", name)
        self.dynamic = []
        self.guarded = set()    # ("function" | "class" | "const", key) behind a !function_exists(...) guard
        self.const_values = {}  # constant -> literal value of define('X', 'v')
        self.const_exprs = {}   # constant -> value tokens of define('X', <expr>)


def lower(name):
    return name.lower()


def scan(rel, text):
    info = FileInfo(rel)
    code, info.strings, info.interpolated = php_code(text)
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
                and NAME_RE.fullmatch(at(i + 1)) and (at(i + 1).lower() not in KEYWORDS or at(i + 1).lower() in SOFT):
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
        elif low.lstrip("\\") == "class_alias" and at(i + 1) == "(" and prev not in {"->", "?->", "::"}:
            # class_alias(Orig::class, 'Old'): the alias is a class this
            # file declares, so extends Old reaches the original through it.
            j, level = i + 2, 0
            while j < n and not (level == 0 and at(j) in {",", ")"}):
                level += {"(": 1, "[": 1, ")": -1, "]": -1}.get(at(j), 0)
                j += 1
            alias = at(j + 1) if at(j) == "," else ""
            if j == i + 3 and at(i + 2).startswith(STR):      # class_alias('Orig', ...)
                name = string(at(i + 2)).strip().lstrip("\\").replace("\\\\", "\\")
                if BARE_NAME_RE.fullmatch(name):
                    info.callables.append(("class", name))
            if alias.startswith(STR) and at(j + 2) in {")", ","} and BARE_NAME_RE.fullmatch(
                    string(alias).strip().lstrip("\\").replace("\\\\", "\\")):
                info.classes.append(string(alias).strip().lstrip("\\").replace("\\\\", "\\"))
            else:
                info.dynamic.append(("class_alias(...)", "alias name computed at run time"))
        elif low == "define" and at(i + 1) == "(" and at(i + 2).startswith(STR):
            info.constants.append(string(at(i + 2)).lstrip("\\"))
            if at(i + 3) == "," and at(i + 4).startswith(STR) and at(i + 5) == ")":
                info.const_values[string(at(i + 2)).lstrip("\\")] = string(at(i + 4))
            elif at(i + 3) == ",":
                # define('X', dirname(__FILE__) . '/x.php'): an include of X
                # is that path, resolved in this file.
                j, level, value = i + 4, 0, []
                while j < n and not (level == 0 and at(j) in {")", ","}):
                    level += {"(": 1, ")": -1}.get(at(j), 0)
                    value.append(at(j))
                    j += 1
                info.const_exprs[string(at(i + 2)).lstrip("\\")] = value
        elif t == "!" and GUARDS.get(at(i + 1).lower().lstrip("\\")) and at(i + 2) == "(" \
                and at(i + 3).startswith(STR) and at(i + 4) in {")", ","}:
            # if (!function_exists('f')) { function f() ... }: a fallback
            # for a declaration that may exist elsewhere.
            kind = GUARDS[at(i + 1).lower().lstrip("\\")]
            name = string(at(i + 3)).strip().lstrip("\\").replace("\\\\", "\\")
            info.guarded.add((kind, name if kind == "const" else name.lower()))
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
        elif NAME_RE.fullmatch(t) and prev not in {"->", "?->", "::"} and (low not in KEYWORDS or (
                low in SOFT and not (low == "match" and at(i + 1) == "(" and prev.lower() != "new")
                and not (low == "from" and prev.lower() == "yield"))):
            if not (prev.lower() in {"function", "const"} and not t.startswith("\\")):
                info.refs.append((ns, t, at(i + 1) == "(", uses))
        i += 1
    # String callables: the callback argument of a function that takes one
    # ('my_cb', or callback: 'my_cb'), and the class of a ['Cls', 'm'] /
    # array('Cls', 'm') pair. Other strings that only equal a name are not
    # references. A callback the source does not name ($cb, 'on_' . $x,
    # get_callback()), and $f(), are listed as dynamic.
    for k, (t, _) in enumerate(toks):
        if t.startswith("$") and at(k + 1) == "(" and at(k - 1) not in {"->", "?->", "::"} \
                and at(k - 1).lower() != "new":
            info.dynamic.append((f"{t}()", "function name computed at run time"))
        elif t.startswith(STR) and (at(k - 1) == "[" or (at(k - 1) == "(" and at(k - 2).lower() == "array")) \
                and at(k + 1) == "," and at(k + 2).startswith(STR) and at(k + 3) in {"]", ")"}:
            name = string(t).strip().lstrip("\\").replace("\\\\", "\\")
            if BARE_NAME_RE.fullmatch(name):
                info.callables.append(("class", name))
        func = t.lower().lstrip("\\")
        if at(k + 1) != "(" or at(k - 1) in {"->", "?->", "::"} or at(k - 1).lower() in {"function", "new"}:
            continue
        if func in CALLBACK_FUNCTIONS:
            positions, params, kind = CALLBACK_FUNCTIONS[func], (CALLBACK_PARAM,), "function"
        elif func in CLASS_NAME_FUNCTIONS:
            (positions, params), kind = CLASS_NAME_FUNCTIONS[func], "class"
        else:
            continue
        for position, arg in enumerate(call_arguments(toks, k + 1)):
            if len(arg) > 2 and NAME_RE.fullmatch(at(arg[0])) and at(arg[1]) == ":":
                if at(arg[0]).lower() not in params:     # callback: 'f' (PHP 8 named argument)
                    continue
                arg = arg[2:]
            elif position not in positions:
                continue
            first = at(arg[0])
            if len(arg) == 1 and first.startswith(STR):
                name = string(first).strip().lstrip("\\").replace("\\\\", "\\")
                if BARE_NAME_RE.fullmatch(name):
                    info.callables.append((kind, name))
            elif kind == "function" and not static_callable([at(j) for j in arg]):
                text = "".join(f"'{string(at(j))}'" if at(j).startswith(STR) else " . " if at(j) == "." else at(j)
                               for j in arg).replace(" .  .  . ", "...")
                text = text if len(text) <= 60 else text[:57] + "..."
                info.dynamic.append((f"{func}({text})", "callback computed at run time"))
    return info


def call_arguments(toks, open_at):
    """Token indices of each top-level argument of the call whose "(" is at
    open_at (empty when the call is not closed within 2000 tokens)."""
    args, current, level = [], [], 0
    for j in range(open_at + 1, min(len(toks), open_at + 2000)):
        tok = toks[j][0]
        if tok in {"(", "[", "{"}:
            level += 1
        elif tok in {")", "]", "}"}:
            if level == 0:
                return args + [current] if current else args
            level -= 1
        elif tok == "," and level == 0:
            args.append(current)
            current = []
            continue
        current.append(j)
    return []


def static_callable(arg):
    """Whether a callback argument names its target in the source or needs no
    file edge: a string ('Cls::m' strings are read as class names), a
    closure, a [$obj, 'm'] / ['Cls', 'm'] pair, or a first-class callable
    f(...) / Cls::m(...). Anything else ($cb, 'on_' . $x, get_cb()) is
    computed at run time."""
    if not arg:
        return True
    first = arg[0].lower()
    if len(arg) == 1 and arg[0].startswith(STR):
        return True
    if first in {"function", "fn", "static"} or first == "[" or (first == "array" and arg[1:2] == ["("]):
        return True
    return len(arg) >= 6 and arg[-5:] == ["(", ".", ".", ".", ")"]     # f(...)


def const_values_unique(values):
    """(constant, value) for constants every define() gives the same
    relative literal (define('WPINC', 'wp-includes')). An absolute path is a
    deployment's, not the repository's: it stays an unknown prefix."""
    for name, vals in values.items():
        value = next(iter(vals))
        if len(vals) == 1 and not re.match(r"^(?:[/\\]|[A-Za-z]:|\w+://)", value):
            yield name, value


def parse_vars(text):
    """--include-var NAME=VALUE,...: values of variables ($NAME) and constants
    (NAME) in include paths."""
    out = {}
    for item in (p for p in text.split(",") if p.strip()):
        name, sep, value = item.partition("=")
        if not sep or not name.strip():
            raise SystemExit(f"--include-var: expected NAME=VALUE, got {item!r}")
        out[name.strip().lstrip("$")] = value.strip()
    return out


CONST_PATH = "\x00path:"   # key in include variables: a constant whose define() names a file
INTERPOLATED_RE = re.compile(r"\$(\w+)")


def dirname_depth(toks, k):
    """(number of nested dirname calls at toks[k], index of the __FILE__ /
    __DIR__ they wrap), or (0, k)."""
    j = k
    while j < len(toks) and toks[j].lower() == "dirname":
        j += 1
    if j < len(toks) and toks[j].lower() in {"__file__", "__dir__"}:
        return j - k, j
    return 0, k


def resolve_include(src, parts, info, by_rel, by_tail, include_path=(), variables=None):
    """Edge targets for one include expression, or a reason it is dynamic.
    variables: known values of $variables and constants (--include-var, and
    constants every define() gives the same literal)."""
    variables = variables or {}
    bare = [p for p in parts if p not in {"(", ")"}]
    if len(bare) == 1 and isinstance(variables.get(CONST_PATH + bare[0]), list):
        return variables[CONST_PATH + bare[0]], None    # require_once(DO_MAINTENANCE)
    base, pieces, unknown_prefix = None, [], False
    k = 0
    toks = [p for p in parts if p not in {"(", ")"}]
    # require 'a.php' or die(...): only the path expression counts.
    stop = next((j for j, p in enumerate(toks) if p.lower() in {"or", "||"}), len(toks))
    toks = toks[:stop]
    while k < len(toks):
        t = toks[k]
        tl = t.lower()
        if t.startswith("$") and t[1:] in variables:
            pieces.append(variables[t[1:]])
        elif NAME_RE.fullmatch(t) and t in variables:
            pieces.append(variables[t])
        elif tl in {"directory_separator", "ds"}:
            pieces.append("/")      # DS is the usual define('DS', DIRECTORY_SEPARATOR)
        elif tl == "realpath":
            pass                    # realpath(x) names the same file as x
        elif t.startswith(STR):
            piece = info.strings[int(t[1:-1])]
            if "$" in piece and int(t[1:-1]) in info.interpolated:
                # "$IP/includes/x.php" with --include-var IP=... ('$IP' is text)
                piece = INTERPOLATED_RE.sub(lambda m: variables.get(m.group(1), m.group(0)), piece)
            if "$" in piece:
                return None, "include path computed at run time"
            pieces.append(piece)
        elif tl == "__dir__":
            base = posixpath.dirname(src)
        elif tl == "dirname" and dirname_depth(toks, k)[0]:
            # dirname(__FILE__) is the file's directory; dirname(__DIR__, 2)
            # climbs two levels from it, and so does dirname(dirname(__DIR__)).
            outer, k = dirname_depth(toks, k)
            base = src if toks[k].lower() == "__file__" else posixpath.dirname(src)
            levels = 1
            if k + 2 < len(toks) and toks[k + 1] == "," and toks[k + 2].isdigit():
                levels = int(toks[k + 2])
                k += 2
            for _ in range(levels + outer - 1):
                base = posixpath.dirname(base)
            k += 1
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
    if base is not None:
        # __DIR__ . '/x.php' names one path: a same-named file elsewhere is
        # another file, not the one included.
        return None, f"included file not found at {cand[0]}"
    # Last resort: the path without its leading /, ./ and ../ parts.
    tail = posixpath.normpath(path)
    while tail.startswith(("/", "./", "../")):
        tail = tail.split("/", 1)[1] if "/" in tail else ""
    hits = by_tail.get(tail.lower(), [])
    if len(hits) == 1:
        return hits, None
    if len(hits) > 1:
        return None, f"include path matches {len(hits)} files"
    return None, "included file not found under --root"


def mapper(root, warnings, args):
    files = find_files(root, EXTS | PHP_IF_TAGGED, SKIP_DIRS, MARKERS, warnings)
    rels, infos = [], []
    for path in files:
        rel = path.relative_to(root).as_posix()
        if path.suffix.lower() in PHP_IF_TAGGED:
            try:
                if b"<?php" not in path.read_bytes().lower():
                    continue
            except OSError as e:
                warnings.append(f"not read: {rel}: {e.strerror}")
                continue
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
    fallback = {"class": {}, "function": {}, "const": {}}   # key -> files with a guarded declaration
    for info in infos:
        for c in info.classes:
            declared.setdefault(c.lower(), set()).add(info.rel)
            if ("class", c.lower()) in info.guarded:
                fallback["class"].setdefault(c.lower(), set()).add(info.rel)
        for f in info.functions:
            functions.setdefault(f.lower(), set()).add(info.rel)
            if ("function", f.lower()) in info.guarded:
                fallback["function"].setdefault(f.lower(), set()).add(info.rel)
        for c in info.constants:
            constants.setdefault(c, set()).add(info.rel)
            if ("const", c) in info.guarded:
                fallback["const"].setdefault(c, set()).add(info.rel)
    # A declaration behind !function_exists('f') (a polyfill, a theme's
    # back-compat copy) is used only where no unguarded one exists: a call
    # of f means the real f, and linking every fallback gives false cycles.
    for kind, table in (("class", declared), ("function", functions), ("const", constants)):
        for key, files in fallback[kind].items():
            real = table[key] - files
            if real:
                table[key] = real
    const_values = {}
    for info in infos:
        for name, value in info.const_values.items():
            const_values.setdefault(name, set()).add(value)
    include_vars = dict(const_values_unique(const_values))
    include_vars.update(parse_vars(args.include_var))
    # A constant defined as a computable path (define('DO_MAINTENANCE',
    # dirname(__FILE__) . '/doMaintenance.php')) names that file wherever
    # it is included, if every define() of it names the same one.
    # A literal define() of the same name elsewhere makes it ambiguous.
    const_paths = {name: {None} for name in const_values}
    for info in infos:
        for name, value in info.const_exprs.items():
            hit, why = resolve_include(info.rel, value, info, by_rel, by_tail, include_path, include_vars)
            const_paths.setdefault(name, set()).add(tuple(hit) if hit and not why and len(hit) == 1 else None)
    for name, hits in const_paths.items():
        if len(hits) == 1 and None not in hits:
            include_vars[CONST_PATH + name] = list(next(iter(hits)))

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

    # Namespaces some file declares something in (with their parents).
    namespaces = set()
    for name in list(declared) + list(functions) + [c.lower() for c in constants]:
        parts = name.split("\\")[:-1]
        namespaces.update("\\".join(parts[:k]) for k in range(1, len(parts) + 1))
    external = {}       # namespace no file declares -> files that name a class in it

    included = {info.rel: [] for info in infos}     # rel -> [(keyword, parts, hit, why)]
    for info in infos:
        for keyword, parts in info.includes:
            hit, why = resolve_include(info.rel, parts, info, by_rel, by_tail, include_path, include_vars)
            included[info.rel].append((keyword, parts, hit, why))
    include_deps = {rel: {t for _, _, hit, _ in rows for t in hit or ()} for rel, rows in included.items()}
    closures = {}

    edges, unresolved = set(), set()
    for info in infos:
        src = info.rel

        def add(targets):
            """A function, class or constant reference. The file's own
            declaration wins; of several declarations, the ones the file's
            includes reach win (a define() copied into a develop/ script is
            not where index.php gets ANONYMOUS); otherwise all count."""
            targets = set(targets)
            if src in targets:
                return
            if len(targets) > 1:
                if src not in closures:
                    closures[src] = reachable(src, include_deps)
                targets = (targets & closures[src]) or targets
            for t in targets:
                edges.add((src, t))

        for keyword, parts, hit, why in included[src]:
            for t in hit or ():
                if t != src:
                    edges.add((src, t))
            if why:     # unresolved, or resolved to several candidates
                expr = " ".join("'" + info.strings[int(p[1:-1])] + "'" if p.startswith(STR) else p for p in parts)
                unresolved.add((src, f"{keyword} {expr}", why))
        for ns, name, is_call, uses in info.refs:
            if name.startswith("\\"):
                full = name[1:]
                hits = classes(full.lower()) | functions.get(full.lower(), set()) | constants.get(full, set())
                add(hits)
                ns_name = full.rpartition("\\")[0]
                if not hits and ns_name and ns_name.lower() not in namespaces:
                    external.setdefault(ns_name, set()).add(src)
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
    # A namespace no file declares is an external library (vendor/ is not
    # read). One row per library, so an in-house one left outside --root
    # does not go unnoticed.
    tops = {}
    for name, files in external.items():
        top = name.split("\\")[0]
        tops.setdefault(top, (set(), set()))[0].add(name)
        tops[top][1].update(files)
    for top, (names, files) in sorted(tops.items()):
        name = next(iter(names)) if len(names) == 1 else top
        files = sorted(files)
        unresolved.add((files[0], name, EXTERNAL + str(len(files))))
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
        [("--include-path", "comma-separated directories (relative to --root) PHP's include_path lists"),
         ("--include-var", "comma-separated NAME=VALUE pairs: values of $NAME variables and NAME constants "
                           "in include paths (a directory relative to --root, an extension...)")])
