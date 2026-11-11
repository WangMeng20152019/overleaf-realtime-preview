import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zlib

SPEC = importlib.util.spec_from_file_location('source_release', Path(__file__).resolve().parents[1] / 'deployment/release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class SourceReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'candidate'
        self.root.mkdir()
        for name in release.REQUIRED:
            self.put(name, ('Synthetic source fixture ' + name + '\n').encode())
        self.put('engine/build.py', b'#!/usr/bin/env python3\nprint("fixture")\n')
        self.put('tests/synthetic.test.mjs', b'export const token = "fixture-token";\n')
        self.put('docs/VALIDATION.md', b'Synthetic public validation fixture.\n')
        for name in release.PREVIEW_FILES:
            self.put('dev/preview/' + name, ('Synthetic preview ' + name).encode())

    def put(self, name, data):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def create(self, name='release', version='0.1.0-alpha.1'):
        return release.create_release(self.root, self.base / name, version)

    def test_deterministic_sorted_archive_and_metadata_ignore_host_times_modes(self):
        first = self.create()
        for path in self.root.rglob('*'):
            if path.is_file():
                os.utime(path, (946684800, 946684800))
                path.chmod(0o600)
        second = self.create('release-two')
        self.assertEqual(first, second)
        for name in ['source.tar.gz', 'SHA256SUMS', 'filemanifest.json']:
            self.assertEqual((self.base / 'release' / name).read_bytes(), (self.base / 'release-two' / name).read_bytes())
        data = (self.base / 'release/source.tar.gz').read_bytes()
        self.assertEqual(data[4:8], b'\0' * 4)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            names = [m.name for m in archive.getmembers()]
            self.assertEqual(names, sorted(names))
            for member in archive.getmembers():
                self.assertEqual((member.uid, member.gid, member.mtime, member.uname, member.gname), (0, 0, 0, '', ''))
                self.assertTrue(member.isfile())
                self.assertIn(member.mode, {0o644, 0o755})
        self.assertEqual(first['files']['engine/build.py']['mode'], 0o755)
        release.verify_release(self.base / 'release')

    def test_private_and_generated_files_are_excluded_without_reading_them(self):
        bad = b'gh' + b'p_' + b'Z' * 36
        excluded = ['.local/source.ts', 'node_modules/private.js', 'dist/server.mjs',
                    'artifacts/secret.ts', 'trials/project.tex', 'state/token.json', '.env',
                    'deployment/config.local.json', 'public/app.js', 'public/integration.js',
                    'public/pdf.worker.mjs', 'dev/preview/client.js', 'dev/preview/build-info.json',
                    'dev/preview/self-test.json', 'engine/target/debug/rtex',
                    'engine/__pycache__/secret.pyc', 'fixtures/private-paper.tex']
        for name in excluded: self.put(name, bad)
        self.put('README.en.md', b'Public English source overview')
        self.put('CHANGELOG.md', b'Public alpha changes')
        manifest = self.create()
        self.assertIn('README.en.md', manifest['files'])
        self.assertIn('CHANGELOG.md', manifest['files'])
        self.assertFalse(set(excluded) & set(manifest['files']))
        self.assertIn('fixtures/main.tex', manifest['files'])
        self.assertEqual(set(p.name for p in (self.base / 'release').iterdir()), {'source.tar.gz', 'SHA256SUMS', 'filemanifest.json'})

    def test_selected_source_symlink_and_directory_symlink_refused(self):
        outside = self.base / 'outside.ts'
        outside.write_text('public fixture')
        source = self.root / 'src/server.ts'
        original = source.read_bytes()
        source.unlink()
        source.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'symlink'): self.create()
        self.assertFalse((self.base / 'release').exists())
        source.unlink()
        source.write_bytes(original)
        (self.root / 'src/alias').symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'): self.create()

    def test_secret_rules_block_synthetic_inputs_and_redact_values(self):
        fixtures = [
            b'gh' + b'p_' + b'A' * 36,
            b'-----BEGIN ' + b'PRIVATE KEY-----\nsynthetic\n',
            b'/' + b'Users/' + b'synthetic-user/project',
            b'pass' + b'word = ' + b'"synthetic-private-passphrase"',
            b'pass' + b'word = ' + b'"short7"',
            b'RTEX_TO' + b'KEN: ' + b'"opaqueSyntheticEnvToken99"',
            b'https://' + b'fixture-user:' + b'synthetic-passphrase@example.org',
        ]
        for index, data in enumerate(fixtures):
            self.put('tests/leak.test.mjs', data)
            with self.assertRaises(ValueError) as error: self.create('blocked-' + str(index))
            self.assertIn('Publication blocked', str(error.exception))
            self.assertNotIn(data.decode(), str(error.exception))
            self.assertFalse((self.base / ('blocked-' + str(index))).exists())

    def test_dynamic_secret_writer_is_code_while_quoted_credentials_still_block(self):
        self.put('deployment/generator.py', b"f.write('OVERLEAF_INVITE_TOKEN_SECRET=' + generate_value() + '\\n')\n")
        self.create('generator')
        for index, data in enumerate([b'const RTEX_TO' + b'KEN = ' + b'"opaqueSyntheticValue";', b"{'to" + b"ken': " + b"'opaqueSyntheticValue'}"]):
            self.put('src/literal.ts', data)
            with self.assertRaisesRegex(ValueError, 'literal-credential-assignment'): self.create('literal-' + str(index))

    def test_known_private_fingerprints_are_checked_without_publishing_values(self):
        private = b'SyntheticPrivateHost99'
        self.put('src/private.ts', b'https://' + private + b'.example.org')
        with patch.object(release, 'PRIVATE_TOKEN_HASHES', {hashlib.sha256(private.lower()).hexdigest()}):
            with self.assertRaisesRegex(ValueError, 'known-private-host-or-project'): self.create()
        self.assertNotIn(private.decode(), Path(release.__file__).read_text())

    def test_only_explicit_synthetic_placeholders_are_accepted_not_all_tests(self):
        self.put('tests/safe.test.mjs', b'const token = "fixture-token"; const password = "redacted";')
        self.create('safe')
        self.put('tests/safe.test.mjs', b'const to' + b'ken = ' + b'"opaqueSyntheticCredential12345";')
        with self.assertRaisesRegex(ValueError, 'literal-credential-assignment'): self.create('not-safe')

    def test_unsafe_versions_existing_outputs_and_source_overlap_refused(self):
        for version in ['../1.0.0', 'v0.1.0', '1.0', '1.0.0/extra', '1.0.0\n', '1.0.0;command', '1.0.0-01']:
            with self.assertRaisesRegex(ValueError, 'semantic version'): self.create('bad-version', version)
        output = self.base / 'existing'
        output.mkdir()
        (output / 'keep').write_text('keep')
        for path in [output, self.root, self.root / 'docs/release', self.root / 'src/output', self.base]:
            with self.assertRaises(ValueError): release.create_release(self.root, path, '0.1.0-alpha.1')
        self.assertEqual((output / 'keep').read_text(), 'keep')
        allowed = self.root / '.local/release'
        release.create_release(self.root, allowed, '0.1.0-alpha.1')
        release.verify_release(allowed)

    def test_archive_tamper_detected_even_after_outer_checksums_are_recomputed(self):
        self.create()
        directory = self.base / 'release'
        with tarfile.open(fileobj=io.BytesIO((directory / 'source.tar.gz').read_bytes()), mode='r:gz') as source:
            members = [(member, source.extractfile(member).read()) for member in source.getmembers()]
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for index, (member, data) in enumerate(members):
                if index == 0: data += b'tampered'
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        altered = gzip.compress(stream.getvalue(), mtime=0)
        (directory / 'source.tar.gz').write_bytes(altered)
        manifest = json.loads((directory / 'filemanifest.json').read_text())
        manifest['archiveSHA256'] = release.digest(altered)
        manifest_data = json.dumps(manifest, sort_keys=True, indent=2).encode() + b'\n'
        (directory / 'filemanifest.json').write_bytes(manifest_data)
        (directory / 'SHA256SUMS').write_text(release.digest(manifest_data) + '  filemanifest.json\n' + release.digest(altered) + '  source.tar.gz\n')
        with self.assertRaisesRegex(ValueError, 'member bytes differ'): release.verify_release(directory)

    def test_verifier_refuses_nonpublic_or_unsafe_manifest_paths(self):
        manifest = self.create()
        data = (self.base / 'release/source.tar.gz').read_bytes()
        for name in ['../escape.py', '.local/secret.ts', '/absolute.ts', 'src/../private.ts']:
            altered = dict(manifest)
            altered['files'] = {name: {'bytes': 1, 'mode': 0o644, 'sha256': '0' * 64}}
            altered['sourceFileCount'] = 1
            with self.assertRaisesRegex(ValueError, 'nonpublic or unsafe path'): release.verify_archive(data, altered)

    def test_optional_preview_is_only_allowed_png_without_text_metadata(self):
        def chunk(kind, data): return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        header = b'\x89PNG\r\n\x1a\n'
        ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
        pixels = chunk(b'IDAT', zlib.compress(b'\0\xff\xff\xff'))
        end = chunk(b'IEND', b'')
        self.put('docs/images/preview.png', header + ihdr + pixels + end)
        self.assertTrue(self.create()['previewImageIncluded'])
        self.put('docs/images/preview.png', header + ihdr + chunk(b'tEXt', b'Author\0synthetic') + pixels + end)
        with self.assertRaisesRegex(ValueError, 'metadata'): self.create('metadata')


if __name__ == '__main__': unittest.main()
