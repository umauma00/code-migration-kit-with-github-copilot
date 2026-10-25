# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Type-name resolution shared by the C#, Java and VB.NET mappers.

In these languages an import names a namespace (C#, VB.NET) or a package, not
a file, and code in the same namespace needs no import at all. A file-level
edge therefore comes from resolving every type name a file mentions against a
table of the types each file declares. Two passes:

  1. each file reports its namespace(s), the types (and C# extension methods /
     VB module members) it declares, its imports, and the dotted names its code
     mentions (comments and string contents removed);
  2. every mentioned name is resolved through the C#/Java/VB lookup rules
     approximated below, and each match is an edge.

The approximation is conservative: when a simple name matches several visible
types, every candidate becomes an edge (more edges, never fewer); a local
variable that happens to share a type's name also becomes an edge. Partial
types declared in several files link all their parts both ways. A type that
several files declare without partial (copies of one source, alternatives
for different builds) does not link those files to each other: a file that
declares a name refers to its own declaration. Each such duplicate is
listed in unresolved.tsv, and every other file that names it gets an edge
to each copy.
"""

import re
import sys
import threading

from depmap_common import EXTERNAL


class FileInfo:
    def __init__(self, rel):
        self.rel = rel
        self.namespaces = set()     # namespaces the file declares types in ("" = global)
        self.decls = []             # (namespace, name) of declared types/members
        self.extensions = []        # (namespace, name) of members called as x.Name (C# extension methods, VB module members)
        self.extension_receivers = {}   # C# extension fqn -> simple names of its receiver types (this T x)
        self.partial = set()        # FQNs declared partial in this file
        self.arity = {}             # C#: FQN -> type parameter counts it is declared with here (Result 0, Result<T> 1)
        self.written_arity = {}     # C#: simple type name -> type argument counts written after it here
        self.nested = {}            # namespace.Name -> namespace.Outer.Name of each type nested in another type of this file
        self.member_decls = set()   # FQNs in decls that are VB Module members, not types
        self.usings = set()         # imported namespaces (or types: Java on-demand of a type)
        self.blocks = {}            # C# namespace block context -> Directives written in it
        self.aliases = {}           # alias -> dotted target
        self.alias_more = {}        # alias -> further targets (a file compiled by projects with different global aliases)
        self.direct = set()         # dotted targets imported one by one (Java import a.B, C# using static)
        self.project_static = set() # C# global using static of another file: an edge only where a member is used
        self.names = []             # (namespace written in, dotted name chain) mentioned in code
        self.attribute_names = []   # the names in names written as an attribute ([Foo])
        # A name in names written only as a value inside types (Category ==
        # "food"): -> those types' keys. A member of that name in another
        # part of a partial type or in a base type hides the type.
        self.member_like = {}
        self.type_chains = []       # (namespace written in, dotted chain) written where only a type can stand
        self.members = set()        # names written after "." (x.Name)
        self.member_calls = set()   # C#: (receiver variable or "", name) of each x.Name
        self.static_receivers = set()  # C#: receivers named like a static class (File, Math)
        self.strings = []           # string literal contents (reflection lookups)
        self.dynamic = []           # (reference, reason) the mapper could not resolve statically
        self.type_members = {}      # type fqn -> {member: [(type chain, is_element)]}
        self.type_bases = {}        # type fqn -> [base type chain]
        self.type_ns = {}           # type fqn -> namespace its declaration is written in
        self.flow = []              # bindings and member chains (see flow_c_like)


class Directives:
    """using directives written inside one C# namespace block. They apply in
    that block and in the blocks nested in it, not in another block of the
    same namespace."""

    def __init__(self, parent):
        self.parent = parent        # context of the enclosing block, or None
        self.usings = set()
        self.aliases = {}
        self.direct = set()


BLOCK = "#"     # a context "ns#3" is the 3rd namespace block of a C# file, in namespace ns


def context_ns(ctx):
    """The namespace a context denotes (a C# block context names its block too)."""
    return ctx.split(BLOCK, 1)[0]


# Top namespaces of the platform libraries: an import under one is never
# reported as a possibly missing in-house library.
DOTNET_STANDARD = ("System", "Microsoft", "Windows", "Mono", "Interop")
JAVA_STANDARD = ("java", "javax", "jakarta", "jdk", "sun", "com.sun", "org.w3c", "org.xml",
                 "org.ietf", "org.omg", "netscape")
# Namespaces directly under System that VB code may write relative to
# Imports System (Collections.Generic.List): never taken for a library.
PLATFORM_CHILDREN = {n.lower() for n in """Buffers Collections ComponentModel Configuration Data
Diagnostics Drawing Dynamic Globalization IO Linq Management Media Net Numerics Reflection Resources
Runtime Security ServiceModel ServiceProcess Text Threading Timers Transactions Web Windows Xml""".split()}
NESTED = "\x00"          # namespace.Name + NESTED + file: a nested type, as its own file sees it
GLOBAL = "global::"     # a name qualified from the root namespace (C# global::, VB Global.)


def dotted(name, fold):
    """A written name as a dotted chain; a root-qualified name keeps the
    GLOBAL prefix so that it is resolved from the root only."""
    name = name.replace(" ", "").replace("\t", "").replace("\n", "").replace("\r", "")
    root = name.startswith(GLOBAL)
    if root:
        name = name[len(GLOBAL):]
    name = name.replace("::", ".")
    if name.startswith("@"):
        name = name[1:]
    name = ".".join(part.lstrip("@") for part in name.split("."))
    name = name.lower() if fold else name
    if not root and name.lower().startswith("global.") and fold:    # VB Global.X
        root, name = True, name[len("global."):]
    return GLOBAL + name if root else name


def rooted_name(name):
    """name marked as written from the root namespace (global::)."""
    return name if name.startswith(GLOBAL) else GLOBAL + name


def rooted(segs):
    """(segments without the GLOBAL marker, whether the name was root-qualified)."""
    if segs and segs[0].startswith(GLOBAL):
        return [segs[0][len(GLOBAL):]] + list(segs[1:]), True
    return list(segs), False


def prefixes(ns):
    """'a.b.c' -> ['a.b.c', 'a.b', 'a', '']: a namespace and its parents."""
    parts = ns.split(".") if ns else []
    return [".".join(parts[:i]) for i in range(len(parts), -1, -1)]


def join(ns, name):
    return f"{ns}.{name}" if ns else name


def scan_or_none(scan, rel, text, rows, *args):
    """scan(rel, text, *args). The parsers recurse once per bracket, so a
    file nested past Python's recursion limit is scanned again on a thread
    with a large stack and limit; past that too, None and a row in rows."""
    try:
        return scan(rel, text, *args)
    except RecursionError:
        pass
    result, old_limit, old_stack = [], sys.getrecursionlimit(), threading.stack_size()

    def deep():
        try:
            result.append(scan(rel, text, *args))
        except RecursionError:
            pass
    try:
        threading.stack_size(256 * 1024 * 1024)
        sys.setrecursionlimit(200000)
        worker = threading.Thread(target=deep)
        worker.start()
        worker.join()
    except (ValueError, RuntimeError, MemoryError):
        pass
    finally:
        sys.setrecursionlimit(old_limit)
        threading.stack_size(old_stack)
    if result:
        return result[0]
    rows.add((rel, "(whole file)", "nesting too deep to parse; the file is kept "
              "without its declarations or references"))
    return None


def resolve(infos, fold=False, global_usings=(), attribute_suffix=None,
            nested_lookup=True, visible_files=None, standard=()):
    """Return (edges, unresolved) for the FileInfo list.

    Every reference carries the namespace it is written in, and is looked up
    from there: a file with two namespace blocks resolves each block's names
    from its own block.
    nested_lookup: C# and VB.NET see the types of every enclosing namespace
    (code in a.b.c sees a.b and a) and accept names qualified relative to
    them; Java sees only its own package and fully qualified names.
    attribute_suffix: C# [Foo] may name FooAttribute.
    visible_files: optional function(rel) -> set of files its project can
    see (project references, build modules), or None when the file belongs
    to no project. When a name matches files both inside and outside that
    set, only those inside become edges.
    standard: top namespaces of the platform library (System, java...). An
    imported namespace the repository does not declare and that is not under
    one is listed once in external.tsv: it may be an in-house library whose
    source is outside --root.
    """
    types = {}          # fqn -> set(rel)
    extensions = {}     # fqn of an extension method -> set(rel)
    namespaces = set()
    declared_in = {}    # fqn -> [FileInfo] (members/bases resolve in that file's scope)
    for info in infos:
        for ns in info.namespaces:
            namespaces.update(prefixes(ns))
        for ns, name in info.decls:
            types.setdefault(join(ns, name), set()).add(info.rel)
        for ns, name in info.extensions:
            extensions.setdefault(join(ns, name), set()).add(info.rel)
        for fqn in set(info.type_members) | set(info.type_bases):
            declared_in.setdefault(fqn, []).append(info)
    # Types are keyed by namespace.Name (the scanners do not track nesting
    # in references), so DescriptorImpl nested in twenty classes of one
    # package shares one key. Each nested type also gets a key of its own
    # file, which names inside that file mean (its members and members'
    # types resolve there), and its qualified name Outer.Inner.
    flat_types = {fq: set(files) for fq, files in types.items()}
    canonical = {}      # own or qualified key -> (namespace.Name, declaring FileInfo)
    own_nested = {}     # rel -> simple name -> own key
    nested_only = set() # namespace.Name keys every declaration of which is nested
    for info in infos:
        for flat, qual in sorted(info.nested.items()):
            key = flat + NESTED + info.rel
            types[key] = {info.rel}
            canonical[key] = (flat, info)
            own_nested.setdefault(info.rel, {})[flat.rpartition(".")[2]] = key
            if qual not in flat_types:
                types.setdefault(qual, set()).add(info.rel)
                canonical.setdefault(qual, (flat, info))
    for fq, files in flat_types.items():
        if all(fq in info.nested for info in infos if info.rel in files):
            nested_only.add(fq)
    global_usings = {dotted(u, fold) for u in global_usings}
    # A using inside a C# namespace block is relative to the enclosing
    # namespaces (using Models; inside namespace Acme.Web may mean
    # Acme.Models): take the innermost that exists.
    names_known = namespaces | set(types)
    for info in infos:
        for ctx, block in info.blocks.items():
            outer = prefixes(context_ns(ctx))

            def absolute(name, known):
                if name.startswith(GLOBAL):     # using global::R; never relative
                    return name[len(GLOBAL):]
                return next((join(p, name) for p in outer if join(p, name) in known), name)
            block.usings = {absolute(u, namespaces) for u in block.usings}
            block.direct = {absolute(d, types) for d in block.direct}
            # using T = R; in namespace N may mean N.R, as a using does. The
            # result is a full name: it is marked global:: so that T.X is
            # not looked up relative to the namespaces around T again.
            block.aliases = {a: rooted_name(absolute(t, names_known))
                             for a, t in block.aliases.items()}
        # A file-level (or project) alias target is a full name too.
        info.aliases = {a: rooted_name(t) for a, t in info.aliases.items()}
        info.alias_more = {a: {rooted_name(t) for t in ts} for a, ts in info.alias_more.items()}

    def lookup(fqn):
        return types.get(fqn, ())

    def declaration(fqn):
        """(key in the files' tables, the FileInfos declaring it)."""
        if fqn in canonical:
            flat, info = canonical[fqn]
            return flat, [info]
        return fqn, declared_in.get(fqn, ())

    def longest(segs):
        for i in range(len(segs), 0, -1):
            fq = ".".join(segs[:i])
            if fq in types:
                return fq
        return None

    nested_types = {}   # type fqn -> its nested types' fqns
    for fq in types:
        parent = fq.rpartition(".")[0]
        if parent in types:
            nested_types.setdefault(parent, set()).add(fq)

    class Level:
        """One step of C#/VB name lookup: a namespace, and the directives of
        the declaration written for it (the file's own and the project's
        global ones belong to the root step)."""

        def __init__(self, ns, usings, aliases, direct, more=None):
            self.ns = ns
            self.usings = set(usings)
            self.imported = sorted(u for u in usings if u in namespaces)
            self.aliases = aliases
            self.more = more or {}  # alias -> further targets
            self.simple = {}    # simple name -> fqns from direct imports and aliases
            for target in sorted(direct):
                segs = target.split(".")
                fq = longest(segs)
                if not fq:
                    continue
                if nested_lookup:
                    # C# using static T brings T's nested types into scope,
                    # not the name T itself.
                    for inner in sorted(nested_types.get(fq, ())):
                        self.simple.setdefault(inner.rpartition(".")[2], set()).add(inner)
                else:
                    self.simple.setdefault(segs[-1], set()).add(fq)
            for alias, target in sorted(aliases.items()):
                for each in [target] + sorted(self.more.get(alias, ())):
                    fq = longest(rooted(each.split("."))[0])
                    if fq:
                        self.simple.setdefault(alias, set()).add(fq)

        def targets(self, alias):
            """Every target of an alias at this step."""
            return [self.aliases[alias]] + sorted(self.more.get(alias, ()))

    class Scope:
        """Name lookup as seen from one namespace of one file."""

        def __init__(self, info, ctx):
            self.info = info
            ns = context_ns(ctx)
            # Innermost first: prefixes() lists a namespace before its parents.
            self.inner_first = prefixes(ns) if nested_lookup else [ns]
            self.enclosing = set(self.inner_first)
            # The blocks around ctx, by the namespace each declares.
            by_ns, block_ctx = {}, ctx
            while block_ctx in info.blocks:
                by_ns.setdefault(context_ns(block_ctx), []).append(info.blocks[block_ctx])
                block_ctx = info.blocks[block_ctx].parent
            self.levels = []
            for level_ns in self.inner_first:
                usings, aliases, direct, more = set(), {}, set(), {}
                for block in by_ns.get(level_ns, ()):
                    usings |= block.usings
                    direct |= block.direct
                    for alias, target in block.aliases.items():
                        aliases.setdefault(alias, target)
                if level_ns == "" or not nested_lookup:
                    usings |= set(info.usings) | global_usings
                    direct |= info.direct | info.project_static
                    for alias, target in info.aliases.items():
                        aliases.setdefault(alias, target)
                    more = info.alias_more
                self.levels.append(Level(level_ns, usings, aliases, direct, more))
            # Java (no nested lookup) has one step; its imports are file-wide.
            self.aliases = {}
            for level in self.levels:
                for alias, target in level.aliases.items():
                    self.aliases.setdefault(alias, target)
            self.imported = sorted({u for level in self.levels for u in level.imported})
            self.visible = self.enclosing | set(self.imported)
            self.simple = {}
            for level in self.levels:
                for name, fqs in level.simple.items():
                    self.simple.setdefault(name, set()).update(fqs)
            self.cache, self.mention_cache = {}, {}

        def simple_name(self, name):
            """A simple type name, by the language's lookup order. C#/VB: at
            each namespace from the innermost outward, a type of that
            namespace, then an alias or using static written in that
            namespace's declaration, then the namespaces it imports (the
            file's and the project's directives belong to the root). Java
            takes a single-type import first, then its own package, then
            on-demand imports. Candidates tied at the first step that has
            any all count."""
            if name in self.cache:
                return self.cache[name]
            own = own_nested.get(self.info.rel, {}).get(name)
            if own:             # a type nested in this file
                self.cache[name] = {own}
                return {own}
            # A type nested in another file's class (NUnit.Core.NUnitFramework.
            # Assert) is not visible by its simple name: look past it, and
            # take it only when nothing else has the name.
            found = self.lookup_simple(name, lambda fq: fq in types and fq not in nested_only) \
                or self.lookup_simple(name, lambda fq: fq in types)
            self.cache[name] = found
            return found

        def lookup_simple(self, name, known):
            if nested_lookup:
                for level in self.levels:
                    if known(join(level.ns, name)):
                        return {join(level.ns, name)}
                    found = {fq for fq in level.simple.get(name, ()) if known(fq) or fq not in types} or {
                        join(u, name) for u in level.imported if known(join(u, name))}
                    if found:
                        return found
                return set()
            return {fq for fq in self.simple.get(name, ()) if known(fq) or fq not in types} or {
                join(ns, name) for ns in self.enclosing if known(join(ns, name))} or {
                join(u, name) for u in self.imported if known(join(u, name))}

        def unalias(self, segs):
            """segs with an alias expanded, unless a type or namespace of that
            name is found first; a global:: target keeps its GLOBAL mark."""
            if segs[0].startswith(GLOBAL):
                return segs
            for level in self.levels if nested_lookup else []:
                fq = join(level.ns, segs[0])
                if fq in types or fq in namespaces:
                    return segs
                if segs[0] in level.aliases:
                    return level.aliases[segs[0]].split(".") + segs[1:]
            if segs[0] in self.aliases:
                return self.aliases[segs[0]].split(".") + segs[1:]
            return segs

        def exact(self, segs):
            """Types a dotted name denotes as a whole (no member suffix)."""
            if len(segs) == 1 and not segs[0].startswith(GLOBAL):
                return self.simple_name(segs[0])
            segs, root = rooted(self.unalias(segs))
            if root:            # global::A.B: from the root namespace only
                fq = ".".join(segs)
                return {fq} if fq in types else set()
            if len(segs) == 1:
                return self.simple_name(segs[0])
            # Qualified: from the innermost enclosing namespace outward
            # (Java: fully qualified only), then through a type's nested name.
            for ns in self.inner_first if nested_lookup else [""]:
                fq = join(ns, ".".join(segs))
                if fq in types:
                    return {fq}
            out = set()
            for h in self.exact(segs[:1]):
                fq = join(h, ".".join(segs[1:]))
                if fq in types:
                    out.add(fq)
            return out

        def mentioned(self, chain):
            """Types a written name chain refers to (a type, or a type and members)."""
            if chain not in self.mention_cache:
                self.mention_cache[chain] = self._mentioned(chain)
            return self.mention_cache[chain]

        def _mentioned(self, chain):
            segs, root = rooted(chain.split("."))
            if root:
                fq = longest(segs)
                return {fq} if fq else set()
            if nested_lookup:
                # A type nested in another file's class is not visible by
                # its simple name (see simple_name).
                found = self._stepwise(segs, True) or self._stepwise(segs, False)
            else:
                segs, root = rooted(self.unalias(segs))
                fq = longest(segs)
                found = {fq} if fq else self.exact(segs[:1])
            if not found and attribute_suffix:
                # A name not known to be written as an attribute may still
                # be one (the scan missed it): FooAttribute when Foo is not
                # found.
                found = self.attribute(chain)
            return found

        def attribute(self, chain):
            """Types [chain] may name with the attribute suffix: [Foo] and
            [A.B.Foo] may mean FooAttribute even where Foo exists (C# takes
            the one that is an attribute; both count)."""
            segs = chain.split(".")
            found = self.exact(segs[:-1] + [segs[-1] + attribute_suffix])
            if not found and len(segs) > 1:
                found = self.exact([segs[0] + attribute_suffix])
            return found

        def _stepwise(self, segs, strict):
            """C#/VB: the first step (see simple_name) at which segs[0] means
            something; the rest of the chain is nested types or members.
            strict: skip a head that is only a type nested in a class."""
            def extend(fq):
                return longest(fq.split(".") + segs[1:]) or fq
            for level in self.levels:
                prefix = level.ns.split(".") if level.ns else []
                fq = longest(prefix + segs)
                if fq and fq.count(".") >= len(prefix) and not (
                        strict and join(level.ns, segs[0]) in nested_only):
                    return {fq}
                if join(level.ns, segs[0]) in namespaces:
                    continue        # a namespace of that name; its type may be further out
                if segs[0] in level.aliases:
                    found = set()
                    for each in level.targets(segs[0]):
                        fq = longest(rooted(each.split("."))[0] + segs[1:])
                        if fq:
                            found.add(fq)
                    if found:
                        return found
                found = set(level.simple.get(segs[0], ())) or {
                    join(u, segs[0]) for u in level.imported
                    if join(u, segs[0]) in types and not (strict and join(u, segs[0]) in nested_only)}
                if found:
                    return {extend(fq) for fq in found}
            return set()

    scopes = {}

    def scope_of(info, ctx):
        key = (info.rel, ctx)
        if key not in scopes:
            scopes[key] = Scope(info, ctx)
        return scopes[key]

    edges, unresolved = set(), set()
    ext_receivers = {}  # (extension fqn, file) -> receiver type simple names
    for info in infos:
        for fq, names in info.extension_receivers.items():
            ext_receivers.setdefault((fq, info.rel), set()).update(names)
    type_names = {fq.rpartition(".")[2] for fq in flat_types}

    def add(src, targets):
        targets = set(targets)
        if visible_files and len(targets) > 1:
            seen = visible_files(src)
            inside = {t for t in targets if seen is None or t in seen}
            if inside:
                targets = inside
        for t in targets:
            if t != src:
                edges.add((src, t))

    own = {}            # rel -> FQNs it declares (its own declaration wins)
    partial_types = set()
    for info in infos:
        partial_types |= info.partial
        for ns, name in info.decls:
            own.setdefault(info.rel, set()).add(join(ns, name))

    # Types are keyed by namespace.Name, so a type nested in another
    # (Outer.Sel) shares its key with a same-named one elsewhere. Where a
    # name has a top-level declaration, a mention means that one.
    nested_in = {}      # fqn -> files where it is nested
    for info in infos:
        for fq in info.nested:
            nested_in.setdefault(fq, set()).add(info.rel)

    def top_level(fq):
        files = set(lookup(fq))
        return (files - nested_in.get(fq, set())) or files

    # C# Result and Result<T> share the key Acme.Result but are different
    # types: a mention goes to the declaration whose type parameter count
    # the file writes after the name (Result<int>: Result<T>; Result: Result).
    arity_of = {}       # fqn -> {file: counts}, for names declared with several counts
    for info in infos:
        for fq, counts in info.arity.items():
            arity_of.setdefault(fq, {}).setdefault(info.rel, set()).update(counts)
    arity_of = {fq: by_file for fq, by_file in arity_of.items() if len(set().union(*by_file.values())) > 1}
    written_by = {info.rel: info.written_arity for info in infos}

    def add_types(src, fqns, written_name=False):
        """written_name: the types of a name written in src, which picks
        Result or Result<T> by what follows it; a type reached through a
        member or return type may be either."""
        files = set()
        mine = own.get(src, ())
        for fq in fqns:
            if fq in arity_of:
                by_file = arity_of[fq]
                every = set().union(*by_file.values())
                written = (written_by[src].get(fq.rpartition(".")[2]) if written_name else None) or every
                if fq in mine and (not written_name or by_file.get(src, set()) >= written):
                    continue        # its own type (with the counts the file writes)
                candidates = top_level(fq)
                files.update({f for f in candidates if by_file.get(f, set()) & written} or candidates)
                continue
            if fq in mine and fq not in partial_types:
                continue        # its own type; another copy is not a dependency
            files.update(top_level(fq))
        add(src, files)

    # Non-partial types declared in several files that can see each other.
    member_decls = set().union(*(info.member_decls for info in infos)) if infos else set()
    for fq, files in sorted(flat_types.items()):
        # Nested types of the same name are different types, not copies.
        files = files - nested_in.get(fq, set())
        if len(files) < 2 or fq in partial_types or fq in member_decls:
            continue
        counts = [c for f, c in arity_of.get(fq, {}).items() if f in files]
        if len(counts) == len(files) and all(not (a & b) for i, a in enumerate(counts) for b in counts[i + 1:]):
            continue        # Result and Result<T>: different types, not copies
        for rel in sorted(files):
            seen = visible_files(rel) if visible_files else None
            others = sorted(f for f in files if f != rel and (seen is None or f in seen))
            if others:
                unresolved.add((rel, fq, "also declared in " + ", ".join(others)
                                + "; the copies are not linked to each other, files that name it get an edge to each"))

    # Member tables, resolved lazily in the scope of the type's declaration.
    member_cache, base_cache = {}, {}

    def members_of(fqn):
        if fqn not in member_cache:
            table = {}
            key, where = declaration(fqn)
            for info in where:
                scope = scope_of(info, info.type_ns.get(key, ""))
                for name, chains in info.type_members.get(key, {}).items():
                    slot = table.setdefault(name, set())
                    for chain, elem in chains:
                        slot.update((fq, elem) for fq in scope.exact(chain.split(".")))
            member_cache[fqn] = table
        return member_cache[fqn]

    def bases_of(fqn):
        if fqn not in base_cache:
            base_cache[fqn] = set()
            found = set()
            key, where = declaration(fqn)
            for info in where:
                scope = scope_of(info, info.type_ns.get(key, ""))
                for chain in info.type_bases.get(key, ()):
                    found.update(scope.exact(chain.split(".")))
            base_cache[fqn] = found
        return base_cache[fqn]

    def closure(fqn):
        seen, todo = set(), [fqn]
        while todo:
            t = todo.pop()
            if t not in seen:
                seen.add(t)
                todo.extend(bases_of(t))
        return seen

    def member_types(current, name):
        out = set()
        for fqn, _ in current:
            for t in closure(fqn):
                out.update(members_of(t).get(name, ()))
        if not out:  # List<Order>.First(), an indexer, LINQ: pass element types on
            out = {(fq, True) for fq, elem in current if elem}
        return out

    def has_member(fqn, name):
        return any(name in members_of(t) for t in closure(fqn))

    def evaluate(scope, env, enclosing, expr):
        """(final types, every type passed) of one member-access chain."""
        kind, head, rest = expr
        passed = set()
        if kind == "new":
            current = {(fq, False) for fq in scope.exact(head.split("."))}
        elif kind == "this":
            current = {(fq, False) for fq in enclosing[:1]}
        elif kind == "base":
            current = {(fq, False) for t in enclosing[:1] for fq in bases_of(t)}
        else:
            segs = [head] + rest
            current = set()
            if head in env:
                current, rest = set(env[head]), rest
            else:
                owner = next((t for t in enclosing if has_member(t, head)), None)
                if owner:
                    current = member_types({(owner, False)}, head)
                else:
                    for k in range(len(segs), 0, -1):
                        hit = scope.exact(segs[:k])
                        if hit:
                            current, rest = {(fq, False) for fq in hit}, segs[k:]
                            break
                    else:
                        return set(), passed
        passed.update(fq for fq, _ in current)
        for name in rest:
            current = member_types(current, name)
            if not current:
                break
            passed.update(fq for fq, _ in current)
        return current, passed

    for info in infos:
        src = info.rel
        file_scope = scope_of(info, "")
        # Partial parts of one type depend on each other. VB needs Partial
        # on one part only (Form1.vb's Public Class Form1 beside the
        # designer's Partial Class Form1): every part is linked.
        for fqn in sorted(info.partial | (own.get(src, set()) & partial_types)):
            files = set(lookup(fqn))
            counts = arity_of.get(fqn, {}).get(src)
            if counts:      # partial Result<T> is not a part of Result
                files = {f for f in files if arity_of[fqn].get(f) is None or arity_of[fqn][f] & counts}
            add(src, files)
        for target in sorted(info.direct.union(*(b.direct for b in info.blocks.values()))):
            segs = target.split(".")
            fq = longest(segs)
            if fq:
                add(src, lookup(fq))
            elif ".".join(segs[:-1]) in namespaces:
                unresolved.add((src, target, "import of a type the repository package does not declare"))
        # A project-wide using static gives an edge where a member of its
        # type is named, as Run() for global using static Util.
        heads = {chain.split(".")[0] for _, chain in info.names} | info.members
        for target in sorted(info.project_static - info.direct):
            fq = longest(target.split("."))
            if fq and any(has_member(fq, name) or join(fq, name) in types for name in sorted(heads)):
                add(src, lookup(fq))
        usings = set(info.usings) | global_usings
        usings = usings.union(*(b.usings for b in info.blocks.values()))
        for u in sorted(usings):
            if lookup(u):  # Java on-demand import of a type's members, C# using of a type
                add(src, lookup(u))
        mine = {canonical[k][0]: k for k in own_nested.get(src, {}).values()}  # nested flat key -> own key
        for ctx, chain in info.names:
            owners = info.member_like.get((ctx, chain))
            if owners and all(has_member(mine.get(key, key), chain.split(".")[0]) for key in sorted(owners)):
                continue
            add_types(src, scope_of(info, ctx).mentioned(chain), written_name=True)
        if attribute_suffix:
            for ctx, chain in info.attribute_names:
                add_types(src, scope_of(info, ctx).attribute(chain), written_name=True)
        for text in info.strings:
            name = text.split(",")[0].strip()
            name = name.lower() if fold else name
            if "." in name and lookup(name):
                add(src, lookup(name))
        # Types reached through variables and member chains.
        env, saved = {}, []
        seen_vars = {}      # every variable of the file -> its types
        for step in info.flow:
            # A procedure's parameters and locals are its own: Dim order As
            # String in Sub A does not hide the class Order in Sub B.
            if step[0] == "enter":
                saved.append({var: set(types) for var, types in env.items()})
                continue
            if step[0] == "leave":
                if saved:
                    env = saved.pop()
                continue
            scope = scope_of(info, step[-1])
            if step[0] == "bind":
                _, var, enclosing, exprs, chains, foreach, _ = step
                enclosing = [mine.get(t, t) for t in enclosing]
                bound = set()
                for chain, elem in chains:
                    bound.update((fq, elem) for fq in scope.exact(chain.split(".")))
                for expr in exprs:
                    final, passed = evaluate(scope, Variables(env, seen_vars), enclosing, expr)
                    add_types(src, passed)
                    if foreach:     # the loop variable is an element
                        elems = {(fq, False) for fq, elem in final if elem}
                        final = elems or {(fq, False) for fq, _ in final}
                    bound.update(final)
                # A variable of a type the repository does not declare
                # (message As String) is still a variable: message.Length is
                # not the class Message.
                env.setdefault(var, set()).update((fq, elem) for fq, elem in bound)
                seen_vars.setdefault(var, set()).update(bound)
            else:
                _, enclosing, expr, _ = step
                enclosing = [mine.get(t, t) for t in enclosing]
                add_types(src, evaluate(scope, Variables(env, seen_vars), enclosing, expr)[1])
        # x.Name() may call an extension method of any namespace visible
        # somewhere in the file.
        visible = set(file_scope.visible)
        for ctx in sorted(info.namespaces | set(info.blocks)):
            visible |= scope_of(info, ctx).visible
        env = seen_vars
        calls = info.member_calls or {("", name) for name in info.members}
        receivers = {}      # receiver variable -> simple names of its types and their bases
        own_types = sorted(info.type_members)
        receiver_types = {}  # receiver -> fqns of its types
        for head, _ in calls:
            if head in {"this", "base"}:
                known = set(own_types)
            elif head in env:
                known = {fq for fq, elem in env[head] if not elem}
            else:       # a field or property of a type of this file (Response.WithHeader)
                owner = next((t for t in own_types if has_member(t, head)), None) if head else None
                known = {fq for fq, elem in member_types({(owner, False)}, head) if not elem} if owner else set()
            receiver_types[head] = known
            receivers[head] = {t.rpartition(".")[2] for fq in known for t in closure(fq)}
        for head, name in sorted(calls):
            if head in info.static_receivers and head not in env and not receiver_types[head]:
                continue    # File.Exists(): the static class, not a value of that name
            for ns in sorted(visible):
                fq = join(ns, name)
                files = set(extensions.get(fq, ()))
                if not files:
                    continue
                typed = {f for f in files if ext_receivers.get((fq, f))}
                if receivers.get(head) and any(has_member(t, name) for fq in receiver_types[head]
                                               for t in closure(fq)):
                    continue        # the receiver's own member: C# calls it, not an extension
                if not receivers.get(head) and src in typed:
                    # n.WithCookie().WithCookie() in the file that declares
                    # WithCookie(this Neg n): the receiver is not known, and
                    # the file's own extension is taken for it, not one on
                    # another repository type (a false cycle otherwise).
                    mine = ext_receivers[(fq, src)]
                    files -= {f for f in typed if ext_receivers[(fq, f)] & type_names
                              and not ext_receivers[(fq, f)] & mine}
                    typed &= files
                if receivers.get(head):
                    # negotiator.WithCookie() with negotiator a Negotiator:
                    # not the WithCookie(this Response r) of another file.
                    files -= {f for f in typed if ext_receivers[(fq, f)] & type_names
                              and not ext_receivers[(fq, f)] & receivers[head]}
                    typed &= files
                ambiguous = sorted(f for f in typed if name in BCL_MEMBERS
                                   and not ext_receivers[(fq, f)] & type_names)
                if ambiguous:
                    # x.Add() with an extension Add(this IDictionary<..> d)
                    # in view: x's type is not known, and the framework type
                    # has its own Add, which C# calls first. An edge to every
                    # such extension made false cycles.
                    unresolved.add((src, f".{name}()", "may call the extension method in " + ", ".join(
                        ambiguous) + " or the receiver type's own member; the receiver type is not known"))
                add(src, files - set(ambiguous))
        for ref, why in info.dynamic:
            unresolved.add((src, ref, why))

    # Imports of namespaces no file declares are external libraries. Those
    # outside the platform library are listed, one row per namespace, so an
    # in-house library left outside --root does not go unnoticed.
    standard = {s.lower() for s in standard}
    external = {}

    def outside(name):
        name = name[len(GLOBAL):] if name.startswith(GLOBAL) else name
        if not name or name in namespaces or lookup(name):
            return None
        segs = name.split(".")
        if any(".".join(segs[:k]).lower() in standard for k in range(1, len(segs) + 1)):
            return None
        return name

    def package_of(name):
        """Java: the package part of an imported or written name (the
        lower-case segments before the first type: com.acme.Util.Inner ->
        com.acme). C#/VB: the name itself."""
        if nested_lookup:
            return name
        segs = name.split(".")
        k = next((i for i, seg in enumerate(segs) if seg[:1].isupper()), len(segs))
        return ".".join(segs[:k])

    for info in infos:
        blocks = list(info.blocks.values())
        wanted = {package_of(u) for u in set(info.usings).union(*(b.usings for b in blocks))}
        for target in info.direct.union(*(b.direct for b in blocks)):
            if not longest(target.split(".")):
                wanted.add(package_of(target.rpartition(".")[0]))     # import a.b.C -> package a.b
        # A full name written inline (Acme.Billing.Invoice inv;) names its
        # namespace as an import does. Only names standing where a type
        # must are read, so a.b.c on a variable is not taken for one.
        # C#/VB: the namespace part needs two segments (or global::), as
        # Outer.Inner may be a nested type of a platform class. Java: the
        # lower-case segments before the first type.
        for ctx, chain in info.type_chains:
            if scope_of(info, ctx).mentioned(chain):
                continue
            segs, root = rooted(chain.split("."))
            if segs[0] in scope_of(info, ctx).aliases:
                continue
            if nested_lookup:
                ns = segs[:-1]
                if len(ns) < (1 if root else 2) or (not root and any(
                        p and join(p, segs[0]) in namespaces for p in prefixes(context_ns(ctx)))):
                    continue        # relative to a namespace of the repository
                if not root and segs[0].lower() in PLATFORM_CHILDREN and any(
                        u.lower() == "system" for level in scope_of(info, ctx).levels for u in level.usings):
                    continue        # Collections.Generic.List after Imports System (VB)
                wanted.add(".".join(ns))
            else:
                ns = package_of(".".join(segs))
                if ns and ns != ".".join(segs):
                    wanted.add(ns)
        for target in list(info.aliases.values()) + [t for b in blocks for t in b.aliases.values()]:
            bare = target[len(GLOBAL):] if target.startswith(GLOBAL) else target
            if "." in bare and not lookup(bare) and bare.split("<")[0] == bare:
                wanted.add(bare.rpartition(".")[0])
        for name in wanted:
            name = outside(name)
            if name:
                external.setdefault(name, set()).add(info.rel)
    for name, files in external.items():
        segs = name.split(".")
        top = next((".".join(segs[:k]) for k in range(1, len(segs)) if ".".join(segs[:k]) in external), None)
        if top:     # log4net.Config under log4net: one row for the library
            external[top] |= files
    for name, files in external.items():
        segs = name.split(".")
        if any(".".join(segs[:k]) in external for k in range(1, len(segs))):
            continue
        files = sorted(files)
        unresolved.add((files[0], name, EXTERNAL + str(len(files))))
    return edges, unresolved


def hole_expr(hole):
    """The expression of an interpolation hole without its :format. The
    format starts at the first ":" outside brackets that is not part of
    "::" (global::X); a ternary must be parenthesized there anyway."""
    depth, k, n = 0, 0, len(hole)
    while k < n:
        ch = hole[k]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch in "\"'":
            end = hole.find(ch, k + 1)
            k = n if end < 0 else end
        elif ch == ":" and depth <= 0:
            if hole.startswith("::", k):
                k += 2
                continue
            return hole[:k]
        k += 1
    return hole


def raw_holes(body, dollars):
    """Holes of a C# 11 interpolated raw string (body between the quote
    fences): with one $ a hole is {expr}, with $$ it is {{expr}}, and so on."""
    holes, k, n = [], 0, len(body)
    closer = "}" * dollars
    while k < n:
        if body[k] == "{":
            run = k
            while run < n and body[run] == "{":
                run += 1
            if run - k >= dollars:
                end = body.find(closer, run)
                if end < 0:
                    break
                holes.append(body[run:end])
                k = end + len(closer)
                continue
            k = run
            continue
        k += 1
    return holes


def strip_c_like(text, csharp=False):
    """Remove comments and string/char contents from C# or Java source.

    Returns (code, strings): code keeps its line breaks, each string literal
    becomes "" and each comment a space; strings holds the literal contents.
    C# verbatim (@"..."), raw (\"\"\"...\"\"\") and interpolated ($"...{expr}...")
    strings are understood; an interpolation hole's expression is kept as code
    so the names it mentions still count. Java text blocks are raw strings.
    C# preprocessor lines are dropped: every #if branch is mapped (see
    balance_branches for branches with unequal braces).
    """
    out, strings = [], []

    def hole_code(hole):
        """A hole's expression as code: its own literals are blanked (so
        $"{(n == 1 ? "Item" : "Items")}" names no type), nested holes kept.
        Doubled parentheses keep $"{Category}: {Name}" from reading as the
        cast (Category)(Name)."""
        code, inner = strip_c_like(hole_expr(hole), csharp)
        strings.extend(inner)
        return " ((" + code + ")) "
    i, n = 0, len(text)
    line_start = True
    while i < n:
        c = text[i]
        if csharp and line_start and c == "#":
            j = text.find("\n", i)
            word = re.match(r"#\s*(\w*)", text[i:i + 40]).group(1)
            if word in BRANCH_MARKS:
                out.append(BRANCH_MARKS[word])
            i = n if j < 0 else j
            continue
        if c in " \t":
            out.append(c)
            i += 1
            continue
        line_start = c in "\r\n"
        if c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            out.append(" ")
            continue
        if c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            end = n if j < 0 else j + 2
            out.append(" " + "\n" * text.count("\n", i, end))
            line_start = False
            i = end
            continue
        if c == "'":
            j = i + 1
            while j < n and text[j] != "'" and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            out.append("''")
            i = j + 1
            continue
        # String prefixes: C# $, @, $@, @$ (and $$ raw interpolation).
        j = i
        interp = verbatim = False
        dollars = 0
        if csharp:
            while j < n and text[j] in "$@" and j - i < 4:
                dollars += text[j] == "$"
                verbatim |= text[j] == "@"
                j += 1
            interp = dollars > 0
            if j == i or j >= n or text[j] != '"':
                j = i
                interp = verbatim = False
        if j < n and text[j] == '"':
            if text.startswith('"""', j) and not verbatim:     # @"""x"" y" is verbatim, not raw
                q = j
                while q < n and text[q] == '"':
                    q += 1
                fence = text[j:q]
                end = text.find(fence, q)
                end = n if end < 0 else end
                body = text[q:end]
                strings.append(body)
                holes = raw_holes(body, dollars) if interp else []
                out.append('""' + "".join(hole_code(h) for h in holes) + "\n" * body.count("\n"))
                i = end + len(fence)
                continue
            k = j + 1
            buf, holes = [], []
            while k < n:
                ch = text[k]
                if verbatim and ch == '"' and text.startswith('""', k):
                    buf.append('"')
                    k += 2
                    continue
                if not verbatim and ch == "\\":
                    buf.append(text[k:k + 2])
                    k += 2
                    continue
                if ch == '"' or (not verbatim and ch == "\n"):
                    break
                if interp and ch == "{":
                    if text.startswith("{{", k):
                        k += 2
                        continue
                    depth, h = 1, k + 1
                    while h < n and depth:
                        if text[h] == "{":
                            depth += 1
                        elif text[h] == "}":
                            depth -= 1
                        elif text[h] in "\"'":  # nested literal: skip it
                            h2 = text.find(text[h], h + 1)
                            h = n if h2 < 0 else h2
                        h += 1
                    holes.append(text[k + 1:h - 1])
                    k = h
                    continue
                buf.append(ch)
                k += 1
            strings.append("".join(buf))
            out.append('""' + "".join(hole_code(hole) for hole in holes))
            i = k + 1
            continue
        out.append(c)
        i += 1
    code = "".join(out)
    return (balance_branches(code) if csharp else code), strings


# #if / #elif / #else / #endif, marked in strip_c_like's output.
BRANCH_MARKS = {"if": "\x00", "elif": "\x01", "else": "\x01", "endif": "\x02"}


def balance_branches(code):
    """Every #if branch is mapped, but the branches are alternatives: when
    one leaves a brace open (#if X class A {  #else class A : B {  #endif),
    counting them all would shift every namespace after the group. Then
    only the first branch's braces count; the others keep their names,
    without braces. Groups whose branches each balance their own braces
    are kept as written. Removes the marks."""
    if "\x00" not in code:
        return code.replace("\x01", " ").replace("\x02", " ")
    top, stack = [], []         # stack: branches of each open group

    def resolve(branches):
        texts = ["".join(b) for b in branches]
        deltas = {t.count("{") - t.count("}") for t in texts}
        if len(texts) > 1 and deltas != {0}:
            texts = texts[:1] + [t.replace("{", " ").replace("}", " ") for t in texts[1:]]
        return " " + " ".join(texts)

    for piece in re.split(r"([\x00-\x02])", code):
        if piece == "\x00":
            stack.append([[]])
        elif piece == "\x01":
            if stack:
                stack[-1].append([])
        elif piece == "\x02":
            if stack:
                done = resolve(stack.pop())
                (stack[-1][-1] if stack else top).append(done)
        else:
            (stack[-1][-1] if stack else top).append(piece)
    while stack:                # an #if without #endif
        done = resolve(stack.pop())
        (stack[-1][-1] if stack else top).append(done)
    return "".join(top)


def type_written_at(code, start, end, before, declared=None):
    """Whether the dotted chain at code[start:end] stands where only a type
    can: after one of the words in before (new, extends, As, "typeof(",
    "@"), or, when declared (the words that may follow a value) is given,
    right before the name a declaration introduces (Acme.Billing.Invoice
    inv). code is in the case the words are given in."""
    if code[start] == "@" and "@" in before:     # Java @a.b.Ann (the chain starts at @)
        return True
    k = start - 1
    while k >= 0 and code[k].isspace():
        k -= 1
    if k >= 0 and code[k] == "(":
        j = k - 1
        while j >= 0 and code[j].isspace():
            j -= 1
        w = j
        while w >= 0 and (code[w].isalnum() or code[w] == "_"):
            w -= 1
        if code[w + 1:j + 1] + "(" in before:
            return True
    elif k >= 0 and (code[k].isalnum() or code[k] == "_"):
        w = k
        while w >= 0 and (code[w].isalnum() or code[w] == "_"):
            w -= 1
        if (w < 0 or code[w] != ".") and code[w + 1:k + 1] in before:
            return True
    elif k >= 0 and code[k] in before:
        return True
    if declared is None:
        return False
    k = end
    while k < len(code) and code[k].isspace():
        k += 1
    if code[k:k + 1] == "[":        # Acme.Billing.Invoice[] all
        j = k + 1
        while j < len(code) and code[j] in " \t\r\n,":
            j += 1
        if code[j:j + 1] != "]":
            return False
        k = j + 1
        while k < len(code) and code[k].isspace():
            k += 1
    m = re.compile(r"[^\W\d]\w*").match(code, k)
    return bool(m) and m.group(0) not in declared


def list_item_starts(code, heads, stop_words=()):
    """Offsets of the items of the type lists that follow each match of the
    regex heads (C# "class X :", Java extends/implements/throws): the
    list's first item and each item after a comma at its own level. A list
    ends at { ; = or one of stop_words, or at a > or ) it did not open
    (<T extends A, U>)."""
    out = set()
    for m in heads.finditer(code):
        k, depth, item = m.end(), 0, True
        while k < len(code):
            c = code[k]
            if c.isspace():
                k += 1
                continue
            if item and depth == 0:
                out.add(k)
                item = False
            if c in "<([":
                depth += 1
            elif c in ">)]":
                if depth == 0:
                    break
                depth -= 1
            elif c in "{;=" and depth == 0:
                break
            elif c == "," and depth == 0:
                item = True
            elif c.isalpha() and (k == 0 or not (code[k - 1].isalnum() or code[k - 1] == "_")):
                w = re.match(r"\w+", code[k:]).group(0)
                if depth == 0 and w in stop_words:
                    break
                k += len(w)
                continue
            k += 1
    return out


def enum_member_offsets(toks, java=False):
    """Start offsets of the member names in enum bodies (enum Kind { Customer,
    Order = 2 }): declarations, not references to the types Customer and
    Order. toks: (text, start, end). Java constants end at the first ";" of
    the body; a name after = or inside ( ) is an expression, except a bare
    name of a sibling member (Both = Order | Customer; Java: also in a
    constant's arguments, Bar(Gadget)). A Java annotation on a constant
    (@Ann A, @Ann(x) A) is a reference, and the constant after it a member."""
    out = set()
    i, n = 0, len(toks)
    while i < n:
        if toks[i][0] != "enum" or (i and toks[i - 1][0] == "."):
            i += 1
            continue
        j = i + 1
        while j < n and toks[j][0] not in {"{", ";"}:
            j += 1
        if j >= n or toks[j][0] != "{":
            i = j
            continue
        depth, k = 0, j
        names, values, openers = set(), [], []
        after_annotation = -1   # index of the token after @a.b.Ann (without arguments)
        while k < n:
            t = toks[k][0]
            if depth == 1 and java and t[0] == "@" and len(t) > 1 and t != "@interface":
                # @Ann, @a.b.Ann, @Ann(x) before a constant: a reference.
                k += 1
                while k + 1 < n and toks[k][0] == "." and (toks[k + 1][0][0].isalpha() or toks[k + 1][0][0] == "_"):
                    k += 2
                after_annotation = k
                continue
            if t in {"{", "(", "["}:
                depth += 1
                openers.append(t)
            elif t in {"}", ")", "]"}:
                depth -= 1
                openers.pop()
                if depth == 0:
                    break
            elif depth == 1 and t == ";":
                break           # Java: the constants end, members follow
            elif (depth == 1 or java and depth == 2 and openers[-1] == "(") and (t[0].isalpha() or t[0] in "_@"):
                prev = toks[k - 1][0]
                if depth == 1 and (prev in {"{", ",", "]", ")"} or k == after_annotation):
                    out.add(toks[k][1])
                    names.add(t.lstrip("@"))
                elif prev != "." and (k + 1 >= n or toks[k + 1][0] != "."):
                    values.append(k)
            k += 1
        out.update(toks[v][1] for v in values if toks[v][0].lstrip("@") in names)
        i = k + 1
    return out


TOKEN_RE = re.compile(r"@?[^\W\d]\w*|\S")
CHAIN_RE = re.compile(r"(?:global::)?@?[^\W\d]\w*(?:\s*(?:\.|::)\s*@?[^\W\d]\w*)*")


# Members of common framework types (object, string, collections,
# dictionaries, LINQ, streams, StringBuilder). x.Name() with one of these
# names usually calls that member: an extension method of the same name on
# a framework type is only a candidate.
BCL_MEMBERS = set("""Add AddRange Remove RemoveAt RemoveAll RemoveRange Clear Contains ContainsKey
ContainsValue Insert InsertRange IndexOf LastIndexOf Find FindAll FindIndex Exists TrueForAll ForEach
Sort Reverse ToArray ToList ToDictionary ToLookup ToHashSet CopyTo TryGetValue TryAdd GetValueOrDefault
GetEnumerator Equals GetHashCode ToString GetType CompareTo Clone Dispose Close Flush Read Write
ReadLine WriteLine ReadToEnd Seek Append AppendLine AppendFormat Replace Trim TrimStart TrimEnd
Split Substring StartsWith EndsWith PadLeft PadRight ToUpper ToLower ToUpperInvariant
ToLowerInvariant Format Join Concat Normalize IsNormalized Select SelectMany Where OrderBy
OrderByDescending ThenBy ThenByDescending GroupBy First FirstOrDefault Last LastOrDefault Single
SingleOrDefault Any All Count LongCount Sum Min Max Average Aggregate Distinct Skip Take SkipWhile
TakeWhile Zip Cast OfType Union Intersect Except Concat DefaultIfEmpty ElementAt ElementAtOrDefault
SequenceEqual AsEnumerable AsQueryable HasFlag GetValue SetValue Invoke BeginInvoke EndInvoke
Wait ContinueWith Push Pop Peek Enqueue Dequeue""".split())


def chains(code, keywords, fold=False):
    """Dotted name chains in code, minus those headed by a language keyword."""
    return [name for _, name in chains_at(code, keywords, fold)]


def chains_at(code, keywords, fold=False):
    """(offset, chain) of every dotted name chain chains() reports."""
    out = []
    for m in CHAIN_RE.finditer(code):
        start = m.start()
        # A chain right after "." continues a call or index result
        # (f().Bar): member access on a value, not a type name.
        k = start - 1
        while k >= 0 and code[k] in " \t\r\n":
            k -= 1
        if k >= 0 and code[k] == ".":
            continue
        name = dotted(m.group(0), fold)
        # this.X, base.X, string.Join...: a value or a built-in, not a type.
        if name.split(".")[0] not in keywords:
            out.append((start, name))
    return out


MEMBER_RE = re.compile(r"\.\s*@?([^\W\d]\w*)")


def members(code, fold=False):
    """Names written after a dot: candidates for extension method calls."""
    return {m.group(1).lower() if fold else m.group(1) for m in MEMBER_RE.finditer(code)}


# ---------------------------------------------------------------------------
# Type flow: types used without their name being written.
#
# `var x = Factory.Create(); x.Run();` names Factory but not the type Create
# returns. Declarations do name it, so each file also reports, per declared
# type, its members' declared types and its base types, plus a list of
# statements: variable bindings (`var x = expr`, `Foo x`, parameters,
# foreach) and member-access chains (`a.B().C`). The resolver evaluates the
# chains against the member table and makes an edge to every type a chain
# passes through. Types written as generic arguments (List<Order>) are
# "element" types: a member the resolver cannot find on the container (an
# external List, LINQ's First(), an indexer) passes them through.
# Variables are tracked per file, not per method: one name used in two
# methods gets both types (extra edges, never fewer).
# ---------------------------------------------------------------------------

PREDEFINED = set("""bool byte sbyte char decimal double float int uint long ulong short ushort
object string void dynamic nint nuint boolean""".split())


def is_ident(tok):
    return bool(tok) and (tok[0].isalpha() or tok[0] == "_" or (tok[0] == "@" and len(tok) > 1)) and not tok.startswith("@interface")


MAX_GENERIC_DEPTH = 64     # deeper <...> is not read as a type (parsing it is quadratic)


class Variables:
    """The variables in view (env), helped by those of the file's other
    procedures: when one in view has no known type, or a name is not in
    view (an inherited field typed by a type parameter, protected P
    project), a same-named variable of known type elsewhere in the file
    usually has that type. A variable of unknown type in another procedure
    (Dim order As String in another Sub) does not hide a type of that name."""

    def __init__(self, env, others):
        self.env, self.others = env, others

    def __contains__(self, name):
        return name in self.env or bool(self.others.get(name))

    def __getitem__(self, name):
        if self.env.get(name):
            return self.env[name]
        return self.others.get(name) or self.env[name]


def parse_type(toks, i, keywords, depth=0):
    """Type expression at toks[i]: (chains, end) or None. chains holds
    (dotted name, is_element) for the type and its generic arguments."""
    n = len(toks)
    if i >= n or depth > MAX_GENERIC_DEPTH:
        return None
    t = toks[i]
    root = global_at(toks, i)
    if root:
        i += 3
        t = toks[i]
    if t in PREDEFINED and not root:
        j, chains = i + 1, []
    else:
        if not is_ident(t) or t in keywords:
            return None
        segs = [(GLOBAL if root else "") + t.lstrip("@")]
        j = i + 1
        while j + 1 < n and toks[j] == "." and is_ident(toks[j + 1]) and toks[j + 1] not in keywords:
            segs.append(toks[j + 1].lstrip("@"))
            j += 2
        chains = [(".".join(segs), False)]
    if j < n and toks[j] == "<":
        k = j + 1
        while True:
            if toks[k:k + 1] == ["?"] and toks[k + 1:k + 2] in ([","], [">"]):
                inner = ([], k + 1)     # Java wildcard: Project<?, ?>
            else:
                if toks[k:k + 1] == ["?"] and toks[k + 1:k + 2] in (["extends"], ["super"]):
                    k += 2              # List<? extends Item>
                inner = parse_type(toks, k, keywords, depth + 1)
            if inner is None:
                return None
            chains += [(c, True) for c, _ in inner[0]]
            k = inner[1]
            if k < n and toks[k] == ",":
                k += 1
                continue
            if k < n and toks[k] == ">":
                j = k + 1
                break
            return None
    while j < n:
        if toks[j] == "?":
            j += 1
        elif toks[j] == "[" and j + 1 < n and toks[j + 1] in {"]", ","}:
            k = j + 1
            while k < n and toks[k] == ",":
                k += 1
            if k >= n or toks[k] != "]":
                break
            j = k + 1
        else:
            break
    if t in PREDEFINED and not chains:
        return [], j
    return chains, j


def global_at(toks, i):
    """Whether toks[i:] starts with C#'s global:: (followed by a name)."""
    return toks[i] == "global" and i + 3 < len(toks) and toks[i + 1] == ":" and toks[i + 2] == ":" \
        and is_ident(toks[i + 3])


def skip_balanced(toks, i):
    """toks[i] opens ( [ or {; return the index after its closing token."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    close, level = pairs[toks[i]], 0
    opener = toks[i]
    n = len(toks)
    while i < n:
        if toks[i] == opener:
            level += 1
        elif toks[i] == close:
            level -= 1
            if level == 0:
                return i + 1
        i += 1
    return n


def parse_expr(toks, i, keywords):
    """Member-access chain starting at toks[i]: ((kind, head, members), end)
    or None. kind is "new" (head = type name), "this", "base" or "name"."""
    n = len(toks)
    t = toks[i]
    members = []
    if t == "new":
        parsed = parse_type(toks, i + 1, keywords)
        if not parsed or not parsed[0]:
            return None
        head, j = parsed[0][0][0], parsed[1]
        if j < n and toks[j] in {"(", "{"}:
            j = skip_balanced(toks, j)
        kind = "new"
    elif global_at(toks, i):
        kind, head, j = "name", GLOBAL + toks[i + 3].lstrip("@"), i + 4
    elif t in {"this", "base", "super", "me", "mybase"}:
        kind, head, j = {"me": "this", "mybase": "base", "super": "base"}.get(t, t), "", i + 1
    elif is_ident(t) and t not in keywords:
        kind, head, j = "name", t.lstrip("@"), i + 1
    else:
        return None
    while j < n:
        if toks[j] == "(":
            j = skip_balanced(toks, j)
            continue
        if toks[j] == "[":      # indexer: its declared type, or the element type
            j = skip_balanced(toks, j)
            members.append("[]")
            continue
        if toks[j] == "<":
            # Generic method call: Foo<Bar>(...)
            k = j + 1
            ok = False
            while k < n and toks[k] != ">":
                if not (is_ident(toks[k]) or toks[k] in {",", ".", "<", "[", "]", "?"}):
                    break
                k += 1
            ok = k + 1 < n and toks[k] == ">" and toks[k + 1] == "("
            if ok:
                j = k + 1
                continue
            break
        if toks[j] == "!" and j + 1 < n and toks[j + 1] == ".":
            j += 1
            continue
        if toks[j] == "?" and j + 1 < n and toks[j + 1] == ".":
            j += 1
            continue
        if toks[j] == "." and j + 1 < n and is_ident(toks[j + 1]):
            members.append(toks[j + 1].lstrip("@"))
            j += 2
            continue
        break
    return (kind, head, members), j


def flow_c_like(toks, keywords, language, package=""):
    """Member table, base types and flow statements of one C# or Java file.

    Returns (members, bases, flow, type_ns):
      members: {type fqn: {member: [(chain, is_element)]}}
      bases:   {type fqn: [chain]}
      flow:    [("bind", var, enclosing, exprs, chains, foreach, context)
                | ("use", enclosing, expr, context)
                | ("enter",) | ("leave",)], in source order; enter and leave
               bracket a member's parameters and body
      type_ns: {type fqn: context the type is declared in}
    A context is the namespace, or for C# code inside a namespace block,
    the namespace and the block's number (BLOCK), counted as scan counts them.
    """
    n = len(toks)
    members, bases, flow, type_ns = {}, {}, [], {}
    depth, paren = 0, 0
    ns_stack, file_ns = [], package     # ns_stack: (name, depth, block number)
    blocks = 0
    file_block = None       # block number of a file-scoped namespace (namespace N;)
    type_stack = []         # (fqn, depth of its body)
    enums = set()
    pending = None

    def namespace():
        return ".".join(p for p in [file_ns] + [x for x, _, _ in ns_stack] if p)

    def context():
        if ns_stack:
            return f"{namespace()}{BLOCK}{ns_stack[-1][2]}"
        return f"{namespace()}{BLOCK}{file_block}" if file_block else namespace()

    def enclosing():
        return [fqn for fqn, _ in reversed(type_stack)]

    proc = None     # None, "params" (a member's parameter list or initializer) or its body depth
    i = 0
    while i < n:
        t = toks[i]
        prev = toks[i - 1] if i else ";"
        at_body = type_stack and depth == type_stack[-1][1] and paren == 0 and type_stack[-1][0] not in enums
        if t == "{":
            if at_body and not pending and proc in {None, "params"}:
                if proc is None:
                    flow.append(("enter",))
                proc = depth + 1    # a method, accessor or initializer body
            depth += 1
            if pending:
                type_stack.append((pending, depth))
                pending = None
            i += 1
            continue
        if at_body and proc is None and t in {"(", "="} and not pending:
            flow.append(("enter",))
            proc = "params"
        elif at_body and proc == "params" and t == ";":
            flow.append(("leave",))
            proc = None
        # Enum members: { Red, [Description("b")] Blue = 2 } (global using
        # static Colors; Red).
        if type_stack and type_stack[-1][0] in enums and depth == type_stack[-1][1] \
                and prev in {"{", ",", "]"} and is_ident(t) and toks[i + 1:i + 2] and toks[i + 1] in {",", "}", "="}:
            members[type_stack[-1][0]].setdefault(t.lstrip("@"), [])
        if t == "}":
            if proc == depth or (proc == "params" and type_stack and type_stack[-1][1] == depth):
                flow.append(("leave",))
                proc = None
            if type_stack and type_stack[-1][1] == depth:
                type_stack.pop()
            depth -= 1
            while ns_stack and ns_stack[-1][1] >= depth:
                ns_stack.pop()
            i += 1
            continue
        if t == "(":
            paren += 1
        elif t == ")":
            paren = max(0, paren - 1)
        elif t == ";":
            pending = None      # record X(...); has no body
        if language == "csharp" and t == "namespace":
            segs, j = [], i + 1
            while j < n and is_ident(toks[j]):
                segs.append(toks[j])
                if j + 1 < n and toks[j + 1] == ".":
                    j += 2
                    continue
                j += 1
                break
            if j < n and toks[j] == ";":
                # Numbered like scan()'s blocks: its usings belong to it.
                file_ns = ".".join(segs)
                blocks += 1
                file_block = blocks
            else:
                blocks += 1
                ns_stack.append((".".join(segs), depth, blocks))
            i = j
            continue
        if t in {"class", "struct", "interface", "enum", "record", "@interface"} and prev not in {".", ":", ",", "<", "(", "new", "where"} \
                and i + 1 < n:
            j = i + 1
            if t == "record" and toks[j] in {"class", "struct"}:
                j += 1
            if j < n and is_ident(toks[j]) and toks[j] not in keywords:
                fqn = join(namespace(), toks[j].lstrip("@"))
                pending = fqn
                members.setdefault(fqn, {})
                if t == "enum":
                    enums.add(fqn)
                type_ns.setdefault(fqn, context())
                j += 1
                if j < n and toks[j] == "<":
                    level = 0
                    while j < n:
                        level += {"<": 1, ">": -1}.get(toks[j], 0)
                        j += 1
                        if level == 0:
                            break
                if j < n and toks[j] == "(":       # record parameters
                    j = skip_balanced(toks, j)
                if j < n and toks[j] in {":", "extends", "implements"}:
                    j += 1
                    while j < n and toks[j] not in {"{", ";", "where"}:
                        if toks[j] in {",", "implements", "extends"}:
                            j += 1
                            continue
                        parsed = parse_type(toks, j, keywords)
                        if not parsed:
                            j += 1
                            continue
                        bases.setdefault(fqn, []).extend(c for c, elem in parsed[0] if not elem)
                        j = max(parsed[1], j + 1)
                        if j < n and toks[j] == "(":   # record base arguments
                            j = skip_balanced(toks, j)
                i = j
                continue
        # var x = expr; foreach (var x in expr); for (var x : expr)
        if t == "var" and i + 2 < n and is_ident(toks[i + 1]) and toks[i + 2] in {"=", "in", ":"}:
            name = toks[i + 1].lstrip("@")
            k = i + 3
            if k < n and toks[k] == "await":
                k += 1
            parsed = parse_expr(toks, k, keywords) if k < n else None
            # var c = x as IContent; var s = (ISessionFactory)conf.Build(): the type written
            cast = parse_type(toks, k + 1, keywords) if k + 1 < n and toks[k] == "(" else None
            if cast and not (cast[1] + 1 < n and toks[cast[1]] == ")"
                             and (is_ident(toks[cast[1] + 1]) or toks[cast[1] + 1] in {"(", "this", "base", "new"})):
                cast = None
            if not cast and parsed and parsed[1] < n and toks[parsed[1]] == "as":
                cast = parse_type(toks, parsed[1] + 1, keywords)
            if cast and toks[i + 2] == "=":
                flow.append(("bind", name, enclosing(), [], cast[0], False, context()))
            elif parsed:
                flow.append(("bind", name, enclosing(), [parsed[0]], [], toks[i + 2] != "=", context()))
            i += 2
            continue
        # The name after global:: was read with the global (as a root-qualified name).
        after_global = i >= 3 and prev == ":" and toks[i - 2] == ":" and toks[i - 3] == "global"
        # Declarations: Type name followed by = ; , ) ( { => : in
        # new IScopeUnitOfWork GetUnitOfWork(); in a type body: the new modifier
        modifier_new = prev == "new" and type_stack and depth == type_stack[-1][1] and paren == 0
        if (is_ident(t) and t not in keywords or t in PREDEFINED or global_at(toks, i)) \
                and (prev not in {".", "new"} or modifier_new) and not after_global:
            parsed = parse_type(toks, i, keywords)
            if parsed and parsed[1] < n - 1:
                chains, j = parsed
                name, after = toks[j], toks[j + 1]
                in_body = type_stack and depth == type_stack[-1][1] and paren == 0
                if in_body and name == "this" and after == "[":     # indexer
                    members[type_stack[-1][0]].setdefault("[]", []).extend(chains)
                    i = j
                    continue
                if is_ident(name) and name not in keywords and (
                        after in {"=", ";", ",", ")", ":", "in"} or (in_body and after in {"(", "{", "<"})
                        or (not in_body and after in {"&", "|"})):   # x is Foo f && ...
                    name = name.lstrip("@")
                    if in_body:
                        members[type_stack[-1][0]].setdefault(name, []).extend(chains)
                    else:   # string message too: message is then a variable, not a type
                        flow.append(("bind", name, enclosing(), [], chains, False, context()))
                    i = j       # continue at the declared name
                    continue
        if prev not in {".", "?"} and not after_global and (
                t in {"new", "this", "base", "super"} or (is_ident(t) and t not in keywords) or global_at(toks, i)):
            parsed = parse_expr(toks, i, keywords)
            if parsed and (parsed[0][2] or parsed[0][0] == "new"):
                flow.append(("use", enclosing(), parsed[0], context()))
        i += 1
    return members, bases, flow, type_ns
