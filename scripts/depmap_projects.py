# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Build-file facts the C#, VB.NET and Java mappers use (stdlib only).

The files are read as text, never evaluated: MSBuild properties, imports,
conditions and imports that use a property are not expanded (the nearest
Directory.Build.props/.targets and imports by a path under --root are read
with the project), and Maven/Gradle are not run. What they give:

  - which project or module each source file belongs to (the deepest
    directory above it holding a .csproj/.vbproj, pom.xml or build.gradle);
  - which projects each one references (ProjectReference, a Maven dependency
    on a sibling module's groupId:artifactId, Gradle project(':a:b')), transitively;
  - .NET files a project does not compile (<Compile Remove>, or an old-style
    project that lists its <Compile Include> files and leaves the file out).
    Include and Remove are item lists ("a.cs;b.cs"); * and ? stay within one
    directory, ** spans any depth; attributes take either quote. An item under a
    Condition (on the item, its ItemGroup, or inside <Choose>) is not
    evaluated: a file only such an item leaves out keeps its declarations and
    is reported as depending on an unevaluated condition.

A name that matches types in several projects then only gives edges into the
projects the file's own project can see. A project that sees none of the
candidates keeps them all.
"""

import bisect
import posixpath
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, nearest, reachable, read_source  # noqa: E402

QUOTED = r"""(?:"([^"]*)"|'([^']*)')"""     # an XML attribute value, either quote
# Attributes of a tag; a quoted value may hold ">" (Condition="'$(A)' >= '1'").
# A value never holds a raw "<" (XML requires &lt;), which keeps a broken
# quote from running on through the rest of the file.
ATTRS = r"""((?:[^<>"']|"[^"<]*"|'[^'<]*')*?)"""
# Update only changes metadata of items already listed, so it is not read.
ITEM_ATTR_RE = re.compile(r"\b(Include|Remove|Exclude|Condition)\s*=\s*" + QUOTED, re.IGNORECASE)
# Start tags this module reads; one that ATTRS cannot read to its ">" is
# malformed (a raw "<" in a value): warned about, since its items are lost.
READ_TAG_RE = re.compile(r"<(?:ItemGroup|Choose|When|Otherwise|Target|Compile|ProjectReference|Using|Import)\b", re.IGNORECASE)
WHOLE_TAG_RE = re.compile(r"<[\w.:-]+" + ATTRS + r"/?>")


def malformed_lines(text):
    """Line numbers of start tags this module reads that do not parse."""
    text = COMMENT_RE.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    starts = [m.start() for m in READ_TAG_RE.finditer(text) if not WHOLE_TAG_RE.match(text, m.start())]
    newlines = [i for i, c in enumerate(text) if c == "\n"] if starts else []
    return [bisect.bisect(newlines, at) + 1 for at in starts]


# Start, end and empty tags of the elements that can put a condition
# around a <Compile> item, and the items themselves. Items in a <Target>
# change only when that target runs, so they count as conditional.
TAG_RE = re.compile(r"<(/?)(ItemGroup|Choose|When|Otherwise|Target|Compile)\b" + ATTRS + r"(/?)>", re.IGNORECASE)
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
PROJECT_REF_RE = re.compile(r"<ProjectReference\b" + ATTRS + r"/?>", re.IGNORECASE)
INCLUDE_ATTR_RE = re.compile(r"\bInclude\s*=\s*" + QUOTED, re.IGNORECASE)
# EnableDefaultCompileItems / EnableDefaultItems, with the elements that
# can put a condition around them.
DEFAULT_TAG_RE = re.compile(r"<(/?)(PropertyGroup|Choose|When|Otherwise|Target|EnableDefaultCompileItems|EnableDefaultItems)\b"
                            + ATTRS + r"(/?)>(?:([^<]*)</\2\s*>)?", re.IGNORECASE)
SDK_RE = re.compile(r"<Project\s[^>]*\bSdk\s*=", re.IGNORECASE)


def rel_dir(path, root):
    rel = path.parent.relative_to(root).as_posix()
    return "" if rel == "." else rel


def msbuild_path(base, value):
    """A project-relative MSBuild path (backslashes, ..) as a root-relative path."""
    joined = posixpath.normpath(posixpath.join(base, value.strip().replace("\\", "/")))
    return "" if joined == "." else joined


def default_items(text):
    """Whether an SDK project compiles the *.cs/*.vb files under it by
    default: True, False, or "maybe". Both EnableDefaultItems and
    EnableDefaultCompileItems must be on (EnableDefaultItems=true does not
    undo EnableDefaultCompileItems=false). Each is "maybe" when set under a
    Condition or to a property."""
    text = COMMENT_RE.sub("", text)
    state = {"enabledefaultitems": True, "enabledefaultcompileitems": True}
    stack = []
    for m in DEFAULT_TAG_RE.finditer(text):
        closing, name, attr_text, empty, value = m.groups()
        name = name.lower()
        if name not in state:
            if closing:
                while stack and stack.pop()[0] != name:
                    pass
            elif not empty:
                cond = name != "propertygroup" or re.search(r"\bCondition\s*=", attr_text, re.IGNORECASE)
                stack.append((name, bool(cond)))
            continue
        if closing or value is None:
            continue
        value = value.strip().lower()
        new = True if value == "true" else False if value == "false" else "maybe"
        conditional = re.search(r"\bCondition\s*=", attr_text, re.IGNORECASE) or any(c for _, c in stack)
        if not conditional:
            state[name] = new
        elif new != state[name]:
            state[name] = "maybe"
    values = state.values()
    if False in values:
        return False
    return "maybe" if "maybe" in values else True


def compile_items(text):
    """(kind, value, conditional, excludes) of every <Compile Include/Remove>
    item, one per entry of its ;-separated list. conditional: a Condition on
    the item, on its ItemGroup, or a <Choose> branch around it. excludes:
    the Exclude values of an Include (they apply to that item only)."""
    text = COMMENT_RE.sub("", text)
    items = []
    stack = []          # open ItemGroup/Choose/When/Otherwise: whether each is a condition
    for m in TAG_RE.finditer(text):
        closing, name, attr_text, empty = m.group(1), m.group(2).lower(), m.group(3), m.group(4)
        if name != "compile":
            if closing:
                # Pop to the matching start tag (a missing end tag is forgiven).
                while stack and stack.pop()[0] != name:
                    pass
            elif not empty:
                cond = name != "itemgroup" or re.search(r"\bCondition\s*=", attr_text, re.IGNORECASE)
                stack.append((name, bool(cond)))
            continue
        if closing:
            continue
        attrs = {k.lower(): a or b for k, a, b in ITEM_ATTR_RE.findall(attr_text)}
        conditional = "condition" in attrs or any(c for _, c in stack)
        excludes = tuple(v.strip() for v in attrs.get("exclude", "").split(";") if v.strip())
        for kind in ("include", "remove"):
            for value in attrs.get(kind, "").split(";"):
                if value.strip():
                    items.append((kind, value.strip(), conditional, excludes if kind == "include" else ()))
    return items


CONTAINER_RE = re.compile(r"<(/?)(ItemGroup|ImportGroup|Choose|When|Otherwise|Target)\b" + ATTRS + r"(/?)>", re.IGNORECASE)


def conditional_spans(text):
    """(start, end) of every ItemGroup or ImportGroup with a Condition,
    Choose branch and Target of text: an item or import inside one is
    conditional."""
    spans, stack = [], []
    for m in CONTAINER_RE.finditer(text):
        closing, name, attr_text, empty = m.group(1), m.group(2).lower(), m.group(3), m.group(4)
        if closing:
            while stack:
                open_name, start, cond = stack.pop()
                if cond:
                    spans.append((start, m.end()))
                if open_name == name:
                    break
        elif not empty:
            cond = name not in {"itemgroup", "importgroup"} or re.search(r"\bCondition\s*=", attr_text, re.IGNORECASE)
            stack.append((name, m.start(), bool(cond)))
    spans += [(start, len(text)) for _, start, cond in stack if cond]
    return spans


def attr_values(regex, text):
    """Values of a regex built on QUOTED, whichever quote each one uses."""
    return [a or b for a, b in regex.findall(text)]


GLOB_CACHE = {}


def compile_state(rel, items, by_default):
    r"""Whether a project compiles rel: "yes", "no" or "maybe" (it depends on
    an unevaluated Condition or property). Items apply in document order, as
    MSBuild evaluates them: <Compile Remove="Legacy\**" /> then
    <Compile Include="Legacy\Keep.cs" /> compiles Keep.cs."""
    # by_default "maybe": compiled unless an unevaluated setting turns it off.
    compiled, maybe_add, maybe_drop = bool(by_default), False, by_default == "maybe"
    for kind, pattern, conditional, unknown, excludes in items:
        if not unknown and not glob_match(rel, pattern):
            continue
        # Include="**\*.cs" Exclude="Legacy\**": the item skips Legacy.
        if any(not u and glob_match(rel, x) for x, u in excludes):
            continue
        if any(u for _, u in excludes):
            unknown = True      # Exclude="$(Skip)" may skip rel
        if conditional or unknown:
            if kind == "include":
                maybe_add = True
            else:
                maybe_drop = True
        elif kind == "include":
            compiled, maybe_drop = True, False
        else:
            compiled, maybe_add = False, False
    if compiled:
        return "maybe" if maybe_drop else "yes"
    return "maybe" if maybe_add else "no"


def glob_match(rel, pattern):
    """MSBuild wildcards: * and ? stay within one directory, ** spans any
    number of directories (none too). Case is ignored, as MSBuild does on
    Windows, where legacy .NET projects are built."""
    if pattern not in GLOB_CACHE:
        out, i = [], 0
        while i < len(pattern):
            if pattern.startswith("**/", i):
                out.append("(?:[^/]*/)*")
                i += 3
            elif pattern.startswith("**", i):
                out.append(".*")
                i += 2
            elif pattern[i] == "*":
                out.append("[^/]*")
                i += 1
            elif pattern[i] == "?":
                out.append("[^/]")
                i += 1
            else:
                out.append(re.escape(pattern[i]))
                i += 1
        GLOB_CACHE[pattern] = re.compile("".join(out), re.IGNORECASE)
    return GLOB_CACHE[pattern].fullmatch(rel) is not None


IMPORT_PROJECT_RE = re.compile(r"<Import\b" + ATTRS + r"/?>", re.IGNORECASE)
PROJECT_ATTR_RE = re.compile(r"\bProject\s*=\s*" + QUOTED, re.IGNORECASE)
DIRECTORY_BUILD = ("Directory.Build.props", "Directory.Build.targets")


def directory_build(root, d, name):
    """rel of the nearest name (Directory.Build.props/.targets) at or above
    project directory d under root, as MSBuild finds it, or None."""
    while True:
        rel = f"{d}/{name}" if d else name
        if (root / rel).is_file():
            return rel
        if not d:
            return None
        d = posixpath.dirname(d)


def with_imports(root, rel, text, warnings, seen=None):
    """text with each <Import Project="..."> of a file under root put in
    its place (paths relative to the importing file, as MSBuild takes
    them). An import of the next Directory.Build.props/.targets above
    (GetPathOfFileAbove) is followed too; other imports that use a
    property are not read."""
    seen = set() if seen is None else seen
    seen.add(rel.lower())
    here = posixpath.dirname(rel)
    spans = conditional_spans(text)

    def expand(m):
        values = attr_values(PROJECT_ATTR_RE, m.group(1))
        if not values:
            return m.group(0)
        value = values[0].strip()
        target = None
        for name in DIRECTORY_BUILD:
            if name.lower() in value.lower() and "$(" in value and here:
                target = directory_build(root, posixpath.dirname(here), name)
                break
        if target is None and "$(" not in value:
            target = msbuild_path(here, value)
        if target is None or target.lower() in seen or not (root / target).is_file():
            return m.group(0)
        body = with_imports(root, target, COMMENT_RE.sub("", read_source(root / target, warnings)), warnings, seen)
        if re.search(r"\bCondition\s*=", m.group(1), re.IGNORECASE) or any(a <= m.start() < b for a, b in spans):
            # An import under a Condition (its own, an ImportGroup's, a
            # Choose branch's) keeps it: what it adds or removes is
            # conditional, as if written in a <When>.
            body = f"<Choose><When Condition=\"'$(Imported)' != ''\">{body}</When></Choose>"
        return body
    return IMPORT_PROJECT_RE.sub(expand, text)


def project_text(root, d, proj_rel, text, warnings):
    """The project file's text as MSBuild reads it: the nearest
    Directory.Build.props before it and Directory.Build.targets after it,
    and the files they and it import by a path under root."""
    seen = set()
    parts = []
    for name, own in ((DIRECTORY_BUILD[0], None), (None, text), (DIRECTORY_BUILD[1], None)):
        if own is not None:
            parts.append(with_imports(root, proj_rel, COMMENT_RE.sub("", own), warnings, seen))
            continue
        rel = directory_build(root, d, name)
        if rel and rel.lower() not in seen:
            parts.append(with_imports(root, rel, COMMENT_RE.sub("", read_source(root / rel, warnings)), warnings, seen))
    return "\n".join(parts)


def dotnet_projects(root, rels, project_ext, warnings):
    """(visible_files, not_compiled, projects_of, texts) for C# (.csproj) or VB.NET (.vbproj).

    projects_of maps every file to the directories of the projects that
    compile it: the project of its directory, and any project that links it
    in with <Compile Include="..\\Shared\\X.cs" /> (empty outside any
    project). visible_files(rel) -> set of files those projects and the
    projects they reference hold, or None outside any project. not_compiled
    maps a file no project compiles to (the project that leaves it out,
    whether that depends on an unevaluated Condition or property); texts
    maps a project directory to its project file's text, comments removed."""
    projects = {}       # project dir -> (project file rel, text)
    for proj in find_files(root, {project_ext}, {"bin": {project_ext}, "obj": {project_ext}, "packages": {".sln"}}):
        d = rel_dir(proj, root)
        if d in projects:
            warnings.append(f"several {project_ext} files in {d or '.'}; using {projects[d][0]}")
            continue
        proj_rel = proj.relative_to(root).as_posix()
        own = read_source(proj, warnings)
        projects[d] = (proj_rel, project_text(root, d, proj_rel, own, warnings))
        bad = malformed_lines(own)
        if bad:
            lines = ", ".join(map(str, bad[:5])) + (f" and {len(bad) - 5} more" if len(bad) > 5 else "")
            warnings.append(f"{projects[d][0]}: tags not read at line {lines} (a raw < in an attribute "
                            "value? MSBuild needs &lt;); their items and conditions are ignored")
    if not projects:
        return None, {}, {rel: () for rel in rels}, {}
    owner = {rel: nearest(rel, projects) for rel in rels}
    by_file = {proj_rel.lower(): d for d, (proj_rel, _) in projects.items()}   # Windows paths ignore case
    refs = {}
    compiled_by = {rel: [] for rel in rels}         # rel -> [(project dir, "yes" | "maybe")]
    left_out = {}       # rel -> (owner project file, "no" | "maybe")
    for d, (proj_rel, text) in projects.items():
        refs[d] = set()
        for value in (v for m in PROJECT_REF_RE.finditer(COMMENT_RE.sub("", text))
                      for v in attr_values(INCLUDE_ATTR_RE, m.group(1))):
            path = msbuild_path(d, value)
            target = by_file.get(path.lower())
            if target is not None:
                refs[d].add(target)
            else:
                there = projects.get(posixpath.dirname(path))
                where = ("uses an MSBuild property" if "$(" in value else
                         "is not under --root" if path == ".." or path.startswith("../") else
                         f"is not found under --root ({there[0]} is the project file there)" if there else
                         "is not found under --root (no project file there)")
                warnings.append(f"{proj_rel}: ProjectReference {value} {where}")
        sdk = SDK_RE.search(text)
        by_default = default_items(text) if sdk else False
        # (kind, path, conditional, unknown, excludes): an item whose value uses an
        # MSBuild property or item ($(Src)\*.cs) may match any file.
        def unknown(value):
            return bool(re.search(r"[$@%]\(", value))
        items = [(kind, msbuild_path(d, v), cond, unknown(v), tuple((msbuild_path(d, x), unknown(x)) for x in ex))
                 for kind, v, cond, ex in compile_items(text)]
        if by_default is False and not any(item[0] == "include" for item in items):
            # A project that lists no files: an old-style one compiles its
            # directory's files; an SDK one that turned the defaults off
            # gets them from an import the mapper does not read.
            by_default = "maybe" if sdk else True
        # Files of other directories are linked in only by a path or
        # wildcard that names them: $(IntermediateOutputPath)X.cs would
        # otherwise link every file under --root into every project.
        known = [item for item in items if not item[3]]
        links = any(item[0] == "include" for item in known)
        for rel in rels:
            if owner[rel] == d:
                state = compile_state(rel, items, by_default)
                if state != "yes":
                    left_out[rel] = (proj_rel, state)
            elif links:
                # <Compile Include="..\Shared\X.cs" />: a file of another
                # directory linked into this project.
                state = compile_state(rel, known, False)
            else:
                continue
            if state != "no":
                compiled_by[rel].append((d, state))
    # A file belongs to every project that compiles it (or may): its owner
    # and the projects that link it in. One that none compiles stays with
    # its owner, which leaves it out.
    projects_of, not_compiled = {}, {}
    for rel in rels:
        dirs = sorted(d for d, _ in compiled_by[rel])
        projects_of[rel] = tuple(dirs) or ((owner[rel],) if owner[rel] is not None else ())
        if rel in left_out:
            proj_rel, state = left_out[rel]
            if state == "maybe":
                not_compiled[rel] = (proj_rel, True)    # kept, and listed, even if another project links it
            elif any(st == "maybe" for _, st in compiled_by[rel]):
                if not any(st == "yes" for _, st in compiled_by[rel]):
                    not_compiled[rel] = (proj_rel, True)
            elif not compiled_by[rel]:
                not_compiled[rel] = (proj_rel, False)
        elif compiled_by[rel] and not any(st == "yes" for _, st in compiled_by[rel]):
            # A file outside any project that projects link in only under
            # a Condition.
            not_compiled[rel] = (", ".join(projects[d][0] for d in dirs), True)
    members = {}
    for rel, dirs in projects_of.items():
        for d in dirs:
            members.setdefault(d, set()).add(rel)
    cache = {}

    def visible_files(rel):
        dirs = projects_of.get(rel, ())
        if not dirs:
            return None
        if dirs not in cache:
            cache[dirs] = set().union(*(members.get(p, set()) for d in dirs for p in reachable(d, refs)))
        return cache[dirs]

    texts = {d: COMMENT_RE.sub("", text) for d, (_, text) in projects.items()}
    return visible_files, not_compiled, projects_of, texts


POM_ARTIFACT_RE = re.compile(r"<artifactId>\s*([^<\s]+)\s*</artifactId>")
POM_GROUP_RE = re.compile(r"<groupId>\s*([^<\s]+)\s*</groupId>")
POM_PARENT_RE = re.compile(r"<parent>(.*?)</parent>", re.DOTALL)
POM_STRIP_RE = re.compile(r"<(parent|dependencies|dependencyManagement|build|profiles|plugins|reporting)\b.*?</\1>", re.DOTALL)
POM_DEPENDENCY_RE = re.compile(r"<dependency>(.*?)</dependency>", re.DOTALL)
# project(":core"), project(path: ":core") and Kotlin's project(path = ":core").
GRADLE_PROJECT_RE = re.compile(r"""project\s*\(\s*(?:path\s*[:=]\s*)?['"](:[^'"]*)['"]""")
# Type-safe accessors: projects.core, projects.myLib (my-lib), projects.libs.core.
GRADLE_ACCESSOR_RE = re.compile(r"\bprojects((?:\s*\.\s*[A-Za-z_]\w*)+)")
GRADLE_SETTINGS = ("settings.gradle", "settings.gradle.kts")


def gradle_accessors(base, builds):
    """Lower-cased accessor chain (core, mylib, libs.core) -> project dir for
    the Gradle projects under the settings directory base. Gradle turns
    kebab-case and snake_case names into camelCase accessors."""
    out = {}
    for target in builds:
        if base and not target.startswith(base + "/"):
            continue
        rel = target[len(base) + 1:] if base else target
        if not rel:
            continue
        chain = []
        for seg in rel.split("/"):
            words = [w for w in re.split(r"[-_]", seg) if w]
            chain.append((words[0] + "".join(w[:1].upper() + w[1:] for w in words[1:])) if words else seg)
        out[".".join(chain).lower()] = target
    return out


def java_modules(root, rels, warnings):
    """visible_files for Java: Maven modules (pom.xml) and Gradle projects
    (build.gradle / build.gradle.kts), or None when neither exists."""
    modules = {}        # module dir -> set of module dirs it depends on (unresolved names first)
    artifact_of, wanted = {}, {}
    builds = {}
    # Build files in build-output directories are skipped by the same rule
    # as sources (only at --root or beside a build file), so a module that
    # lives in a directory named build is still a module.
    names = ("pom.xml", "build.gradle", "build.gradle.kts")
    found = find_files(root, {".xml", ".gradle", ".kts"}, {"target", "build", "out"}, set(names) | {"build.xml"})
    for name in names:
        for path in found:
            if path.name == name:
                builds.setdefault(rel_dir(path, root), []).append(path)
    if not builds:
        return None
    settings_dirs = sorted({rel_dir(p, root) for n in GRADLE_SETTINGS for p in root.rglob(n)
                            if not any(x.startswith(".") for x in p.relative_to(root).parts[:-1])}, key=len)
    for d, paths in builds.items():
        modules[d] = set()
        for path in paths:
            text = read_source(path, warnings)
            if path.name == "pom.xml":
                text = COMMENT_RE.sub("", text)
                body = POM_STRIP_RE.sub("", text)
                m = POM_ARTIFACT_RE.search(body)
                # The module's groupId, else its parent's (Maven inherits it).
                parent = POM_PARENT_RE.search(text)
                g = POM_GROUP_RE.search(body) or (parent and POM_GROUP_RE.search(parent.group(1)))
                group = g.group(1) if g else None
                if m:
                    artifact_of.setdefault(m.group(1), []).append((group, d))
                wanted[d] = []
                for dep in POM_DEPENDENCY_RE.findall(text):
                    a, g = POM_ARTIFACT_RE.search(dep), POM_GROUP_RE.search(dep)
                    if a:
                        dep_group = g.group(1) if g else None
                        if dep_group in {"${project.groupId}", "${pom.groupId}", "${groupId}"}:
                            dep_group = group
                        wanted[d].append((dep_group, a.group(1)))
            else:
                base = next((s for s in reversed(settings_dirs) if d == s or d.startswith(s + "/") or s == ""), "")
                for ref in GRADLE_PROJECT_RE.findall(text):
                    target = posixpath.normpath(posixpath.join(base, ref.strip(":").replace(":", "/")))
                    target = "" if target == "." else target
                    if target in builds:
                        modules[d].add(target)
                accessors = gradle_accessors(base, builds)
                for chain in GRADLE_ACCESSOR_RE.findall(text):
                    parts = [p.strip() for p in chain.split(".") if p.strip()]
                    # The longest prefix that names a project; the rest is
                    # a property of it (projects.core.dependencyProject).
                    for k in range(len(parts), 0, -1):
                        target = accessors.get(".".join(parts[:k]).lower())
                        if target is not None:
                            modules[d].add(target)
                            break
    # A dependency names a module by groupId:artifactId. Modules that share
    # an artifactId under different groupIds are different modules; a
    # groupId the mapper cannot read (a property, an unread parent) keeps
    # every module of that artifactId and is reported.
    for d, deps in sorted(wanted.items()):
        for group, artifact in deps:
            found = artifact_of.get(artifact, [])
            exact = [m for g, m in found if g is not None and g == group]
            if exact or group is not None and not group.startswith("${") and all(g is not None for g, _ in found):
                targets = exact
            else:
                targets = [m for _, m in found]
                if len(targets) > 1:
                    warnings.append(f"{d or '.'}/pom.xml: dependency {group or '?'}:{artifact} matches "
                                    f"{len(targets)} modules ({', '.join(sorted(m or '.' for m in targets))}); "
                                    "its groupId is not read, so it sees all of them")
            modules[d].update(t for t in targets if t != d)
    owner = {rel: nearest(rel, builds) for rel in rels}
    members = {}
    for rel, d in owner.items():
        if d is not None:
            members.setdefault(d, set()).add(rel)
    cache = {}

    def visible_files(rel):
        d = owner.get(rel)
        if d is None:
            return None
        if d not in cache:
            cache[d] = set().union(*(members.get(p, set()) for p in reachable(d, modules)))
        return cache[d]

    return visible_files


def drop_not_compiled(infos, not_compiled):
    """A file its project does not compile declares nothing other files can
    use: keep it as a node with its own references, list it as unresolved.
    A file left out only under an unevaluated Condition keeps its
    declarations (more edges, never fewer) and is listed too."""
    rows = set()
    for info in infos:
        if info.rel not in not_compiled:
            continue
        project, conditional = not_compiled[info.rel]
        if conditional:
            rows.add((info.rel, "(whole file)",
                      f"compiled by {project} only under a Condition, MSBuild property or import that is not evaluated; "
                      "its declarations are kept"))
            continue
        info.decls, info.extensions, info.partial = [], [], set()
        info.type_members, info.type_bases = {}, {}
        rows.add((info.rel, "(whole file)", f"not compiled by {project}; its declarations are ignored"))
    return rows
