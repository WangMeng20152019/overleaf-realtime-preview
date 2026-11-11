import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('privacy_audit', Path(__file__).resolve().parents[1] / 'deployment/privacy-audit.py')
privacy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(privacy)


class PrivacyAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / 'source'
        self.root.mkdir()
        for name in privacy.release.REQUIRED:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Synthetic source fixture\n')
        self.git('init', '--quiet')
        self.git('add', '--all')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), '-c', 'core.autocrlf=false',
                               '-c', 'core.attributesFile=/dev/null', *args], check=True, capture_output=True)

    def test_source_index_and_exact_archive_pass(self):
        out = self.base / 'release'
        privacy.release.create_release(self.root, out, '0.1.0-alpha.1')
        result = privacy.audit(self.root, True, out)
        self.assertTrue(result['gitIndexChecked'] and result['matchingArchiveChecked'])

    def test_staged_env_refused_even_when_release_would_exclude_it(self):
        (self.root / '.env').write_text('SYNTHETIC=true\n')
        self.git('add', '.env')
        with self.assertRaisesRegex(ValueError, 'Unapproved tracked path'):
            privacy.audit(self.root, True)

    def test_worktree_cannot_hide_different_staged_bytes(self):
        p = self.root / 'README.md'
        p.write_text('Synthetic changed source\n')
        with self.assertRaisesRegex(ValueError, 'Staged bytes differ'):
            privacy.audit(self.root, True)

    def test_unreviewed_allowlisted_file_is_not_silently_omitted(self):
        (self.root / 'docs').mkdir(exist_ok=True)
        (self.root / 'docs/new.md').write_text('Synthetic addition\n')
        with self.assertRaisesRegex(ValueError, 'inventory differ'):
            privacy.audit(self.root, True)

    def test_tracked_symlink_refused(self):
        (self.root / 'docs').mkdir(exist_ok=True)
        (self.root / 'docs/link.md').symlink_to('../README.md')
        self.git('add', 'docs/link.md')
        with self.assertRaises(ValueError):
            privacy.audit(self.root, True)

    def test_known_credential_pattern_refused_without_printing_value(self):
        (self.root / 'README.md').write_bytes(b'Authorization: Bearer ' + b'Z' * 32)
        with self.assertRaisesRegex(ValueError, 'embedded-bearer-token'):
            privacy.audit(self.root)

    def test_valid_but_different_archive_refused(self):
        out = self.base / 'release'
        privacy.release.create_release(self.root, out, '0.1.0-alpha.1')
        (self.root / 'README.md').write_text('Synthetic later source\n')
        with self.assertRaisesRegex(ValueError, 'Archive source differs'):
            privacy.audit(self.root, archive=out)

    def test_archive_tamper_refused(self):
        out = self.base / 'release'
        privacy.release.create_release(self.root, out, '0.1.0-alpha.1')
        p = out / 'source.tar.gz'
        p.write_bytes(p.read_bytes() + b'tamper')
        with self.assertRaises(ValueError):
            privacy.audit(self.root, archive=out)

    def test_parent_repository_is_not_accepted_as_exact_root(self):
        nested = self.root / 'nested'
        nested.mkdir()
        for name in privacy.release.REQUIRED:
            p = nested / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('Synthetic nested source\n')
        with self.assertRaisesRegex(ValueError, 'Exact repository root'):
            privacy.audit(nested, True)

    def test_private_terms_and_hashes_are_local_inputs_not_public_defaults(self):
        self.assertEqual(privacy.release.PRIVATE_TOKEN_HASHES, set())
        deny = self.base / 'private.json'
        marker = 'SyntheticPrivateUnit99'
        (self.root / 'README.md').write_text(marker)
        for rules in [{'terms': [marker]}, {'tokenSHA256': [hashlib.sha256(marker.lower().encode()).hexdigest()]}]:
            deny.write_text(json.dumps(rules))
            deny.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'value redacted'):
                privacy.audit(self.root, denylist=deny)
        privacy.audit(self.root)

    def test_private_denylist_requires_owner_only_regular_file(self):
        deny = self.base / 'private.json'
        deny.write_text('{"terms":[]}')
        deny.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'mode0600'):
            privacy.audit(self.root, denylist=deny)
        deny.chmod(0o600)
        link = self.base / 'link.json'
        link.symlink_to(deny)
        with self.assertRaisesRegex(ValueError, 'Canonical'):
            privacy.audit(self.root, denylist=link)

    def test_private_network_literal_refused(self):
        (self.root / 'README.md').write_bytes(b'http://' + b'192.' + b'168.125.78/')
        with self.assertRaisesRegex(ValueError, 'Private network'):
            privacy.audit(self.root)

    def test_non_http_service_credentials_refused(self):
        (self.root / 'README.md').write_bytes(b'mongodb://' + b'fixture-user:' + b'fixture-pass@db.example.invalid/')
        with self.assertRaisesRegex(ValueError, 'Embedded service credentials'):
            privacy.audit(self.root)


if __name__ == '__main__':
    unittest.main()
