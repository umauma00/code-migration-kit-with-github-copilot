#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Deterministic dependency mapper for Java codebases (stdlib only).

Implements the kit's dependency-map contract (prompts/01-dependency-map.md) by
reading .java files as text. It never builds or runs the project.

Code in one package uses the package's other types without an import, so
edges come from type names (scripts/depmap_typed.py): each file's package and
declared types (class, interface, enum, record, @interface) form a table, and
every name a file's code mentions is resolved through its own package,
single-type imports, on-demand imports (pkg.*, Outer.*), static imports and
fully qualified names. String literals equal to a declared type's full name
(Class.forName("a.B")) count too.

Types used without their name being written are followed through declared
types (scripts/depmap_typed.py, type flow): `var x = f(); x.m().n()` reaches
f's return type, m's and n's, through members inherited from superclasses
and interfaces too; parameters, typed locals and for-each variables count,
and an element type (List<Order>) passes through get() and stream calls.

Maven (pom.xml) and Gradle (build.gradle[.kts]) modules are read as text: a
type declared in several modules only gives edges into the modules the
file's module depends on (a sibling artifactId, project(':a')), transitively.

Known limits, listed in unresolved.tsv where the source shows them:
  - lambda parameters, generic method type inference and overload
    resolution are not followed. Audit these with the sample/diff CLI.
  - a local variable with a type's name gives an extra edge (conservative).
  - an import of a type the repository's own package does not declare, and
    reflection with a computed name (Class.forName(x)), are unresolved.
  - wiring outside Java source (Spring XML, ServiceLoader files, JSP) is not
    read; add those edges as semantic evidence.

Skipped directories: target, build and out at --root or beside pom.xml,
build.gradle(.kts) or build.xml (a package named build or out is still
walked), plus node_modules, __pycache__ and every directory starting with
".". Each skipped directory holding .java files is printed as a warning.

Usage:
  python3 depmap_java.py --root path/to/repo --out path/to/migration/depmap
Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)
and unresolved.tsv (file, reference, reason).

Test: python3 scripts/depmap_java.py --root fixtures/java --out /tmp/depmap-java && diff /tmp/depmap-java/edges.tsv fixtures/java/expected_edges.tsv
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, read_source, run  # noqa: E402
from depmap_projects import java_modules  # noqa: E402
from depmap_typed import CHAIN_RE, JAVA_STANDARD, FileInfo, TOKEN_RE, chains_at, enum_member_offsets, flow_c_like, join, resolve, scan_or_none, strip_c_like, type_written_at  # noqa: E402

EXTS = {".java"}
SKIP_DIRS = {"target", "build", "out"}
MARKERS = {"pom.xml", "build.gradle", "build.gradle.kts", "build.xml"}  # SKIP_DIRS count only beside these (or at --root)
KEYWORDS = set("""abstract assert boolean break byte case catch char class const continue default do
double else enum extends final finally float for goto if implements import instanceof int interface
long native new package private protected public return short static strictfp super switch
synchronized this throw throws transient try void volatile while var record sealed permits
non-sealed yield true false null""".split())
# At a line start or after a ";" (package a; import b.C; on one line).
PACKAGE_RE = re.compile(r"(?:^|(?<=;))\s*package\s+([\w.\s]+?)\s*;", re.MULTILINE)
IMPORT_RE = re.compile(r"(?:^|(?<=;))\s*import\s+(static\s+)?([\w.\s]+?)(\s*\.\s*\*)?\s*;", re.MULTILINE)
# Words after which a name is a value or a type, not a declared name.
VALUE_WORDS = {"return", "new", "throw", "case", "else", "instanceof", "yield", "assert", "extends",
               "implements", "throws", "permits", "import", "package", "default"}
# Words and marks before a name that make it a type (new a.b.C(), @a.b.Ann).
TYPE_BEFORE = {"new", "extends", "implements", "throws", "instanceof", "@"}
PRIMITIVES = {"boolean", "byte", "char", "short", "int", "long", "float", "double", "void", "var"}


def declared_name_at(code, start, end, name):
    """Whether the name at code[start:end] is the name a field, method,
    variable or parameter declaration introduces (int Customer;, void
    Order() {, List<X> items =): a simple name right after a type and before
    ; = ( , or ). It is not a reference to a type of that name."""
    if "." in name:
        return False
    k = end
    while k < len(code) and code[k].isspace():
        k += 1
    if k >= len(code) or code[k] not in ";=(,)":
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
    if code[k] == ">":
        return k > 0 and not code[k - 1].isspace() and code[k - 1] != "-"    # List<X> Foo, not a > Foo or ->
    j = k
    while j >= 0 and (code[j].isalnum() or code[j] in "_$"):
        j -= 1
    word = code[j + 1:k + 1]
    if not word or word[0].isdigit() or (j >= 0 and code[j] == "@"):
        return False        # @Ann Foo(...): an annotation, not a type before a name
    return word not in VALUE_WORDS and (word in PRIMITIVES or word not in KEYWORDS)


REFLECTION_RE = re.compile(r"\bClass\s*\.\s*forName\s*\(\s*((?:[^()]|\([^()]*\))+?)?\s*\)")


def scan(rel, text):
    info = FileInfo(rel)
    code, info.strings = strip_c_like(text)
    m = PACKAGE_RE.search(code)
    package = "".join(m.group(1).split()) if m else ""
    info.namespaces.add(package)
    for m in IMPORT_RE.finditer(code):
        static, name, star = m.group(1), "".join(m.group(2).split()), m.group(3)
        if star:
            info.usings.add(name)        # a package, or a type's members
        elif static:
            info.direct.add(name.rpartition(".")[0])   # import static a.B.m -> a.B
        else:
            info.direct.add(name)
    body = IMPORT_RE.sub(lambda m: " " * len(m.group(0)), PACKAGE_RE.sub(lambda m: " " * len(m.group(0)), code))
    toks = TOKEN_RE.findall(body)
    depth, type_depths, pending = 0, [], None      # type_depths: (depth inside its body, name) of each enclosing type
    for i, t in enumerate(toks):
        prev = toks[i - 1] if i else ";"
        if t == "{":
            depth += 1
            if pending:
                type_depths.append((depth, pending))
                pending = None
        elif t == "}":
            if type_depths and type_depths[-1][0] == depth:
                type_depths.pop()
            depth -= 1
        elif t in {"class", "interface", "@interface", "enum", "record"} and prev != "." and i + 1 < len(toks):
            name = toks[i + 1]
            if name not in KEYWORDS and (name[0].isalpha() or name[0] in "_$"):
                if t == "record" and (i + 2 >= len(toks) or toks[i + 2] not in {"(", "<"}):
                    continue  # "record" used as an identifier
                info.decls.append((package, name))
                if type_depths:     # nested (Outer.DescriptorImpl): not a copy of a same-named type
                    info.nested[join(package, name)] = join(package, ".".join(n for _, n in type_depths) + "." + name)
                pending = name
    enum_members = enum_member_offsets([(m.group(0), m.start(), m.end()) for m in TOKEN_RE.finditer(body)])
    for pos, name in chains_at(body, KEYWORDS):
        end = CHAIN_RE.match(body, pos).end()
        if pos in enum_members or declared_name_at(body, pos, end, name):
            continue
        info.names.append((package, name))
        if "." in name and type_written_at(body, pos, end, TYPE_BEFORE, KEYWORDS):
            info.type_chains.append((package, name))
    info.type_members, info.type_bases, info.flow, info.type_ns = flow_c_like(toks, KEYWORDS, "java", package)
    for m in REFLECTION_RE.finditer(body):
        arg = (m.group(1) or "").strip()
        if not arg.startswith('""'):
            info.dynamic.append((f"Class.forName({arg})", "reflection with a computed class name"))
    return info


def mapper(root, warnings, args):
    files = find_files(root, EXTS, SKIP_DIRS, MARKERS, warnings)
    rels, infos, deep = [], [], set()
    for path in files:
        rel = path.relative_to(root).as_posix()
        infos.append(scan_or_none(scan, rel, read_source(path, warnings), deep) or FileInfo(rel))
        rels.append(rel)
    edges, unresolved = resolve(infos, nested_lookup=False, visible_files=java_modules(root, rels, warnings),
                                 standard=JAVA_STANDARD)
    return rels, edges, unresolved | deep


if __name__ == "__main__":
    run("Map file dependencies of a Java codebase from its source text.", mapper)
