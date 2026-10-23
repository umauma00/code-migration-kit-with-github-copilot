# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Build-file facts the C#, VB.NET and Java mappers use (stdlib only).

The files are read as text, never evaluated: MSBuild properties, imports,
conditions and Directory.Build.props are not expanded, and Maven/Gradle are
not run. What they give:

  - which project or module each source file belongs to (the deepest
    directory above it holding a .csproj/.vbproj, pom.xml or build.gradle);
  - which projects each one references (ProjectReference, a Maven dependency
    on a sibling module's artifactId, Gradle project(':a:b')), transitively;
  - .NET files a project does not compile (<Compile Remove>, or an old-style
    project that lists its <Compile Include> files and leaves the file out).
    Include and Remove are item lists ("a.cs;b.cs"). An item under a
    Condition (on the item, its ItemGroup, or inside <Choose>) is not
    evaluated: a file only such an item leaves out keeps its declarations and
    is reported as depending on an unevaluated condition.

A name that matches types in several projects then only gives edges into the
projects the file's own project can see. A project that sees none of the
candidates keeps them all.
"""

import fnmatch
import posixpath
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from depmap_common import find_files, nearest, reachable, read_source  # noqa: E402

ATTR = r'\s+Include\s*=\s*"([^"]+)"'
COMPILE_RE = re.compile(r"<Compile\b([^>]*?)/?>", re.IGNORECASE)
ITEM_ATTR_RE = re.compile(r'\b(Include|Remove|Condition)\s*=\s*"([^"]*)"', re.IGNORECASE)
CONDITIONAL_RE = re.compile(r"<(ItemGroup|When|Otherwise)\b([^>]*)>(.*?)</\1\s*>", re.IGNORECASE | re.DOTALL)
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
PROJECT_REF_RE = re.compile(r"<ProjectReference" + ATTR, re.IGNORECASE)
NO_DEFAULT_RE = re.compile(r"<EnableDefaultCompileItems>\s*false\s*</EnableDefaultCompileItems>", re.IGNORECASE)
SDK_RE = re.compile(r"<Project\s[^>]*\bSdk\s*=", re.IGNORECASE)


def rel_dir(path, root):
    rel = path.parent.relative_to(root).as_posix()
    return "" if rel == "." else rel


def msbuild_path(base, value):
    """A project-relative MSBuild path (backslashes, ..) as a root-relative path."""
    joined = posixpath.normpath(posixpath.join(base, value.strip().replace("\\", "/")))
    return "" if joined == "." else joined


def compile_items(text):
    """(kind, value, conditional) of every <Compile Include/Remove> item, one
    per entry of its ;-separated list. conditional: a Condition on the item,
    on its ItemGroup, or a <Choose> branch around it."""
    text = COMMENT_RE.sub("", text)
    guarded = []        # spans under a condition
    for m in CONDITIONAL_RE.finditer(text):
        if m.group(1).lower() != "itemgroup" or re.search(r"\bCondition\s*=", m.group(2), re.IGNORECASE):
            guarded.append((m.start(), m.end()))
    for m in re.finditer(r"<Choose\b.*?</Choose\s*>", text, re.IGNORECASE | re.DOTALL):
        guarded.append((m.start(), m.end()))
    items = []
    for m in COMPILE_RE.finditer(text):
        attrs = {k.lower(): v for k, v in ITEM_ATTR_RE.findall(m.group(1))}
        conditional = "condition" in attrs or any(a <= m.start() < b for a, b in guarded)
        for kind in ("include", "remove"):
            for value in attrs.get(kind, "").split(";"):
                if value.strip():
                    items.append((kind, value.strip(), conditional))
    return items


def glob_match(rel, pattern):
    # MSBuild ** matches any depth; fnmatch's * already crosses "/".
    return fnmatch.fnmatchcase(rel, pattern.replace("**/", "*").replace("**", "*"))


def dotnet_projects(root, rels, project_ext, warnings):
    """(visible_files, not_compiled, owner, texts) for C# (.csproj) or VB.NET (.vbproj).

    visible_files(rel) -> set of files its project and the projects it
    references hold, or None outside any project. not_compiled maps a file
    to (the project that leaves it out of its build, whether that depends on
    an unevaluated Condition). owner maps every file to its project
    directory (None outside any project); texts maps a project directory to
    its project file's text."""
    projects = {}       # project dir -> (project file rel, text)
    for proj in find_files(root, {project_ext}, {"bin", "obj", "packages"}):
        d = rel_dir(proj, root)
        if d in projects:
            warnings.append(f"several {project_ext} files in {d or '.'}; using {projects[d][0]}")
            continue
        projects[d] = (proj.relative_to(root).as_posix(), read_source(proj, warnings))
    if not projects:
        return None, {}, {rel: None for rel in rels}, {}
    owner = {rel: nearest(rel, projects) for rel in rels}
    refs, not_compiled = {}, {}
    for d, (proj_rel, text) in projects.items():
        refs[d] = set()
        for value in PROJECT_REF_RE.findall(text):
            target = posixpath.dirname(msbuild_path(d, value))
            if target in projects:
                refs[d].add(target)
            else:
                warnings.append(f"{proj_rel}: ProjectReference {value} is not under --root")
        mine = [rel for rel in rels if owner[rel] == d]
        explicit = not SDK_RE.search(text) or NO_DEFAULT_RE.search(text)
        items = [(kind, msbuild_path(d, v), cond) for kind, v, cond in compile_items(text)]
        includes = [(p, cond) for kind, p, cond in items if kind == "include"]
        removes = [(p, cond) for kind, p, cond in items if kind == "remove"]
        for rel in mine:
            inc = {cond for p, cond in includes if glob_match(rel, p)}
            rem = {cond for p, cond in removes if glob_match(rel, p)}
            if False in rem or (explicit and includes and not inc):
                not_compiled[rel] = (proj_rel, False)
            elif rem or (explicit and includes and False not in inc):
                not_compiled[rel] = (proj_rel, True)
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
            cache[d] = set().union(*(members.get(p, set()) for p in reachable(d, refs)))
        return cache[d]

    texts = {d: text for d, (_, text) in projects.items()}
    return visible_files, not_compiled, owner, texts


POM_ARTIFACT_RE = re.compile(r"<artifactId>\s*([^<\s]+)\s*</artifactId>")
POM_STRIP_RE = re.compile(r"<(parent|dependencies|dependencyManagement|build|profiles|plugins|reporting)\b.*?</\1>", re.DOTALL)
POM_DEPENDENCY_RE = re.compile(r"<dependency>(.*?)</dependency>", re.DOTALL)
GRADLE_PROJECT_RE = re.compile(r"""project\s*\(\s*(?:path\s*:\s*)?['"](:[^'"]*)['"]""")
GRADLE_SETTINGS = ("settings.gradle", "settings.gradle.kts")


def java_modules(root, rels, warnings):
    """visible_files for Java: Maven modules (pom.xml) and Gradle projects
    (build.gradle / build.gradle.kts), or None when neither exists."""
    modules = {}        # module dir -> set of module dirs it depends on (unresolved names first)
    artifact_of, wanted = {}, {}
    builds = {}
    for name in ("pom.xml", "build.gradle", "build.gradle.kts"):
        for path in sorted(root.rglob(name)):
            parts = path.relative_to(root).parts
            if any(p.startswith(".") or p in {"target", "build", "node_modules", "out"} for p in parts[:-1]):
                continue
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
                body = POM_STRIP_RE.sub("", text)
                m = POM_ARTIFACT_RE.search(body)
                if m:
                    artifact_of[m.group(1)] = d
                wanted[d] = {a for dep in POM_DEPENDENCY_RE.findall(text) for a in POM_ARTIFACT_RE.findall(dep)}
            else:
                base = next((s for s in reversed(settings_dirs) if d == s or d.startswith(s + "/") or s == ""), "")
                for ref in GRADLE_PROJECT_RE.findall(text):
                    target = posixpath.normpath(posixpath.join(base, ref.strip(":").replace(":", "/")))
                    target = "" if target == "." else target
                    if target in builds:
                        modules[d].add(target)
    for d, artifacts in wanted.items():
        modules[d].update(artifact_of[a] for a in artifacts if a in artifact_of and artifact_of[a] != d)
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
                      f"compiled by {project} only under a Condition that is not evaluated; its declarations are kept"))
            continue
        info.decls, info.extensions, info.partial = [], [], set()
        info.type_members, info.type_bases = {}, {}
        rows.add((info.rel, "(whole file)", f"not compiled by {project}; its declarations are ignored"))
    return rows
