#!/usr/bin/env python3
"""Build and assemble a verified, project-independent Overleaf rtex runtime."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import stat
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ['dist/server.mjs', 'dist/adapter.mjs', 'public/index.html', 'public/app.js',
          'public/integration.js', 'public/pdf.worker.mjs',
          'deployment/watch-project-settings.cjs', 'COPYING', 'NOTICE', 'vendor/LICENSE',
          'docs/DEPENDENCY_LICENSES.json']
INTEGRATION = ['cursor-position.js', 'launcher.js', 'math-construction.js', 'native-consumer.js',
               'overleaf-browser-hook.js', 'panel-lifecycle.js', 'project-entry.js',
               'socket-client.js', 'source-text.js', 'startup-validation.js']
PROTECTED = ['src', 'dist', 'public', 'integration', 'deployment', 'docs', 'vendor', 'engine', 'tests', 'node_modules']


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Expected regular file: ' + str(path))
    for parent in path.parents:
        if parent.is_symlink():
            raise ValueError('Symlinked parent directory: ' + str(parent))
    return path.read_bytes()


def digest(path):
    return hashlib.sha256(regular(path)).hexdigest()


def inventory(root):
    result = {}
    def visit(directory):
        for child in sorted(directory.iterdir()):
            if child.is_symlink():
                raise ValueError('Symlinks are not permitted in runtime inputs: ' + str(child))
            if child.is_dir(): visit(child)
            elif child.is_file(): result[child.relative_to(root).as_posix()] = digest(child)
            else: raise ValueError('Special file is not permitted: ' + str(child))
    visit(root)
    return result


def below(path, ancestor):
    return path == ancestor or ancestor in path.parents


def output_path(root, engine, output):
    root = root.resolve(strict=True)
    engine = engine.resolve(strict=True)
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError('Output must be a new directory')
    for parent in output.parents:
        if parent.is_symlink():
            raise ValueError('Output may not traverse a symlink')
    output = output.resolve()
    if below(root, output) or below(engine, output) or below(output, engine):
        raise ValueError('Output overlaps source repository or engine runtime')
    for name in PROTECTED:
        if below(output, root / name):
            raise ValueError('Output overlaps a source/input directory: ' + name)
    return output


def check_elf(data):
    if len(data) < 64 or data[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', data, 18)[0] != 62:
        raise ValueError('Engine must be a Linux ELF64 little-endian x86-64 executable')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    if size < 56 or not 0 < count < 1024 or offset + size * count > len(data):
        raise ValueError('Invalid ELF program header table')
    for i in range(count):
        base = offset + i * size
        kind = struct.unpack_from('<I', data, base)[0]
        if kind == 3: raise ValueError('Portable musl engine must not require a dynamic interpreter')
        if kind == 2:
            start = struct.unpack_from('<Q', data, base + 8)[0]
            length = struct.unpack_from('<Q', data, base + 32)[0]
            if length % 16 or start + length > len(data): raise ValueError('Invalid ELF dynamic table')
            for at in range(start, start + length, 16):
                tag = struct.unpack_from('<q', data, at)[0]
                if tag == 0: break
                if tag == 1: raise ValueError('Portable musl engine must not require dynamic libraries')


def verify_engine(root, engine):
    pins = json.loads(regular(root / 'engine/candidate-pins.json'))
    manifest = json.loads(regular(engine / 'build-manifest.json'))
    if manifest.get('schemaVersion') != 1: raise ValueError('Unknown engine build manifest schema')
    for name in ['upstreamCommit', 'patchSHA256', 'sourceSHA256', 'supportSHA256']:
        if manifest.get(name) != pins[name]: raise ValueError('Engine manifest does not match reviewed ' + name)
    if manifest.get('target') != 'x86_64-unknown-linux-musl' or manifest.get('profile') != 'dist':
        raise ValueError('Expected the supported Linux x86-64 static musl distribution build')
    if manifest.get('rustToolchain') != '1.99.1': raise ValueError('Unexpected engine Rust toolchain')
    if digest(root / 'engine/overleaf-v0.0.6.patch') != pins['patchSHA256']:
        raise ValueError('Reviewed engine patch differs from its pin')
    notices = manifest.get('noticesSHA256')
    if not isinstance(notices, dict) or 'notices/THIRD_PARTY.json' not in notices:
        raise ValueError('Engine runtime requires collected dependency notices')
    for name, value in notices.items():
        parts = PurePosixPath(name).parts
        if not parts or parts[0] != 'notices' or len(parts) < 2 or any(x in ('.', '..') for x in parts) or PurePosixPath(name).as_posix() != name or not re.fullmatch('[a-f0-9]{64}', value):
            raise ValueError('Invalid engine notice path/hash')
    files = inventory(engine)
    expected = {'bin/rtex', 'LICENSE.rtex', 'build-manifest.json'} | {'tex/' + name for name in pins['supportSHA256']} | set(notices)
    if set(files) != expected: raise ValueError('Engine runtime file inventory differs from the exact package contract')
    for name, value in notices.items():
        if files[name] != value: raise ValueError('Engine dependency notice differs: ' + name)
    notice_index = json.loads(regular(engine / 'notices/THIRD_PARTY.json'))
    if notice_index.get('schema') != 1 or notice_index.get('upstreamCommit') != pins['upstreamCommit'] or notice_index.get('cargoLockSHA256') != pins['sourceSHA256']['Cargo.lock'] or notice_index.get('target') != manifest['target'] or not isinstance(notice_index.get('reviewRequired'), list):
        raise ValueError('Engine notice manifest provenance differs')
    binary = manifest.get('binary', {})
    data = regular(engine / 'bin/rtex')
    if binary.get('path') != 'bin/rtex' or binary.get('SHA256') != files['bin/rtex'] or binary.get('bytes') != len(data):
        raise ValueError('Engine binary differs from its build manifest')
    if not (engine / 'bin/rtex').stat().st_mode & stat.S_IXUSR: raise ValueError('Engine binary must be executable')
    check_elf(data)
    for name, expected_hash in pins['supportSHA256'].items():
        if files['tex/' + name] != expected_hash: raise ValueError('Engine support differs: ' + name)
    if regular(engine / 'LICENSE.rtex') != regular(root / 'docs/licenses/realtime-tex-v0.0.6-MIT.txt'):
        raise ValueError('Engine MIT license differs from the reviewed upstream notice')
    return manifest


def assemble(root, engine, output):
    root, engine = Path(root).absolute(), Path(engine).absolute()
    if engine.is_symlink(): raise ValueError('Engine runtime may not be a symlink')
    output = output_path(root, engine, Path(output))
    manifest = verify_engine(root, engine)
    sources = {name: root / name for name in ASSETS}
    sources.update({'integration/' + name: root / 'integration' / name for name in INTEGRATION})
    licenses = inventory(root / 'docs/licenses')
    sources.update({'docs/licenses/' + name: root / 'docs/licenses' / name for name in licenses})
    sources['engine-build-manifest.json'] = engine / 'build-manifest.json'
    sources['deployment/runtime-linux/bin/rtex'] = engine / 'bin/rtex'
    sources['deployment/runtime-linux/LICENSE.rtex'] = engine / 'LICENSE.rtex'
    sources.update({'deployment/runtime-linux/' + name: engine / name for name in manifest['noticesSHA256']})
    sources.update({'deployment/runtime-support/tex/' + name: engine / 'tex' / name for name in manifest['supportSHA256']})
    # Read all inputs first. Every byte written below comes from this validated
    # snapshot, so a concurrent build cannot mix old/new files mid-copy.
    snapshot = {name: regular(path) for name, path in sources.items()}
    if hashlib.sha256(snapshot['deployment/runtime-linux/bin/rtex']).hexdigest() != manifest['binary']['SHA256']:
        raise ValueError('Engine binary changed during package preparation')
    for name, expected in manifest['noticesSHA256'].items():
        if hashlib.sha256(snapshot['deployment/runtime-linux/' + name]).hexdigest() != expected:
            raise ValueError('Engine dependency notice changed during package preparation')
    if json.loads(snapshot['engine-build-manifest.json']) != manifest:
        raise ValueError('Engine build manifest changed during package preparation')
    for name, expected in manifest['supportSHA256'].items():
        if hashlib.sha256(snapshot['deployment/runtime-support/tex/' + name]).hexdigest() != expected:
            raise ValueError('Engine support changed during package preparation')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.' + output.name + '-', dir=output.parent))
    try:
        for name, data in snapshot.items():
            target = temporary / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if name == 'deployment/runtime-linux/bin/rtex' else 0o644)
        files = inventory(temporary)
        package = {'schema': 1, 'engine': {'upstreamCommit': manifest['upstreamCommit'],
                   'patchSHA256': manifest['patchSHA256'], 'target': manifest['target'],
                   'binarySHA256': manifest['binary']['SHA256'], 'thirdPartyNoticesSHA256': manifest['noticesSHA256']['notices/THIRD_PARTY.json'], 'supportSHA256': manifest['supportSHA256']},
                   'files': files}
        (temporary / 'runtime-manifest.json').write_text(json.dumps(package, sort_keys=True, indent=2) + '\n')
        if output.exists(): raise ValueError('Output appeared while packaging; refusing to overwrite')
        temporary.rename(output)
    finally:
        if temporary.exists(): shutil.rmtree(temporary)
    return package


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--engine-runtime', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--node', default='node', help='Node.js executable used to rebuild all bridge/browser bundles')
    a = p.parse_args()
    try:
        output_path(ROOT, a.engine_runtime, a.output)
        verify_engine(ROOT, a.engine_runtime)
        subprocess.run([a.node, 'build.mjs'], cwd=ROOT, check=True)
        result = assemble(ROOT, a.engine_runtime, a.output)
        print(json.dumps({'packaged': True, 'output': str(a.output.resolve()), 'files': len(result['files']), 'engine': result['engine']}))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print('Runtime package failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__': raise SystemExit(main())
