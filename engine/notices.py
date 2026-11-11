"""Collect real license notices from checksum-verified, locked Cargo archives."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

KNOWN_LICENSES = {'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Zlib',
                  'Unlicense', 'Unicode-3.0', 'ISC', 'BSL-1.0'}


def sha(data): return hashlib.sha256(data).hexdigest()


def lock_packages(source):
    # The caller first verifies this exact reviewed Cargo.lock SHA256. These
    # basic string fields are the only lockfile data needed for archive pins.
    packages = {}
    for block in (source / 'Cargo.lock').read_text().split('[[package]]')[1:]:
        values = {}
        for key in ['name', 'version', 'source', 'checksum']:
            match = re.search(r'^' + key + r' = ("[^\n"]*")$', block, re.M)
            if match: values[key] = json.loads(match.group(1))
        if values.get('source'):
            packages[(values['name'], values['version'], values['source'])] = values.get('checksum')
    return packages


def collect(source, cargo, env, target, sysroot, output, upstream_commit):
    result = subprocess.run([str(cargo), 'metadata', '--locked', '--filter-platform', target,
                             '--format-version', '1'], cwd=source, env=env, check=True,
                            stdout=subprocess.PIPE, text=True)
    metadata = json.loads(result.stdout)
    packages = {p['id']: p for p in metadata['packages']}
    # metadata resolves workspace-wide optional features. Cargo tree with an
    # explicit package selects the same normal/build feature graph as our build.
    tree = subprocess.run([str(cargo), 'tree', '--locked', '--target', target,
                           '-p', 'rtex-cli', '--edges', 'normal,build', '--prefix', 'none',
                           '--format', '{p}', '--no-dedupe'], cwd=source, env=env,
                          check=True, stdout=subprocess.PIPE, text=True).stdout
    identities = set()
    for line in tree.splitlines():
        match = re.fullmatch(r'([A-Za-z0-9_-]+) v([^\s]+)(?: .*)?', line)
        if not match: raise ValueError('Unexpected Cargo target tree entry')
        identities.add((match.group(1), match.group(2)))
    selected = set()
    for identity in identities:
        matches = [key for key, value in packages.items() if (value['name'], value['version']) == identity]
        if len(matches) != 1: raise ValueError('Ambiguous/missing Cargo tree package identity')
        selected.add(matches[0])
    locked = lock_packages(source)
    cache = Path(env.get('CARGO_HOME', str(Path.home() / '.cargo'))) / 'registry' / 'cache'
    output.mkdir()
    records, unknown = [], []
    for p in sorted((packages[k] for k in selected if packages[k]['source']), key=lambda x: (x['name'], x['version'])):
        identity = (p['name'], p['version'], p['source'])
        checksum = locked.get(identity)
        if not checksum or not p['source'].startswith('registry+'):
            raise ValueError('Unpinned/nonregistry engine dependency: ' + p['name'])
        manifest = Path(p['manifest_path'])
        archive = cache / manifest.parent.parent.name / (p['name'] + '-' + p['version'] + '.crate')
        if archive.is_symlink() or not archive.is_file() or sha(archive.read_bytes()) != checksum:
            raise ValueError('Dependency archive differs from Cargo.lock: ' + p['name'])
        prefix = p['name'] + '-' + p['version']
        found, archived_manifest = {}, None
        declared_file = p.get('license_file')
        if declared_file:
            try: declared_file = Path(declared_file).relative_to(manifest.parent).as_posix()
            except ValueError: raise ValueError('License path escapes crate: ' + p['name'])
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar:
                parts = PurePosixPath(member.name).parts
                if not parts or parts[0] != prefix or any(x in ('.', '..') for x in parts):
                    raise ValueError('Unsafe path in locked crate archive')
                if not member.isfile() or len(parts) < 2: continue
                relative = PurePosixPath(*parts[1:]).as_posix()
                if relative == 'Cargo.toml': archived_manifest = tar.extractfile(member).read()
                name = parts[-1].upper()
                if name.startswith(('LICENSE', 'NOTICE', 'COPYING', 'COPYRIGHT')) or relative == declared_file:
                    if member.size > 4 * 1024 * 1024: raise ValueError('Oversized crate notice')
                    data = tar.extractfile(member).read()
                    path = PurePosixPath('crates', prefix, relative).as_posix()
                    if path in found: raise ValueError('Duplicate crate notice')
                    destination = output / path
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                    found[path] = sha(data)
        if archived_manifest != manifest.read_bytes():
            raise ValueError('Cached Cargo manifest differs from checksum-verified archive: ' + p['name'])
        declared = p.get('license')
        tokens = set(re.findall(r'[A-Za-z0-9.+-]+', declared or '')) - {'AND', 'OR', 'WITH'}
        reasons = []
        if not declared: reasons.append('No declared license expression')
        if tokens - KNOWN_LICENSES: reasons.append('Unreviewed license identifier(s): ' + ', '.join(sorted(tokens - KNOWN_LICENSES)))
        if not found: reasons.append('No license/notice text included in the locked crate archive')
        if reasons: unknown.append({'name': p['name'], 'version': p['version'], 'reasons': reasons})
        records.append({'name': p['name'], 'version': p['version'], 'declaredLicense': declared,
                        'source': p['source'], 'archiveSHA256': checksum,
                        'manifestSHA256': sha(archived_manifest), 'noticeFiles': found})
    rust_doc = sysroot / 'share' / 'doc' / 'rust'
    rust_sources = [rust_doc / 'COPYRIGHT-library.html'] + sorted((rust_doc / 'licenses').iterdir())
    rust_files = {}
    for path in rust_sources:
        if path.is_symlink() or not path.is_file(): raise ValueError('Missing/nonregular Rust standard-library notice')
        relative = PurePosixPath('rust-standard-library', path.relative_to(rust_doc).as_posix()).as_posix()
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        data = path.read_bytes()
        destination.write_bytes(data)
        rust_files[relative] = sha(data)
    receipt = {'schema': 1, 'upstreamCommit': upstream_commit, 'target': target,
               'cargoLockSHA256': sha((source / 'Cargo.lock').read_bytes()),
               'collectionMethod': 'cargo tree --locked --target TARGET -p rtex-cli --edges normal,build --prefix none --format {p} --no-dedupe',
               'selectedTargetPackages': [{'name': name, 'version': version} for name, version in sorted(identities)],
               'allLockedRegistryPackageCount': len(locked),
               'excludedWorkspaceResolvedRegistryPackages': [{'name': p['name'], 'version': p['version']} for p in sorted(packages.values(), key=lambda x: (x['name'], x['version'])) if p['source'] and (p['name'], p['version']) not in identities],
               'scope': 'Target-specific rtex-cli normal/build dependency closure; development-only edges and unselected workspace optional features excluded. Actual notice texts only, never dependency implementation files. Rust standard-library copyright bundle and its supplied license corpus included conservatively.',
               'crates': records, 'rustStandardLibrary': {'toolchain': '1.99.1', 'files': rust_files},
               'reviewRequired': unknown}
    (output / 'THIRD_PARTY.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
    return {'notices/' + p.relative_to(output).as_posix(): sha(p.read_bytes()) for p in sorted(output.rglob('*')) if p.is_file()}
