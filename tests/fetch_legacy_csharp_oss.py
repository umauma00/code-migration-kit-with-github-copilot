#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Prepare a disposable OSS corpus for the 00b/02 transport verification.

Usage:
  python3 tests/fetch_legacy_csharp_oss.py --out /tmp/new-csharp-corpus --normalize-cp1252
  node tests/verify_legacy_csharp_oss.mjs /tmp/new-csharp-corpus

The destination must not already exist. Archives are pinned by commit and by
the observed archive digest; source archives and extracted original bytes are
retained. GitHub may change archive packing, in which case verify the tree and
the new archive digest before updating the manifest. No downloaded source is
executed. The optional conversion is for transport testing only: cp1252 (with
Latin-1 fallback) is an explicit assumption for unmarked non-UTF-8 files, not
proof of their original encoding or semantic correctness.
"""
import argparse
import codecs
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import time
import urllib.request

SUFFIXES = {'.cs', '.csproj', '.vbproj', '.fsproj', '.sln', '.props', '.targets', '.config'}
MANIFEST = Path(__file__).with_name('legacy-csharp-corpus.json')


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def selected(relative):
    name = relative.name.lower()
    return relative.suffix.lower() in SUFFIXES or (name.startswith(('license', 'copying', 'notice')) and relative.suffix.lower() in {'', '.txt', '.md', '.rst', '.html'})


def fetch(root, project):
    started = time.monotonic()
    base = root / project['id']
    base.mkdir()
    archive = base / 'source.tar.gz'
    url = f"https://codeload.github.com/{project['repository']}/tar.gz/{project['commit']}"
    total = 0
    print(f"{project['id']}: downloading pinned source", flush=True)
    with urllib.request.urlopen(url) as response, archive.open('xb') as output:
        for block in iter(lambda: response.read(1024 * 1024), b''):
            output.write(block)
            total += len(block)
            if total % (16 * 1024 * 1024) == 0:
                print(f"{project['id']}: downloaded {total // (1024 * 1024)} MiB", flush=True)
    digest = sha256(archive)
    if digest != project['archiveSha256']:
        raise ValueError(f"{project['id']}: archive SHA-256 differs from the recorded download: {digest}; verify the pinned tree before updating the manifest")
    destination = base / 'project' / 'source'
    destination.mkdir(parents=True)
    count = skipped = 0
    csharp = []
    with tarfile.open(archive, 'r:gz') as source:
        for entry in source:
            archive_path = PurePosixPath(entry.name)
            pieces = archive_path.parts[1:]
            if archive_path.is_absolute() or not pieces or any(p in ('..', '.') for p in pieces) or not entry.isfile():
                continue
            relative = PurePosixPath(*pieces)
            if not selected(relative):
                skipped += 1
                continue
            output = destination.joinpath(*pieces)
            output.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(entry) as incoming, output.open('xb') as outgoing:
                shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
            count += 1
            if relative.suffix.lower() == '.cs':
                csharp.append({'file': relative.as_posix(), 'bytes': output.stat().st_size})
    summary = {**project, 'url': url, 'archiveSha256': digest, 'archiveBytes': total,
               'selectedFiles': count, 'csharpFiles': len(csharp), 'csharpBytes': sum(f['bytes'] for f in csharp),
               'largestCsharp': sorted(csharp, key=lambda f: (-f['bytes'], f['file']))[:10],
               'excludedOtherFiles': skipped, 'selectionSuffixes': sorted(SUFFIXES),
               'seconds': round(time.monotonic() - started, 3)}
    (base / 'provenance.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary), flush=True)
    return summary


def normalize(root, meta):
    base = root / meta['id']
    source, destination = base / 'project' / 'source', base / 'utf8-project' / 'source'
    destination.mkdir(parents=True, exist_ok=False)
    conversions, counts = [], {}
    for file in sorted(source.rglob('*')):
        if file.is_symlink():
            raise ValueError(f'Symlink in extracted sources: {file}')
        if not file.is_file():
            continue
        relative, data = file.relative_to(source), file.read_bytes()
        try:
            text = data.decode('utf-8')
            if '\0' in text:
                raise ValueError('NUL')
            encoding = 'utf-8'
        except (UnicodeError, ValueError):
            encoding = None
            for mark, name in [(codecs.BOM_UTF32_LE, 'utf-32'), (codecs.BOM_UTF32_BE, 'utf-32'), (codecs.BOM_UTF16_LE, 'utf-16'), (codecs.BOM_UTF16_BE, 'utf-16')]:
                if data.startswith(mark):
                    encoding, text = name, data.decode(name)
                    break
            if encoding is None:
                encoding = 'cp1252'
                try:
                    text = data.decode(encoding)
                except UnicodeDecodeError:
                    encoding, text = 'latin-1', data.decode('latin-1')
                if text.encode(encoding) != data:
                    raise ValueError(f'Encoding does not round-trip: {relative}')
            if '\0' in text:
                raise ValueError(f'Binary input cannot be normalized: {relative}')
        counts[encoding] = counts.get(encoding, 0) + 1
        output = destination / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        encoded = data if encoding == 'utf-8' else text.encode('utf-8')
        with output.open('xb') as stream:
            stream.write(encoded)
        if encoding != 'utf-8':
            conversions.append({'file': relative.as_posix(), 'sourceEncodingAssumption': encoding,
                                'originalSha256': hashlib.sha256(data).hexdigest(), 'utf8Sha256': hashlib.sha256(encoded).hexdigest(),
                                'originalBytes': len(data), 'utf8Bytes': len(encoded)})
    result = {'project': meta['id'], 'scope': 'C# sources and project/config/license text; no binaries or markup assets',
              'counts': counts, 'convertedFiles': len(conversions),
              'convertedCsharpFiles': sum(f['file'].lower().endswith('.cs') for f in conversions), 'conversions': conversions,
              'semanticEncodingReview': 'not performed; fallback encoding is an explicit transport-only assumption', 'originalsModified': False}
    (base / 'normalization.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'conversions'}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path, help='new, disposable output directory; existing directories are never overwritten')
    parser.add_argument('--normalize-cp1252', action='store_true', help='also make UTF-8 test copies; assumes CP1252 for unmarked non-UTF-8 input (Latin-1 fallback)')
    args = parser.parse_args()
    root = args.out.absolute()
    try:
        root.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        parser.error(f'output already exists; choose a new directory: {root}')
    projects = json.loads(MANIFEST.read_text(encoding='utf-8'))
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(lambda p: fetch(root, p), projects))
    (root / 'corpus.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    if args.normalize_cp1252:
        for project in results:
            normalize(root, project)


if __name__ == '__main__':
    main()
