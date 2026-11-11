#!/usr/bin/env python3
"""Read-only checks of the public source, optional Git index and matching release."""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import sys
import tarfile

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('privacy_release', Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def require(value, message):
    if not value:
        raise ValueError(message)


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL)


def private_rules(path):
    if path is None:
        return [], set()
    path = Path(path).absolute()
    require(path.resolve(strict=True) == path, 'Canonical private denylist required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 512 * 1024,
                'Owned mode0600 private denylist required')
        data = json.loads(stream.read())
    require(isinstance(data, dict) and set(data) <= {'terms', 'tokenSHA256'}, 'Invalid private rules')
    terms, hashes = data.get('terms', []), data.get('tokenSHA256', [])
    require(isinstance(terms, list) and len(terms) <= 1024 and
            all(isinstance(t, str) and 3 <= len(t) <= 256 for t in terms), 'Invalid private terms')
    require(isinstance(hashes, list) and len(hashes) <= 1024 and
            all(isinstance(h, str) and re.fullmatch('[a-f0-9]{64}', h) for h in hashes), 'Invalid private hashes')
    return [t.encode().lower() for t in terms], set(hashes)


def audit(root, git_index=False, archive=None, denylist=None):
    root = Path(root).resolve(strict=True)
    files = release.snapshot(root)
    terms, hashes = private_rules(denylist)
    for name, item in files.items():
        data = name.encode() + b'\n' + item['data']
        require(not any(term in data.lower() for term in terms), 'Private term matched; value redacted')
        require(not any(hashlib.sha256(t.lower()).hexdigest() in hashes
                        for t in re.findall(rb'[A-Za-z0-9]{8,64}', data)), 'Private fingerprint matched; value redacted')
        require(not re.search(rb'\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b', data),
                'Private network address requires review')
        require(not re.search(rb'(?i)(?:ssh|mongodb(?:\+srv)?|redis|postgres(?:ql)?|mysql)://[^\s/:@]+:[^\s/@]+@', data),
                'Embedded service credentials refused')
    if git_index:
        require(Path(git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == root,
                'Exact repository root required')
        staged = {}
        for item in git(root, 'ls-files', '--stage', '-z').split(b'\0'):
            if not item:
                continue
            info, name = item.split(b'\t', 1)
            mode, oid, stage = info.split()
            name = name.decode('utf-8')
            require(stage == b'0' and mode in (b'100644', b'100755'), 'Nonregular or unmerged index entry')
            require(re.fullmatch(rb'(?:[0-9a-f]{40}|[0-9a-f]{64})', oid), 'Invalid object identity')
            require(name not in staged and release.permitted(name), 'Unapproved tracked path')
            staged[name] = git(root, 'cat-file', 'blob', oid.decode())
        require(set(staged) == set(files), 'Index and reviewed source inventory differ')
        require(all(staged[n] == item['data'] for n, item in files.items()), 'Staged bytes differ from inspected source')
    if archive:
        archive = Path(archive).resolve(strict=True)
        package = archive / 'source.tar.gz'
        require(not package.is_symlink() and package.is_file() and package.stat().st_size <= 64 * 1024 * 1024,
                'Invalid source archive size/type')
        # Bound decompression before the structural verifier reads tar members.
        try:
            with gzip.open(package, 'rb') as stream:
                require(len(stream.read(64 * 1024 * 1024 + 1)) <= 64 * 1024 * 1024, 'Oversized expanded source archive')
        except (OSError, EOFError):
            raise ValueError('Unreadable source archive') from None
        manifest = release.verify_release(archive)
        require(set(manifest['files']) == set(files), 'Archive and reviewed source inventory differ')
        require(all(hashlib.sha256(item['data']).hexdigest() == manifest['files'][n]['sha256']
                    for n, item in files.items()), 'Archive source differs from inspected source')
    return {'passed': True, 'sourceFiles': len(files), 'gitIndexChecked': bool(git_index),
            'matchingArchiveChecked': bool(archive), 'privateDenylistChecked': denylist is not None, 'valuesPrinted': False,
            'scope': 'Allowlisted source and selected artifacts; not a vulnerability or complete privacy audit'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--git-index', action='store_true')
    p.add_argument('--archive', type=Path, help='Directory containing source.tar.gz, filemanifest.json and SHA256SUMS')
    p.add_argument('--denylist', type=Path, help='Local-only owned mode0600 JSON with terms/tokenSHA256; never publish this file')
    a = p.parse_args()
    try:
        print(json.dumps(audit(a.root, a.git_index, a.archive, a.denylist)))
    except (OSError, ValueError, KeyError, EOFError, tarfile.TarError, subprocess.SubprocessError, UnicodeError):
        print('Privacy audit refused: source scan, index or archive checks failed. No matched values are printed.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
