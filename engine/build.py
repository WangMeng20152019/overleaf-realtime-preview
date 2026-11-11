#!/usr/bin/env python3
"""Prepare verified downstream rtex source and build a portable runtime directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from notices import collect as collect_notices

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / 'candidate-pins.json').read_text())
UPSTREAM = 'https://github.com/HenryXiaoYang/realtime-tex.git'
TOOLCHAIN = '1.99.1'
SOURCE = json.loads((HERE / 'upstream-source.json').read_text())
if SOURCE['commit'] != PINS['upstreamCommit']:
    raise ValueError('Source archive provenance and engine pins disagree')


def run(args, cwd=None, env=None, capture=False):
    return subprocess.run([str(x) for x in args], cwd=cwd, env=env, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


def sha(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Expected regular file: ' + str(path))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_files(root, expected):
    for name, digest in expected.items():
        if sha(root / name) != digest:
            raise ValueError('Pinned file differs: ' + name)


def verify(source):
    if run(['git', 'rev-parse', 'HEAD^{tree}'], source, capture=True).strip() != SOURCE['tree']:
        raise ValueError('Source baseline differs from pinned upstream Git tree')
    if sha(HERE / 'overleaf-v0.0.6.patch') != PINS['patchSHA256']:
        raise ValueError('Downstream patch hash differs')
    check_files(source, PINS['sourceSHA256'])
    check_files(source / 'tex', PINS['supportSHA256'])
    expected = run(['git', 'diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], source, capture=True)
    # Compare every tracked byte against a freshly generated pinned patch, rather
    # than accepting arbitrary extra modifications in an otherwise valid checkout.
    if expected.encode() != (HERE / 'overleaf-v0.0.6.patch').read_bytes():
        raise ValueError('Working tree differs from the exact reviewed downstream patch')
    if run(['git', 'ls-files', '--others'], source, capture=True).strip():
        raise ValueError('Unexpected untracked source files')


def prepare(args):
    destination = args.workdir.resolve()
    if destination.exists():
        raise ValueError('Work directory already exists; use a new empty path')
    destination.mkdir(parents=True)
    source = destination / 'source'
    source.mkdir()
    run(['git', 'init', '--quiet', source])
    if args.archive or args.download_archive:
        archive = destination / 'upstream.tar.gz'
        if args.archive:
            data = Path(args.archive).read_bytes()
        else:
            with urllib.request.urlopen(SOURCE['archiveURL'], timeout=60) as response:
                data = response.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != SOURCE['archiveSHA256']:
            raise ValueError('Official source archive differs from pinned SHA256')
        archive.write_bytes(data)
        total, seen = 0, set()
        prefix = 'realtime-tex-' + PINS['upstreamCommit']
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar:
                parts = PurePosixPath(member.name).parts
                if not parts or parts[0] != prefix or any(x in ('..', '.') for x in parts):
                    raise ValueError('Unsafe archive path')
                if member.isdir(): continue
                if not member.isfile() or len(parts) < 2: raise ValueError('Nonregular source archive member')
                name = Path(*parts[1:])
                if name in seen: raise ValueError('Duplicate archive path')
                seen.add(name)
                total += member.size
                if total > 128 * 1024 * 1024: raise ValueError('Expanded source archive is oversized')
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        run(['git', 'add', '--all'], source)
        if run(['git', 'write-tree'], source, capture=True).strip() != SOURCE['tree']:
            raise ValueError('Source archive file tree differs from pinned upstream commit tree')
        run(['git', '-c', 'user.name=Reproducible source archive', '-c', 'user.email=source-archive@example.invalid',
             'commit', '--quiet', '-m', 'Pinned upstream source archive'], source)
    else:
        repository = args.repository or UPSTREAM
        repository = str(Path(repository).resolve()) if Path(repository).exists() else repository
        run(['git', 'fetch', '--depth=1', repository, PINS['upstreamCommit']], source)
        run(['git', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], source)
        if run(['git', 'rev-parse', 'HEAD'], source, capture=True).strip() != PINS['upstreamCommit']:
            raise ValueError('Fetched commit differs from requested upstream revision')
    if sha(HERE / 'overleaf-v0.0.6.patch') != PINS['patchSHA256']:
        raise ValueError('Downstream patch hash differs')
    run(['git', 'apply', '--check', HERE / 'overleaf-v0.0.6.patch'], source)
    run(['git', 'apply', HERE / 'overleaf-v0.0.6.patch'], source)
    verify(source)
    print(json.dumps({'prepared': True, 'commit': PINS['upstreamCommit'], 'workdir': str(destination)}))


def build(args):
    work = args.workdir.resolve(strict=True)
    source = work / 'source'
    verify(source)
    cargo = Path(os.path.abspath(args.cargo or shutil.which('cargo') or ''))
    if not cargo.is_file():
        raise ValueError('Install rustup with Cargo, then install Rust ' + TOOLCHAIN)
    rustup = cargo.parent / 'rustup'
    if not rustup.is_file():
        raise ValueError('Cargo must be managed by rustup (rustup expected beside Cargo)')
    env = os.environ.copy()
    env['RUSTUP_TOOLCHAIN'] = TOOLCHAIN
    env['CARGO_TARGET_DIR'] = str(work / 'target')
    env.pop('RUSTC', None)
    env.pop('RUSTC_WRAPPER', None)
    env.pop('RUSTC_WORKSPACE_WRAPPER', None)
    env.pop('RUSTFLAGS', None)
    env.pop('CARGO_ENCODED_RUSTFLAGS', None)
    rustc = run([rustup, 'run', TOOLCHAIN, 'rustc', '-vV'], env=env, capture=True)
    if not rustc.startswith('rustc ' + TOOLCHAIN + ' '):
        raise ValueError('Unexpected compiler version: ' + rustc.splitlines()[0])
    host = next(line[6:] for line in rustc.splitlines() if line.startswith('host: '))
    target = host if args.target == 'native' else args.target
    if target != host and target != 'x86_64-unknown-linux-musl':
        raise ValueError('Supported targets are native host or x86_64-unknown-linux-musl')
    profile = 'dist' if target == 'x86_64-unknown-linux-musl' else 'release'
    sysroot = Path(run([rustup, 'run', TOOLCHAIN, 'rustc', '--print', 'sysroot'], env=env, capture=True).strip())
    cargo_home = Path(env.get('CARGO_HOME', str(Path.home() / '.cargo'))).resolve()
    flags = ['--remap-path-prefix=' + str(source) + '=/rtex-source',
             '--remap-path-prefix=' + str(cargo_home) + '=/rtex-cargo',
             '--remap-path-prefix=' + str(sysroot) + '=/rtex-rust']
    if target == 'x86_64-unknown-linux-musl':
        linker = sysroot / 'lib' / 'rustlib' / host / 'bin' / 'rust-lld'
        if not linker.is_file():
            raise ValueError('rust-lld is required for the static musl build')
        env['CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER'] = str(linker)
        flags.extend(['-C', 'link-self-contained=yes'])
    env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(flags)
    output = work / ('runtime-' + target)
    if output.exists():
        raise ValueError('Runtime output already exists; remove it explicitly before rebuilding')
    run([cargo, 'build', '--locked', '--profile', profile, '--target', target, '-p', 'rtex-cli'], source, env)
    verify(source)
    executable = work / 'target' / target / profile / 'rtex'
    output.mkdir()
    (output / 'bin').mkdir()
    shutil.copy2(executable, output / 'bin' / 'rtex')
    for name in PINS['supportSHA256']:
        target_file = output / 'tex' / name
        target_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / 'tex' / name, target_file)
    shutil.copy2(source / 'LICENSE', output / 'LICENSE.rtex')
    manifest = {'schemaVersion': 1, 'upstreamRepository': UPSTREAM,
                'upstreamCommit': PINS['upstreamCommit'], 'upstreamTree': SOURCE['tree'], 'patchSHA256': PINS['patchSHA256'],
                'sourceSHA256': PINS['sourceSHA256'], 'supportSHA256': PINS['supportSHA256'],
                'target': target, 'profile': profile, 'rustToolchain': TOOLCHAIN,
                'rustc': rustc, 'pathRemapping': True, 'cargo': run([cargo, '--version'], env=env, capture=True).strip(),
                'binary': {'path': 'bin/rtex', 'SHA256': sha(output / 'bin' / 'rtex'),
                           'bytes': (output / 'bin' / 'rtex').stat().st_size},
                'targetExecutionVerified': False}
    manifest['noticesSHA256'] = collect_notices(source, cargo, env, target, sysroot, output / 'notices', PINS['upstreamCommit'])
    (output / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    check_files(output / 'tex', PINS['supportSHA256'])
    print(json.dumps({'built': True, 'runtime': str(output), 'binarySHA256': manifest['binary']['SHA256']}))



def attach_notices(args):
    work = args.workdir.resolve(strict=True)
    source = work / 'source'
    verify(source)
    runtime = args.runtime.resolve(strict=True)
    manifest_path = runtime / 'build-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    for key in ['upstreamCommit', 'patchSHA256', 'sourceSHA256', 'supportSHA256']:
        if manifest.get(key) != PINS[key]: raise ValueError('Existing runtime does not match reviewed ' + key)
    if manifest.get('rustToolchain') != TOOLCHAIN: raise ValueError('Unexpected existing runtime compiler')
    before = sha(runtime / 'bin/rtex')
    if before != manifest.get('binary', {}).get('SHA256'): raise ValueError('Existing runtime binary hash differs')
    check_files(runtime / 'tex', PINS['supportSHA256'])
    notices = runtime / 'notices'
    if notices.exists() or 'noticesSHA256' in manifest: raise ValueError('Runtime already has notices; refusing overwrite')
    cargo = Path(os.path.abspath(args.cargo or shutil.which('cargo') or ''))
    rustup = cargo.parent / 'rustup'
    if not cargo.is_file() or not rustup.is_file(): raise ValueError('rustup-managed Cargo is required')
    env = os.environ.copy()
    env['RUSTUP_TOOLCHAIN'] = TOOLCHAIN
    env['CARGO_TARGET_DIR'] = str(work / 'target')
    compiler = run([rustup, 'run', TOOLCHAIN, 'rustc', '--version'], env=env, capture=True)
    if not compiler.startswith('rustc ' + TOOLCHAIN + ' '): raise ValueError('Unexpected Rust compiler')
    sysroot = Path(run([rustup, 'run', TOOLCHAIN, 'rustc', '--print', 'sysroot'], env=env, capture=True).strip())
    try:
        manifest['noticesSHA256'] = collect_notices(source, cargo, env, manifest['target'], sysroot, notices, PINS['upstreamCommit'])
        verify(source)
        if sha(runtime / 'bin/rtex') != before: raise ValueError('Engine changed during notice collection')
        check_files(runtime / 'tex', PINS['supportSHA256'])
        staged = manifest_path.with_name('.build-manifest-notices.json')
        staged.write_text(json.dumps(manifest, indent=2) + '\n')
        staged.replace(manifest_path)
    except BaseException:
        if notices.exists(): shutil.rmtree(notices)
        raise
    print(json.dumps({'noticesAdded': True, 'binaryUnchanged': True, 'binarySHA256': before,
                      'noticeFiles': len(manifest['noticesSHA256'])}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('prepare', help='Fetch pinned source and apply the verified downstream patch')
    p.add_argument('--workdir', type=Path, required=True)
    acquisition = p.add_mutually_exclusive_group()
    acquisition.add_argument('--repository', help='Official upstream URL, or an existing local mirror for offline preparation')
    acquisition.add_argument('--archive', type=Path, help='Previously downloaded official archive; SHA256 and full Git tree must match')
    acquisition.add_argument('--download-archive', action='store_true', help='Download the pinned official codeload archive instead of using Git transport')
    b = sub.add_parser('build', help='Build with pinned Rust and package the matching support tree')
    b.add_argument('--workdir', type=Path, required=True)
    b.add_argument('--target', default='native', choices=['native', 'x86_64-unknown-linux-musl'])
    b.add_argument('--cargo', help='Path to the rustup-managed Cargo proxy')
    n = sub.add_parser('notices', help='Add verified dependency notices to an existing matching build without rebuilding its binary')
    n.add_argument('--workdir', type=Path, required=True)
    n.add_argument('--runtime', type=Path, required=True)
    n.add_argument('--cargo', help='Path to the rustup-managed Cargo proxy')
    v = sub.add_parser('verify', help='Read-only source and support verification')
    v.add_argument('--workdir', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'prepare': prepare(args)
        elif args.action == 'build': build(args)
        elif args.action == 'notices': attach_notices(args)
        else:
            verify(args.workdir.resolve(strict=True) / 'source')
            print(json.dumps({'verified': True, 'commit': PINS['upstreamCommit']}))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Engine build failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
