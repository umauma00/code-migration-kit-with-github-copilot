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

import itertools
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
    # name: ((position, parameter name for a PHP 8 named argument), ...);
    # a negative position counts from the end (array_udiff($a, $b, 'cmp')
    # takes any number of arrays, so it has no named form).
    **dict.fromkeys("""array_map call_user_func call_user_func_array forward_static_call
forward_static_call_array register_shutdown_function register_tick_function spl_autoload_register
set_error_handler set_exception_handler ob_start header_register_callback""".split(), ((0, "callback"),)),
    **dict.fromkeys("""array_filter array_walk array_walk_recursive array_reduce usort uasort uksort
iterator_apply preg_replace_callback mb_ereg_replace_callback mb_eregi_replace_callback
xml_set_character_data_handler xml_set_default_handler xml_set_processing_instruction_handler
xml_set_unparsed_entity_decl_handler xml_set_notation_decl_handler xml_set_external_entity_ref_handler
xml_set_start_namespace_decl_handler xml_set_end_namespace_decl_handler add_action add_filter add_shortcode register_activation_hook
register_deactivation_hook register_uninstall_hook""".split(), ((1, "callback"),)),
    **dict.fromkeys("""array_udiff array_udiff_assoc array_uintersect array_uintersect_assoc
array_diff_ukey array_diff_uassoc array_intersect_ukey array_intersect_uassoc""".split(), ((-1, None),)),
    "xml_set_element_handler": ((1, "start_handler"), (2, "end_handler")),
    "array_udiff_uassoc": ((-1, None), (-2, None)), "array_uintersect_uassoc": ((-1, None), (-2, None)),
    # The nine handlers; the other form takes a handler object (and a bool).
    "session_set_save_handler": tuple(enumerate(
        "open close read write destroy gc create_sid validate_sid update_timestamp".split())),
}
# Arguments whose array values are callbacks: preg_replace_callback_array(['/x/' => 'cb']).
CALLBACK_ARRAYS = {"preg_replace_callback_array": (0, "pattern")}
# Functions whose string arguments name a class: positions and parameter names.
CLASS_NAME_FUNCTIONS = {"is_subclass_of": ((0, "object_or_class"), (1, "class")),
                        "is_a": ((0, "object_or_class"), (1, "class")),
                        "stream_wrapper_register": ((1, "class"),), "stream_register_wrapper": ((1, "class"),)}
# Classes whose constructor takes a class name (new ReflectionClass('Cls'),
# new ReflectionMethod('Cls::m')).
CLASS_NAME_CONSTRUCTORS = {"reflectionclass": ((0, "objectorclass"),), "reflectionenum": ((0, "objectorclass"),),
                           "reflectionmethod": ((0, "objectormethod"),), "reflectionproperty": ((0, "class"),),
                           "reflectionclassconstant": ((0, "class"),)}
# These lists are closed: a callback or class name passed to any other
# function is not read (see docs/DEPENDENCY-MAPPERS.md).
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
# Top namespaces of PHP's own classes (Random\Randomizer, Dom\HTMLDocument,
# Pdo\Sqlite, BcMath\Number, Uri\Rfc3986\Uri) and common extensions: never
# listed in external.tsv.
PHP_STANDARD = {"random", "dom", "pdo", "bcmath", "uri", "ffi", "ds", "parallel"}
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


def interpolates(body):
    """Whether the body of a "..." string or heredoc holds a variable or a
    {$...} hole (an escaped \\$ is text)."""
    i, n = 0, len(body)
    while i < n:
        if body[i] == "\\":
            i += 2
            continue
        if body[i] == "$" and i + 1 < n and (body[i + 1] == "{" or body[i + 1] == "_" or body[i + 1].isalpha()):
            return True
        if body.startswith("{$", i):
            return True
        i += 1
    return False


def php_code(text):
    """Code between PHP open and close tags, comments removed and each string
    replaced by a placeholder. Returns (code, strings, interpolated): the
    indexes of the "..." strings and heredocs that hold a variable or a hole.
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
            if c == '"' and interpolates(text[i + 1:j]):
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
                if m.group(1) != "'" and interpolates(body):
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
        self.interpolated = set()   # indexes of strings that hold a variable or {$...} hole
        self.callables = []     # names in string callables: ("function" | "class", name)
        self.dynamic = []
        self.guarded = set()    # ("function" | "class" | "const", key) behind a !function_exists(...) guard
        self.const_values = {}  # constant -> literal values of its define('X', 'v') calls
        self.const_exprs = {}   # constant -> value tokens of each define('X', <expr>)


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
        elif low == "namespace" and prev not in {"\\"} and not at(i + 1).startswith("\\") \
                and (NAME_RE.fullmatch(at(i + 1)) or at(i + 1) == "{"):
            # namespace\f() is a name relative to the current namespace, not a declaration.
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
            # const A = 1, B = 2; declares every name of the list.
            info.constants.append(f"{ns}\\{at(i + 1)}".lstrip("\\"))
            j, level = i + 2, 0
            while j < n and at(j) != ";" and not (level == 0 and at(j) in {"{", "}"}):
                level += {"(": 1, "[": 1, ")": -1, "]": -1}.get(at(j), 0)
                if level == 0 and at(j) == "," and NAME_RE.fullmatch(at(j + 1)) and at(j + 2) == "=":
                    info.constants.append(f"{ns}\\{at(j + 1)}".lstrip("\\"))
                j += 1
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
        elif low.lstrip("\\") == "define" and at(i + 1) == "(" and at(i + 2).startswith(STR) \
                and prev not in {"->", "?->", "::", "function"}:
            # define('X', ...) and \define('X', ...) alike.
            info.constants.append(string(at(i + 2)).lstrip("\\"))
            if at(i + 3) == "," and at(i + 4).startswith(STR) and at(i + 5) == ")":
                # Every define() of the file counts: if/else branches may
                # give the same constant different values.
                info.const_values.setdefault(string(at(i + 2)).lstrip("\\"), set()).add(string(at(i + 4)))
            elif at(i + 3) == ",":
                # define('X', dirname(__FILE__) . '/x.php'): an include of X
                # is that path, resolved in this file.
                j, level, value = i + 4, 0, []
                while j < n and not (level == 0 and at(j) in {")", ","}):
                    level += {"(": 1, ")": -1}.get(at(j), 0)
                    value.append(at(j))
                    j += 1
                info.const_exprs.setdefault(string(at(i + 2)).lstrip("\\"), []).append(value)
        elif t == "!" and GUARDS.get(at(i + 1).lower().lstrip("\\")) and at(i + 2) == "(" \
                and at(i + 3).startswith(STR) and at(i + 4) in {")", ","}:
            # if (!function_exists('f')) { function f() ... }: a fallback
            # for a declaration that may exist elsewhere.
            kind = GUARDS[at(i + 1).lower().lstrip("\\")]
            name = string(at(i + 3)).strip().lstrip("\\").replace("\\\\", "\\")
            info.guarded.add((kind, name if kind == "const" else name.lower()))
        elif low in {"include", "include_once", "require", "require_once"}:
            # The path expression ends at the ; or at the bracket, comma or
            # brace that closes what holds it: if (!include_once('a.php')) {
            # f(); } leaves f() to be read as code, and so does the right side
            # of include 'a.php' or fallback().
            j, parts, level = i + 1, [], 0
            while j < n:
                tok = at(j)
                if tok in {"(", "["}:
                    level += 1
                elif tok in {")", "]"}:
                    if level == 0:
                        break
                    level -= 1
                elif tok == ";" or (level == 0 and (tok in {",", "{", "}", "=", "!", "<", ">", "?", ":", "&", "|"}
                                                    or tok.lower() in {"and", "or", "xor"})):
                    break
                parts.append(tok)
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
    # references. A callback the source does not name ($cb, "on_$x",
    # 'on_' . $x, get_callback(), [$class, 'm']), and $f(), are listed as
    # dynamic.
    texts = [t for t, _ in toks]
    for k, t in enumerate(texts):
        if t.startswith("$") and at(k + 1) == "(" and at(k - 1) not in {"->", "?->", "::"} \
                and at(k - 1).lower() != "new":
            info.dynamic.append((f"{t}()", "function name computed at run time"))
        elif t.startswith(STR) and (at(k - 1) == "[" or (at(k - 1) == "(" and at(k - 2).lower() == "array")) \
                and at(k + 1) == "," and at(k + 2).startswith(STR) and at(k + 3) in {"]", ")"}:
            # Anywhere: a ['Cls', 'm'] pair stored for later. In a callback
            # argument callable_targets also reads ['Cls', 'm',] (a two-string
            # list with a trailing comma elsewhere is usually data).
            name = string(t).strip().lstrip("\\").replace("\\\\", "\\")
            if BARE_NAME_RE.fullmatch(name):
                info.callables.append(("class", name))
        func = t.lower().lstrip("\\")
        if at(k + 1) != "(" or at(k - 1) in {"->", "?->", "::"} or at(k - 1).lower() == "function":
            continue
        if at(k - 1).lower() == "new":
            if func not in CLASS_NAME_CONSTRUCTORS:
                continue
            slots, kind = CLASS_NAME_CONSTRUCTORS[func], "class"
        elif func in CALLBACK_FUNCTIONS:
            slots, kind = CALLBACK_FUNCTIONS[func], "function"
        elif func in CALLBACK_ARRAYS:
            slots, kind = (CALLBACK_ARRAYS[func],), "function"
        elif func in CLASS_NAME_FUNCTIONS:
            slots, kind = CLASS_NAME_FUNCTIONS[func], "class"
        else:
            continue
        args = call_arguments(texts, k + 1)
        if [[at(j) for j in arg] for arg in args] == [[".", ".", "."]]:
            continue            # call_user_func(...): a closure of the function itself
        if func == "session_set_save_handler" and len(args) <= 2:
            slots = ((0, "sessionhandler"),)    # session_set_save_handler($handler, true)
        candidates = []
        for position, arg in enumerate(args):
            if len(arg) > 2 and NAME_RE.fullmatch(at(arg[0])) and at(arg[1]) == ":":
                if at(arg[0]).lower() not in {name for _, name in slots}:   # callback: 'f'
                    continue
                arg = arg[2:]
            elif not any(position == p or position - len(args) == p for p, _ in slots):
                continue
            if func in CALLBACK_ARRAYS:
                # Each value of a pattern => callback array.
                if not arg or at(arg[0]).lower() not in {"[", "array"}:
                    candidates.append(arg)
                    continue
                opener = arg[0] if at(arg[0]) == "[" else arg[1]
                for element in call_arguments(texts, opener):
                    arrow = next((n for n in range(len(element) - 1)
                                  if at(element[n]) == "=" and at(element[n + 1]) == ">"), None)
                    candidates.append(element[arrow + 2:] if arrow is not None else element)
                continue
            candidates.append(arg)
        for arg in candidates:
            if not arg:
                continue
            first = at(arg[0])
            if kind == "class":
                if len(arg) == 1 and first.startswith(STR) and int(first[1:-1]) not in info.interpolated:
                    name = string(first).strip().lstrip("\\").replace("\\\\", "\\").split("::")[0]
                    if BARE_NAME_RE.fullmatch(name):
                        info.callables.append(("class", name))
                continue
            targets = callable_targets(texts, arg, info.interpolated, string)
            if targets is not None:
                info.callables.extend(targets)
                continue
            if first.startswith(STR) and int(first[1:-1]) in info.interpolated:
                text = '"' + " ".join(string(first).split()) + '"'     # its hole code follows
            else:
                text = ""
                for j in arg:
                    piece = f"'{string(at(j))}'" if at(j).startswith(STR) else " . " if at(j) == "." else at(j)
                    if text and (text[-1].isalnum() or text[-1] == "_") and (piece[0].isalnum() or piece[0] in "_$"):
                        text += " "         # new Cls(), not newCls()
                    text += piece
                text = text.replace(" .  .  . ", "...")
            text = text if len(text) <= 60 else text[:57] + "..."
            info.dynamic.append((f"{func}({text})", "callback computed at run time"))
    return info


def call_arguments(texts, open_at):
    """Token indices of each top-level argument of the call (or array) whose
    "(" or "[" is at open_at. An argument list the file does not close keeps
    the arguments read so far."""
    args, current, level = [], [], 0
    for j in range(open_at + 1, len(texts)):
        tok = texts[j]
        if tok in {"(", "[", "{"}:
            level += 1
        elif tok in {")", "]", "}"}:
            if level == 0:
                break
            level -= 1
        elif tok == "," and level == 0:
            args.append(current)
            current = []
            continue
        elif tok == ";" and level == 0:
            break               # never inside an argument list: the call is not closed
        current.append(j)
    return args + [current] if current else args


SELF_NAMES = {"self", "static", "parent"}


def callable_targets(texts, arg, interpolated, string):
    """What a callback argument (token indices) names: a list of ("function"
    | "class", name) to link (empty when the target needs no edge or the
    rest of the code names it), or None when it is computed at run time.

    Static: a plain string ('f'; 'Cls::m' strings are read as class names
    elsewhere), null, a closure, a first-class callable f(...) /
    Cls::m(...), an invokable new Cls, and a pair whose class is fixed:
    ['Cls', 'm'], ['Cls', $method], [Cls::class, 'm'], [$this, 'm'],
    array(&$this, 'm'), [__CLASS__, 'm'], [self::class, 'm'], [new Cls, 'm'],
    with or without a trailing comma. Anything else ($cb, "on_$x",
    'on_' . $x, get_cb(), [$class, 'm']) is computed at run time."""
    toks = [texts[j] for j in arg]
    if not toks:
        return []

    def plain(tok):     # the name in a string without variables, or None
        if not tok.startswith(STR) or int(tok[1:-1]) in interpolated:
            return None
        return string(tok).strip().lstrip("\\").replace("\\\\", "\\")

    first = toks[0].lower()
    if len(toks) == 1:
        if toks[0].startswith(STR):
            name = plain(toks[0])
            if name is None:
                return None
            return [("function", name)] if BARE_NAME_RE.fullmatch(name) else []
        return [] if first in {"null", "false"} else None
    if first in {"function", "fn"} or first == "static" and toks[1].lower() in {"function", "fn"}:
        return []
    if len(toks) >= 6 and toks[-5:] == ["(", ".", ".", ".", ")"]:      # f(...)
        return []
    if first == "new" and NAME_RE.fullmatch(toks[1]) and toks[1].lower() != "class":
        return []               # an invokable object: new Foo names Foo
    opener = 0 if first == "[" else 1 if first == "array" and toks[1] == "(" else None
    if opener is None:
        return None
    elements = call_arguments(texts, arg[opener])
    if len(elements) != 2 or not elements[0]:
        return None
    head = [texts[j] for j in elements[0]]
    if head in (["$this"], ["&", "$this"]) or len(head) == 1 and head[0].upper() == "__CLASS__":     # its own class (&$this in PHP 4 code)
        return []
    if head[0].lower() == "new" and len(head) > 1 and NAME_RE.fullmatch(head[1]) and head[1].lower() != "class":
        return []               # [new Foo, 'm']: Foo is written
    if len(head) == 1 and head[0].startswith(STR):
        name = plain(head[0])
        if name is None:
            return None
        return [("class", name)] if BARE_NAME_RE.fullmatch(name) else []
    if len(head) == 3 and head[1] == "::" and head[2].lower() == "class" and NAME_RE.fullmatch(head[0]):
        return []               # Cls::class is a reference of its own
    return None


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
        for name, values in info.const_values.items():
            const_values.setdefault(name, set()).update(values)
    include_vars = dict(const_values_unique(const_values))
    include_vars.update(parse_vars(args.include_var))
    # A constant defined as a computable path (define('DO_MAINTENANCE',
    # dirname(__FILE__) . '/doMaintenance.php')) names that file wherever
    # it is included, if every define() of it names the same one.
    # A literal define() of the same name elsewhere makes it ambiguous.
    const_paths = {name: {None} for name in const_values}
    for info in infos:
        for name, exprs in info.const_exprs.items():
            for value in exprs:
                hit, why = resolve_include(info.rel, value, info, by_rel, by_tail, include_path, include_vars)
                const_paths.setdefault(name, set()).add(tuple(hit) if hit and not why and len(hit) == 1 else None)
    for name, hits in const_paths.items():
        if len(hits) == 1 and None not in hits:
            include_vars[CONST_PATH + name] = list(next(iter(hits)))
    # A constant whose define() calls give it several relative literals
    # (if ($env) define('BASE', 'a'); else define('BASE', 'b');), or several
    # computable paths, may be any of them: an include through it gets an
    # edge to each, and stays listed.
    # A define() whose value is not a literal (define('BASE', $dir)) may give
    # any value: such a constant keeps the include unresolved as before.
    computed = {name for info in infos for name in info.const_exprs}
    choices = {name: [("var", v) for v in sorted(vals)] for name, vals in const_values.items()
               if 1 < len(vals) <= 8 and name not in include_vars and name not in computed
               and not any(re.match(r"^(?:[/\\]|[A-Za-z]:|\w+://)", v) for v in vals)}
    for name, hits in const_paths.items():
        paths = [h for h in hits if h is not None]
        if len(paths) > 1 and None not in hits and CONST_PATH + name not in include_vars and name not in choices:
            choices[name] = [("path", list(h)) for h in sorted(paths)]

    def resolve_choices(info, parts):
        """Files an include through constants with several values reaches,
        over every combination of their values (None if none applies)."""
        names = sorted({p for p in parts if p in choices})
        if not names or len(names) > 3:
            return None
        found = set()
        for combo in itertools.product(*(choices[n] for n in names)):
            variables = dict(include_vars)
            for n, (kind, v) in zip(names, combo):
                variables[n if kind == "var" else CONST_PATH + n] = v
            hit, why = resolve_include(info.rel, parts, info, by_rel, by_tail, include_path, variables)
            if hit and not why:
                found.update(hit)
        if not found:
            return None
        return sorted(found), f"{', '.join(names)} has several define() values; an edge to each file they name"

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
            if why:
                hit, why = resolve_choices(info, parts) or (hit, why)
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
        def outside(full):
            """full names nothing the repository declares: its namespace
            (if not declared either, nor the platform's) is external."""
            ns_name = full.rpartition("\\")[0]
            if ns_name and ns_name.lower() not in namespaces \
                    and ns_name.split("\\")[0].lower() not in PHP_STANDARD:
                external.setdefault(ns_name.lower(), (ns_name, set()))[1].add(src)

        used, unused = set(), []     # use targets code names; use targets that resolve to nothing
        for ns, name, is_call, uses in info.refs:
            if name.startswith("\\"):
                full = name[1:]
                hits = classes(full.lower()) | functions.get(full.lower(), set()) | constants.get(full, set())
                add(hits)
                # A use statement may import a namespace (use Acme\Billing;)
                # or a class: the names written with it tell (below). One
                # no code uses (a docblock's @var) is taken as a class.
                if not hits:
                    if uses is None:
                        unused.append(full)
                    else:
                        outside(full)
                continue
            head, _, rest = name.partition("\\")
            uses = uses or {"class": {}, "function": {}, "const": {}}
            imported = head.lower() in uses["class"]
            if head.lower() == "namespace" and rest:
                # namespace\f(): the current namespace's f, never an import
                # or the global fallback.
                full = f"{ns}\\{rest}".lstrip("\\")
                found = [classes(full.lower()), functions.get(full.lower(), ()), constants.get(full, ())]
                for hits in found:
                    add(hits)
                if not any(found):      # as \App\Billing\Invoice would be
                    outside(full)
                continue
            if imported:
                used.add(uses["class"][head.lower()])
                full = uses["class"][head.lower()] + ("\\" + rest if rest else "")
            else:
                full = f"{ns}\\{name}".lstrip("\\")
            found = [classes(full.lower())]
            if not rest:
                fn = uses["function"].get(name.lower())
                cn = uses["const"].get(name)
                # An imported function or constant is that one only; an
                # unqualified name falls back to the global one.
                found += [functions.get(fn.lower(), ()) if fn else
                          functions.get(full.lower(), ()) or functions.get(name.lower(), ()),
                          constants.get(cn, ()) if cn else constants.get(full, ()) or constants.get(name, ())]
                used.update(n for n in (fn, cn) if n)
                if not any(found) and (fn or cn):
                    outside(fn or cn)
            else:
                found += [functions.get(full.lower(), ()), constants.get(full, ())]
            for hits in found:      # each kind on its own: the file's own declaration wins per kind
                add(hits)
            hits = any(found)
            # A qualified or imported name (Acme\Billing\Invoice, or Invoice
            # after use Acme\Billing\Invoice) that resolves to nothing; an
            # unqualified one may be a global built-in.
            if not hits and (rest or imported):
                outside(full)
        for full in unused:
            if full not in used:
                outside(full)
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
    # read): one row per namespace, a child folded into a listed parent
    # (Acme\Billing\Model into Acme\Billing), siblings apart, so an in-house
    # one left outside --root does not go unnoticed.
    # Namespaces are case-insensitive: keyed lower-case, shown as first written.
    for key, (_, files) in external.items():
        segs = key.split("\\")
        top = next(("\\".join(segs[:k]) for k in range(1, len(segs)) if "\\".join(segs[:k]) in external), None)
        if top:
            external[top][1].update(files)
    for key, (name, files) in sorted(external.items()):
        segs = key.split("\\")
        if any("\\".join(segs[:k]) in external for k in range(1, len(segs))):
            continue
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
