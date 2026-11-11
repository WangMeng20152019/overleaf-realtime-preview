#!/usr/bin/env python3
"""Create and verify a deterministic, explicitly allowlisted source release."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'.gitignore', 'README.md', 'README.en.md', 'CHANGELOG.md', 'COPYING', 'NOTICE', 'THIRD_PARTY.md',
              'package.json', 'package-lock.json', 'build.mjs'}
PREVIEW_FILES = {'README.md', 'index.html', 'client.ts', 'run.mjs',
                 'text-sequence.ts', 'owned-insertions.ts', 'math-construction.ts'}
REQUIRED = (ROOT_FILES - {'README.en.md', 'CHANGELOG.md'}) | {'src/server.ts', 'src/browser.ts', 'vendor/LICENSE',
    'integration/launcher.js', 'integration/source-patch/rtex-bridge.ts',
    'deployment/install.py', 'deployment/service.py', 'deployment/package.py',
    'public/index.html', 'fixtures/main.tex', 'examples/compose.yml',
    'engine/build.py', 'engine/notices.py', 'engine/overleaf-v0.0.6.patch',
    'engine/candidate-pins.json', 'engine/upstream-source.json'}
SKIP_DIRS = {'.git', '.local', 'node_modules', 'dist', 'artifacts', 'trials', 'state',
             '__pycache__', '.runtime', 'target', 'build'}
ALLOWLIST = [
    'Root: .gitignore, README.md, optional README.en.md/CHANGELOG.md, COPYING, NOTICE, THIRD_PARTY.md, package.json, package-lock.json, build.mjs',
    'src/**/*.ts; vendor/{src,webview}/**/*.ts; vendor/LICENSE',
    'integration/*.js; integration/source-patch/*.{py,ts}',
    'deployment/*.{py,cjs}; deployment/config.example.json',
    'public/index.html; fixtures/main.tex; examples/compose.yml',
    'tests/*.test.mjs; tests/test_*.py; tests/overleaf-fixture.mjs',
    'dev/preview: README.md, index.html, client.ts, run.mjs, text-sequence.ts, owned-insertions.ts, math-construction.ts',
    'engine/*.{py,json,patch,md}',
    'docs/**/*.{md,json}; docs/licenses/**/{LICENSE,COPYING,NOTICE,MIT,APACHE,COPYRIGHT}-named texts; optional docs/images/preview.png',
    '.github/{workflows,ISSUE_TEMPLATE}/*.{yml,yaml,md}',
]
EXCLUDED_CATEGORIES = sorted(SKIP_DIRS | {'private config/env files', 'generated public JavaScript/PDF worker',
    'generated preview client/build-info/self-test', 'engine binaries/Cargo caches', 'project data and trial folders'})
# No maintainer-specific identifier or derived fingerprint belongs in public source.
# Private identifiers are supplied locally to privacy-audit.py, never shipped here.
PRIVATE_TOKEN_HASHES = set()


def digest(data): return hashlib.sha256(data).hexdigest()


def permitted(name):
    p = Path(name)
    parts = p.parts
    if not parts or any(x in SKIP_DIRS or x.startswith('.project-') for x in parts): return False
    if name in ROOT_FILES: return True
    if parts[0] == 'src': return p.suffix == '.ts'
    if name == 'vendor/LICENSE': return True
    if len(parts) >= 3 and parts[:2] in [('vendor', 'src'), ('vendor', 'webview')]: return p.suffix == '.ts'
    if len(parts) == 2 and parts[0] == 'integration': return p.suffix == '.js'
    if len(parts) == 3 and parts[:2] == ('integration', 'source-patch'): return p.suffix in {'.py', '.ts'}
    if len(parts) == 2 and parts[0] == 'deployment': return p.suffix in {'.py', '.cjs'} or name == 'deployment/config.example.json'
    if name in {'public/index.html', 'fixtures/main.tex', 'examples/compose.yml'}: return True
    if len(parts) == 2 and parts[0] == 'tests': return p.name.endswith('.test.mjs') or (p.name.startswith('test_') and p.suffix == '.py') or p.name == 'overleaf-fixture.mjs'
    if len(parts) == 3 and parts[:2] == ('dev', 'preview'): return p.name in PREVIEW_FILES
    if len(parts) == 2 and parts[0] == 'engine': return p.suffix in {'.py', '.json', '.patch', '.md'}
    if parts[0] == 'docs':
        if name == 'docs/images/preview.png': return True
        if len(parts) >= 3 and parts[1] == 'licenses': return bool(re.search(r'LICENSE|COPYING|NOTICE|MIT|APACHE|COPYRIGHT', p.name, re.I))
        return p.suffix in {'.md', '.json'} and 'images' not in parts
    return len(parts) == 3 and parts[0] == '.github' and parts[1] in {'workflows', 'ISSUE_TEMPLATE'} and p.suffix in {'.yml', '.yaml', '.md'}


def select(root):
    selected = {}
    def visit(directory):
        for path in sorted(directory.iterdir()):
            name = path.relative_to(root).as_posix()
            if path.name in SKIP_DIRS or path.name.startswith('.project-'): continue
            if path.is_symlink(): raise ValueError('Source input symlink is not permitted')
            if path.is_dir(): visit(path)
            elif path.is_file() and permitted(name): selected[name] = path
            elif not path.is_file(): raise ValueError('Special source input is not permitted')
    for name in sorted(ROOT_FILES):
        path = root / name
        if path.is_symlink(): raise ValueError('Source input symlink is not permitted')
        if path.is_file(): selected[name] = path
    for name in ['src', 'vendor', 'integration', 'deployment', 'public', 'fixtures', 'tests', 'dev', 'engine', 'docs', 'examples', '.github']:
        path = root / name
        if path.is_symlink(): raise ValueError('Source input directory symlink is not permitted')
        if path.is_dir(): visit(path)
    missing = REQUIRED - set(selected)
    if missing: raise ValueError('Required publication inputs are missing: ' + ', '.join(sorted(missing)))
    return dict(sorted(selected.items()))


RULES = [
    ('personal-workstation-path', re.compile(rb'/' + rb'Users/' + rb'[A-Za-z0-9_.-]+')),
    ('private-key-material', re.compile(rb'-----BEGIN ' + rb'(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----')),
    ('other-private-key-material', re.compile(rb'-----BEGIN ' + rb'PGP PRIVATE KEY BLOCK-----|PuTTY-User-Key-File-[23]:')),
    ('github-token', re.compile(rb'\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b')),
    ('aws-access-key', re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b')),
    ('slack-token', re.compile(rb'\bxox[baprs]-[A-Za-z0-9-]{20,}\b')),
    ('embedded-bearer-token', re.compile(rb'\bBearer[ \t]+[A-Za-z0-9_.+/=-]{16,}', re.I)),
    ('embedded-jwt', re.compile(rb'\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b')),
    ('credential-in-url', re.compile(rb'https?://[^\s/:@]+:[^\s/@]+@', re.I)),
]
ASSIGNMENT = re.compile(rb'''(?i)\b[A-Za-z0-9_-]*?(?:password|passwd|secret|token|api[_-]?key|secret[_-]?(?:access[_-]?)?key|private[_-]?key)\b["']?\s*[:=]\s*["']([^"'\r\n]+)["']''')
PLACEHOLDERS = {b'session', b'token', b'secret', b'password', b'example', b'redacted', b'changeme',
                b'test-token', b'test-secret', b'fixture-token', b'fixture-secret', b'synthetic-token',
                b'not-a-secret', b'demo-token', b'unused', b'token-a', b'token-b', b'acl-token', b't', b'x'}


def sensitive_rule(data):
    for label, expression in RULES:
        if expression.search(data): return label
    for token in re.findall(rb'[A-Za-z0-9]{8,64}', data):
        if digest(token.lower()) in PRIVATE_TOKEN_HASHES: return 'known-private-host-or-project'
    for match in ASSIGNMENT.finditer(data):
        value = match.group(1).strip()
        quote = data[match.start(1) - 1:match.start(1)]
        header = data[match.start():match.start(1) - 1]
        # A same-quote KEY= fragment inside a source string has just closed;
        # its following concatenation is code, not a quoted credential value.
        # Quoted JSON keys retain their closing quote in header and still scan.
        if data[match.start() - 1:match.start()] == quote and quote not in header:
            continue
        if value.lower() in PLACEHOLDERS: continue
        if any(re.fullmatch(pattern, value) for pattern in [rb'\$\{[A-Za-z_][A-Za-z0-9_.]*\}', rb'<[A-Z][A-Z0-9_ -]*>', rb'REPLACE_[A-Z0-9_]+']): continue
        return 'literal-credential-assignment'
    return None


def snapshot(root):
    result = {}
    for name, path in select(root).items():
        if sensitive_rule(name.encode()): raise ValueError('Publication blocked: sensitive filename (value redacted)')
        if path.is_symlink() or not path.is_file(): raise ValueError('Source input changed to a nonregular file')
        if path.stat().st_size > 16 * 1024 * 1024: raise ValueError('Publication input is oversized: ' + name)
        data = path.read_bytes()
        rule = sensitive_rule(data)
        if rule: raise ValueError('Publication blocked: ' + rule + ' in ' + name + ' (value redacted)')
        if name == 'docs/images/preview.png':
            if not data.startswith(b'\x89PNG\r\n\x1a\n'): raise ValueError('Preview image must be PNG')
            offset = 8
            while offset < len(data):
                if offset + 12 > len(data): raise ValueError('Invalid preview PNG')
                length = int.from_bytes(data[offset:offset + 4], 'big')
                kind = data[offset + 4:offset + 8]
                if kind in {b'tEXt', b'zTXt', b'iTXt', b'eXIf'}: raise ValueError('Preview PNG contains textual/private metadata')
                offset += length + 12
            if offset != len(data): raise ValueError('Invalid preview PNG length')
        else:
            try: data.decode('utf-8')
            except UnicodeDecodeError: raise ValueError('Nontext file is outside the source-release contract: ' + name)
        result[name] = {'data': data, 'mode': 0o755 if data.startswith(b'#!') else 0o644}
    return result


def version_root(version):
    if len(version) > 100 or not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?', version):
        raise ValueError('Version must be a safe semantic version')
    prerelease = version.split('+', 1)[0].partition('-')[2]
    if any(part.isdigit() and len(part) > 1 and part.startswith('0') for part in prerelease.split('.')):
        raise ValueError('Version must be a safe semantic version')
    return 'overleaf-realtime-' + version


def archive_bytes(files, prefix):
    tar_bytes = io.BytesIO()
    with tarfile.open(fileobj=tar_bytes, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name, item in files.items():
            member = tarfile.TarInfo(prefix + '/' + name)
            member.size = len(item['data'])
            member.uid = member.gid = member.mtime = 0
            member.uname = member.gname = ''
            member.mode = item['mode']
            archive.addfile(member, io.BytesIO(item['data']))
    compressed = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', compresslevel=9, fileobj=compressed, mtime=0) as stream:
        stream.write(tar_bytes.getvalue())
    return compressed.getvalue()


def verify_archive(data, manifest):
    if manifest.get('schema') != 1 or manifest.get('archiveRoot') != version_root(manifest['version']):
        raise ValueError('Source archive manifest/version differs')
    if manifest.get('sourceFileCount') != len(manifest['files']) or list(manifest['files']) != sorted(manifest['files']):
        raise ValueError('Source archive manifest inventory differs')
    for name in manifest['files']:
        if PurePosixPath(name).is_absolute() or any(part in ('.', '..') for part in PurePosixPath(name).parts) or PurePosixPath(name).as_posix() != name or not permitted(name):
            raise ValueError('Source archive contains a nonpublic or unsafe path')
    if len(data) < 10 or data[:4] != b'\x1f\x8b\x08\x00' or data[4:8] != b'\0' * 4:
        raise ValueError('Source archive gzip header differs')
    if digest(data) != manifest['archiveSHA256']: raise ValueError('Source archive SHA256 differs')
    prefix = manifest['archiveRoot'] + '/'
    expected = list(manifest['files'])
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if [m.name for m in members] != [prefix + name for name in expected]: raise ValueError('Source archive member inventory differs')
        for member, name in zip(members, expected):
            info = manifest['files'][name]
            if not member.isfile() or member.uid != 0 or member.gid != 0 or member.mtime != 0 or member.uname or member.gname or member.mode != info['mode']:
                raise ValueError('Source archive metadata differs')
            content = archive.extractfile(member).read()
            if len(content) != info['bytes'] or digest(content) != info['sha256']: raise ValueError('Source archive member bytes differ')
    return True


def verify_release(directory):
    directory = Path(directory)
    if set(p.name for p in directory.iterdir()) != {'source.tar.gz', 'SHA256SUMS', 'filemanifest.json'}:
        raise ValueError('Source release output inventory differs')
    for path in directory.iterdir():
        if path.is_symlink() or not path.is_file(): raise ValueError('Source release files must be regular')
    manifest_data = (directory / 'filemanifest.json').read_bytes()
    manifest = json.loads(manifest_data)
    data = (directory / 'source.tar.gz').read_bytes()
    verify_archive(data, manifest)
    expected_sums = digest(manifest_data) + '  filemanifest.json\n' + digest(data) + '  source.tar.gz\n'
    if (directory / 'SHA256SUMS').read_text() != expected_sums: raise ValueError('Source release checksum list differs')
    return manifest


def create_release(root, output, version):
    prefix = version_root(version)
    root = Path(root).resolve(strict=True)
    output = Path(output)
    if output.exists() or output.is_symlink(): raise ValueError('Release output must be a new directory')
    output = output.resolve()
    if output == root or output in root.parents: raise ValueError('Release output overlaps the source repository')
    if root in output.parents and output.relative_to(root).parts[0] != '.local':
        raise ValueError('In-repository release outputs must be inside excluded .local/')
    files = snapshot(root)
    data = archive_bytes(files, prefix)
    manifest = {'schema': 1, 'version': version, 'archiveRoot': prefix, 'archiveSHA256': digest(data),
                'sourceFileCount': len(files), 'publicationAllowlist': ALLOWLIST,
                'excludedCategories': EXCLUDED_CATEGORIES, 'previewImageIncluded': 'docs/images/preview.png' in files,
                'patternScanPassed': True,
                'files': {name: {'sha256': digest(item['data']), 'bytes': len(item['data']), 'mode': item['mode']} for name, item in files.items()}}
    verify_archive(data, manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.' + output.name + '-', dir=output.parent))
    try:
        (temporary / 'source.tar.gz').write_bytes(data)
        manifest_data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
        (temporary / 'filemanifest.json').write_bytes(manifest_data)
        (temporary / 'SHA256SUMS').write_text(digest(manifest_data) + '  filemanifest.json\n' + digest(data) + '  source.tar.gz\n')
        verify_release(temporary)
        if output.exists(): raise ValueError('Release output appeared while packaging; refusing overwrite')
        temporary.rename(output)
    finally:
        if temporary.exists(): shutil.rmtree(temporary)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    try:
        result = create_release(ROOT, args.output, args.version)
        print(json.dumps({'created': True, 'version': result['version'], 'sourceFiles': result['sourceFileCount'],
                          'archiveSHA256': result['archiveSHA256'], 'previewImageIncluded': result['previewImageIncluded']}))
    except (ValueError, OSError, tarfile.TarError, EOFError) as error:
        parser.exit(1, 'Source release failed: ' + str(error) + '\n')


if __name__ == '__main__': main()
