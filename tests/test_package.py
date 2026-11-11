import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('runtime_package', Path(__file__).resolve().parents[1] / 'deployment/package.py')
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'candidate'
        self.engine = self.base / 'engine-runtime'
        self.root.mkdir()
        self.engine.mkdir()
        for name in package.ASSETS + ['integration/' + n for n in package.INTEGRATION]:
            self.put(self.root / name, ('public fixture ' + name).encode())
        self.put(self.root / 'docs/licenses/realtime-tex-v0.0.6-MIT.txt', b'MIT fixture notice\n')
        self.put(self.engine / 'LICENSE.rtex', b'MIT fixture notice\n')
        self.put(self.root / 'engine/overleaf-v0.0.6.patch', b'reviewed patch fixture\n')
        source_pins = json.loads((package.ROOT / 'engine/candidate-pins.json').read_text())
        self.pins = copy.deepcopy(source_pins)
        self.pins['patchSHA256'] = package.digest(self.root / 'engine/overleaf-v0.0.6.patch')
        for name in self.pins['supportSHA256']:
            self.put(self.engine / 'tex' / name, ('support fixture ' + name).encode())
            self.pins['supportSHA256'][name] = package.digest(self.engine / 'tex' / name)
        self.put(self.root / 'engine/candidate-pins.json', json.dumps(self.pins).encode())
        # Minimal ELF64 x86-64 executable with a single static load segment.
        data = bytearray(120)
        data[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', data, 16, 3)
        struct.pack_into('<H', data, 18, 62)
        struct.pack_into('<Q', data, 32, 64)
        struct.pack_into('<HH', data, 54, 56, 1)
        struct.pack_into('<I', data, 64, 1)
        self.put(self.engine / 'bin/rtex', bytes(data))
        (self.engine / 'bin/rtex').chmod(0o755)
        self.manifest = {k: self.pins[k] for k in ['upstreamCommit', 'patchSHA256', 'sourceSHA256', 'supportSHA256']}
        self.manifest.update(schemaVersion=1, target='x86_64-unknown-linux-musl', profile='dist', rustToolchain='1.99.1')
        notice = {'schema': 1, 'upstreamCommit': self.pins['upstreamCommit'], 'target': self.manifest['target'], 'cargoLockSHA256': self.pins['sourceSHA256']['Cargo.lock'], 'reviewRequired': []}
        self.put(self.engine / 'notices/THIRD_PARTY.json', json.dumps(notice).encode())
        self.manifest['noticesSHA256'] = {'notices/THIRD_PARTY.json': package.digest(self.engine / 'notices/THIRD_PARTY.json')}
        self.update_binary_manifest()

    @staticmethod
    def put(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def update_binary_manifest(self):
        binary = self.engine / 'bin/rtex'
        self.manifest['binary'] = {'path': 'bin/rtex', 'SHA256': package.digest(binary), 'bytes': binary.stat().st_size}
        self.save_manifest()

    def save_manifest(self):
        (self.engine / 'build-manifest.json').write_text(json.dumps(self.manifest))

    def assemble(self, name='runtime'):
        return package.assemble(self.root, self.engine, self.base / name)

    def test_exact_inventory_and_manifest_are_portable_and_repeatable(self):
        self.put(self.root / '.env', b'private-token-should-never-leave-source')
        self.put(self.root / 'node_modules/private-secret', b'not a runtime input')
        self.put(self.root / 'tests/project.tex', b'private project text')
        first = self.assemble()
        second = self.assemble('runtime-two')
        self.assertEqual(first, second)
        self.assertEqual((self.base / 'runtime/runtime-manifest.json').read_bytes(), (self.base / 'runtime-two/runtime-manifest.json').read_bytes())
        actual = package.inventory(self.base / 'runtime')
        del actual['runtime-manifest.json']
        self.assertEqual(actual, first['files'])
        self.assertEqual(first['schema'], 1)
        self.assertNotIn('runtime-manifest.json', first['files'])
        self.assertEqual(first['engine']['binarySHA256'], self.manifest['binary']['SHA256'])
        self.assertTrue(all(not n.startswith(('node_modules/', 'tests/', 'src/')) for n in actual))
        self.assertNotIn('.env', actual)
        self.assertTrue((self.base / 'runtime/deployment/runtime-linux/bin/rtex').stat().st_mode & 0o100)
        self.assertEqual(len([n for n in actual if n.startswith('deployment/runtime-support/tex/')]), 10)

    def test_modified_binary_refused_before_output_creation(self):
        p = self.engine / 'bin/rtex'
        p.write_bytes(p.read_bytes() + b'tampered')
        with self.assertRaisesRegex(ValueError, 'binary differs'): self.assemble()
        self.assertFalse((self.base / 'runtime').exists())

    def test_modified_support_refused(self):
        name = next(iter(self.pins['supportSHA256']))
        (self.engine / 'tex' / name).write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'support differs'): self.assemble()

    def test_tampered_or_missing_dependency_notices_refused(self):
        p = self.engine / 'notices/THIRD_PARTY.json'
        original = p.read_bytes()
        p.write_bytes(original + b'\nchanged')
        with self.assertRaisesRegex(ValueError, 'dependency notice differs'): self.assemble()
        p.write_bytes(original)
        del self.manifest['noticesSHA256']
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'requires collected dependency notices'): self.assemble()

    def test_unreviewed_source_or_wrong_arch_manifest_refused(self):
        for field, value in [('upstreamCommit', '0' * 40), ('target', 'aarch64-unknown-linux-musl')]:
            original = self.manifest[field]
            self.manifest[field] = value
            self.save_manifest()
            with self.assertRaises(ValueError): self.assemble()
            self.manifest[field] = original
        self.save_manifest()

    def test_extra_engine_files_and_symlinks_refused(self):
        extra = self.engine / 'tex/extra.lua'
        extra.write_text('not reviewed')
        with self.assertRaisesRegex(ValueError, 'inventory differs'): self.assemble()
        extra.unlink()
        extra.symlink_to(self.engine / 'LICENSE.rtex')
        with self.assertRaisesRegex(ValueError, 'Symlinks'): self.assemble()
        extra.unlink()
        alias = self.base / 'engine-alias'
        alias.symlink_to(self.engine, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'): package.assemble(self.root, alias, self.base / 'runtime')

    def test_output_existing_and_overlap_refused(self):
        existing = self.base / 'existing'
        existing.mkdir()
        (existing / 'keep').write_text('keep')
        for output in [existing, self.root, self.root / 'src/output', self.root / 'dist/output', self.engine / 'new', self.base]:
            with self.assertRaises(ValueError): package.assemble(self.root, self.engine, output)
        self.assertEqual((existing / 'keep').read_text(), 'keep')
        self.assertFalse((self.root / 'src').exists())
        self.assertFalse((self.engine / 'new').exists())

    def test_manifest_cannot_disguise_nonstatic_or_non_x86_binary(self):
        original = (self.engine / 'bin/rtex').read_bytes()
        for field, offset, value in [('<H', 18, 183), ('<I', 64, 3)]:
            data = bytearray(original)
            struct.pack_into(field, data, offset, value)
            (self.engine / 'bin/rtex').write_bytes(data)
            self.update_binary_manifest()
            with self.assertRaises(ValueError): self.assemble()




class NoticeCollectionTests(unittest.TestCase):
    def setUp(self):
        import io
        import tarfile
        import os
        spec = importlib.util.spec_from_file_location('engine_notices', package.ROOT / 'engine/notices.py')
        self.notices = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.notices)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'source'
        self.source.mkdir()
        self.cargo_home = self.base / 'cargo'
        self.registry = 'registry+https://github.com/rust-lang/crates.io-index'
        self.crate_manifest = b'[package]\nname="fixture"\nversion="1.0.0"\nlicense="MIT"\n'
        self.manifest = self.cargo_home / 'registry/src/test-index/fixture-1.0.0/Cargo.toml'
        PackageTests.put(self.manifest, self.crate_manifest)
        self.archive = self.cargo_home / 'registry/cache/test-index/fixture-1.0.0.crate'
        self.make_archive(True)
        self.metadata = {'packages': [
            {'id': 'cli', 'name': 'rtex-cli', 'version': '0.0.6', 'source': None},
            {'id': 'fixture', 'name': 'fixture', 'version': '1.0.0', 'source': self.registry, 'manifest_path': str(self.manifest), 'license': 'MIT', 'license_file': None},
            {'id': 'unused', 'name': 'unused-parser', 'version': '1.0.0', 'source': self.registry, 'manifest_path': '/not/read/unused-parser/Cargo.toml', 'license': 'Unknown-License', 'license_file': None},
        ]}
        self.sysroot = self.base / 'rust'
        PackageTests.put(self.sysroot / 'share/doc/rust/COPYRIGHT-library.html', b'Official fixture copyright corpus')
        PackageTests.put(self.sysroot / 'share/doc/rust/licenses/MIT.txt', b'Official fixture MIT text')
        self.env = dict(os.environ, CARGO_HOME=str(self.cargo_home))

    def make_archive(self, license_text):
        import io
        import tarfile
        self.archive.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(self.archive, 'w:gz') as tar:
            entries = {'Cargo.toml': self.crate_manifest}
            if license_text: entries['LICENSE'] = b'Actual checksum-pinned fixture copyright/license text\n'
            for name, data in entries.items():
                member = tarfile.TarInfo('fixture-1.0.0/' + name)
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
        checksum = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        (self.source / 'Cargo.lock').write_text('[[package]]\nname = "fixture"\nversion = "1.0.0"\nsource = "' + self.registry + '"\nchecksum = "' + checksum + '"\n')

    def run_collection(self):
        from unittest.mock import patch
        import subprocess
        def cargo(args, **kwargs):
            self.assertIn('--locked', args)
            if args[1] == 'metadata': output = json.dumps(self.metadata)
            else:
                self.assertIn('rtex-cli', args)
                self.assertIn('normal,build', args)
                self.assertIn('x86_64-unknown-linux-musl', args)
                output = 'rtex-cli v0.0.6 (/neutral/source)\nfixture v1.0.0\n'
            return subprocess.CompletedProcess(args, 0, stdout=output)
        with patch.object(self.notices.subprocess, 'run', side_effect=cargo):
            return self.notices.collect(self.source, Path('/cargo'), self.env, 'x86_64-unknown-linux-musl', self.sysroot, self.base / 'notices', 'a' * 40)

    def test_actual_target_tree_excludes_workspace_optional_unknown_license(self):
        files = self.run_collection()
        receipt = json.loads((self.base / 'notices/THIRD_PARTY.json').read_text())
        self.assertEqual([x['name'] for x in receipt['crates']], ['fixture'])
        self.assertEqual(receipt['reviewRequired'], [])
        self.assertEqual(receipt['excludedWorkspaceResolvedRegistryPackages'], [{'name': 'unused-parser', 'version': '1.0.0'}])
        self.assertIn('notices/crates/fixture-1.0.0/LICENSE', files)
        self.assertFalse(any(name.endswith('Cargo.toml') for name in files))

    def test_archive_tampering_refused_against_lock_checksum(self):
        self.archive.write_bytes(self.archive.read_bytes() + b'tampered')
        with self.assertRaisesRegex(ValueError, 'archive differs from Cargo.lock'): self.run_collection()

    def test_missing_actual_license_text_is_explicit_and_not_fabricated(self):
        self.make_archive(False)
        files = self.run_collection()
        receipt = json.loads((self.base / 'notices/THIRD_PARTY.json').read_text())
        self.assertEqual(receipt['reviewRequired'][0]['name'], 'fixture')
        self.assertIn('No license/notice text', receipt['reviewRequired'][0]['reasons'][0])
        self.assertFalse(any('/crates/fixture-' in name for name in files))


if __name__ == '__main__': unittest.main()
