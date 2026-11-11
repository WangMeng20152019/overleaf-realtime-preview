#!/usr/bin/env python3
"""Offline, exact-source apply/check/rollback of the native rtex observer candidate."""
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import stat

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('legacy_patch_utilities', HERE / 'patch-editor.py')
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
PatchError = legacy.PatchError
PREFIX = 'services/web/frontend/js/features/source-editor/extensions/'
INDEX = PREFIX + 'index.ts'
NATIVE = PREFIX + 'rtex-bridge.ts'
INDEX_HASHES = {
    '9cc77c54196e481c33f16dadd3347c3e522a63b6ec14cea198e326481ababfc8',
    '09b49147c5dc7fee9eab38911da47fc6025e81b2fd7c347132f07dc15f55d7be',
}
CONTEXT_HASHES = {
    'realtime.ts': '4328e7405a2604715937f12e45cffd6ee0d20dc94ec4f6518c33189c552980ff',
    'history-ot.ts': 'efd8983f7c5b1f7ae04d96ac48dd467a9f306394dd21f476ee6478b02df3266d',
    'bundle.ts': '64b1c0d5d63e039174ec14b4e74c607b95749abfada7f6fa18cfc3985b0c8250',
}
# Exact tuples only: an audited index never authorizes unrelated context files.
INSTALLED_INDEX = '5f7f8520121bc61f5ecc1af0d0186cf8097449fa62c5e50f50dd77fbd15bf94e'
SOURCE_PROFILES = {key: dict(CONTEXT_HASHES) for key in INDEX_HASHES}
SOURCE_PROFILES[INSTALLED_INDEX] = {
    'realtime.ts': 'ed19c19f26d02e1a792c9c9f219b676abc5359b51633d939c187a38f7b61bf8d',
    'history-ot.ts': '719a54aa84f4bccc338bca6e7a7d10fb102b273986d3ffc9bd5ad33732485b08',
    'bundle.ts': CONTEXT_HASHES['bundle.ts'],
}
INDEX_HASHES.add(INSTALLED_INDEX)
# Deterministic index-only legacy identity transform of the audited installed bytes.
INSTALLED_LEGACY_INDEX = '74866b2e5228f3fe92b22df5ea12e0a80e14565687ffe9365a4c419cb5b53a92'
SOURCE_PROFILES[INSTALLED_LEGACY_INDEX] = dict(SOURCE_PROFILES[INSTALLED_INDEX])
INDEX_HASHES.add(INSTALLED_LEGACY_INDEX)
ANCHORS = (
    (b"import { realtime } from './realtime'", b"import { realtime } from './realtime'\nimport { rtexBridge } from './rtex-bridge'"),
    (b'  realtime(options.currentDoc, options.handleError),', b'  realtime(options.currentDoc, options.handleError),\n  rtexBridge(options.currentDoc),'),
)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def transform(original):
    if digest(original) not in INDEX_HASHES:
        raise PatchError('index.ts is not an audited exact source version')
    result = original
    for old, new in ANCHORS:
        if result.count(old) != 1:
            raise PatchError('Expected exactly one native bridge source anchor')
        result = result.replace(old, new)
    return result

def preflight(root, rollback=False):
    root = Path(root).resolve(strict=True)
    index = legacy.safe_file(root, INDEX)
    backup = index.with_name(index.name + '.before-rtex-native')
    native = root / NATIVE
    # A source directory is validated by safe_file(index); native itself must not
    # redirect a write outside that directory.
    if native.is_symlink() or backup.is_symlink():
        raise PatchError('Native source/backup symlinks are not supported')
    profile_source = legacy.safe_file(root, str(backup.relative_to(root))).read_bytes() if rollback else index.read_bytes()
    profile = SOURCE_PROFILES.get(digest(profile_source))
    if profile is None:
        raise PatchError('index.ts is not an audited exact source version')
    for name, expected in profile.items():
        if digest(legacy.safe_file(root, PREFIX + name).read_bytes()) != expected:
            raise PatchError('Pinned annotation/context source changed: ' + name)
    candidate = (HERE / 'rtex-bridge.ts').read_bytes()
    if rollback:
        original = legacy.safe_file(root, str(backup.relative_to(root))).read_bytes()
        if index.read_bytes() != transform(original):
            raise PatchError('Rollback refused: index.ts differs from our exact patch')
        if legacy.safe_file(root, NATIVE).read_bytes() != candidate:
            raise PatchError('Rollback refused: native source differs from this candidate')
    else:
        if backup.exists() or native.exists():
            raise PatchError('Native source or backup already exists; no edits made')
        original = index.read_bytes()
        transform(original)
    return index, backup, native, original, candidate

def execute(root, rollback=False, check=False):
    index, backup, native, original, candidate = preflight(root, rollback)
    if check:
        return
    patched = transform(original)
    before, after = (patched, original) if rollback else (original, patched)
    mode = stat.S_IMODE(index.stat().st_mode)
    staged = legacy.stage(index, after, mode)
    native_created = backup_created = index_replaced = native_removed = False
    try:
        if index.read_bytes() != before:
            raise PatchError('index.ts changed after preflight')
        if rollback:
            if backup.read_bytes() != original or native.read_bytes() != candidate:
                raise PatchError('Native source/backup changed after preflight')
        else:
            with backup.open('xb') as stream:
                backup_created = True
                stream.write(original)
                stream.flush()
                os.fsync(stream.fileno())
            backup.chmod(mode)
            with native.open('xb') as stream:
                native_created = True
                stream.write(candidate)
                stream.flush()
                os.fsync(stream.fileno())
            native.chmod(mode)
        if index.read_bytes() != before:
            raise PatchError('index.ts changed during transaction')
        os.replace(staged, index)
        index_replaced = True
        if rollback:
            if native.read_bytes() != candidate or backup.read_bytes() != original:
                raise PatchError('Native source/backup changed during rollback')
            native.unlink()
            native_removed = True
            backup.unlink()
    except BaseException as error:
        recovery_errors = []
        try:
            if index_replaced:
                if index.read_bytes() != after:
                    raise PatchError('Concurrent index change prevents recovery')
                recovery = legacy.stage(index, before, mode)
                try:
                    os.replace(recovery, index)
                finally:
                    recovery.unlink(missing_ok=True)
            if rollback and native_removed:
                with native.open('xb') as stream:
                    stream.write(candidate)
                native.chmod(mode)
            if native_created:
                if native.read_bytes() != candidate:
                    raise PatchError('Concurrent native source change prevents recovery')
                native.unlink()
            if backup_created:
                if backup.read_bytes() != original:
                    raise PatchError('Concurrent backup change prevents recovery')
                backup.unlink()
        except BaseException as recovery_error:
            recovery_errors.append(str(recovery_error))
        if recovery_errors:
            raise PatchError('Incomplete recovery; inspect retained files: ' + '; '.join(recovery_errors)) from error
        raise PatchError('Transaction aborted; prior source restored: ' + str(error)) from error
    finally:
        staged.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('overleaf_root', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    try:
        execute(args.overleaf_root, args.rollback, args.check)
    except (PatchError, OSError) as error:
        parser.exit(1, str(error) + '\n')
    print('Native bridge preflight passed; no writes' if args.check else 'Native bridge restored; separate legacy patch unchanged' if args.rollback else 'Native bridge candidate applied; exact rollback backup retained')

if __name__ == '__main__':
    main()
