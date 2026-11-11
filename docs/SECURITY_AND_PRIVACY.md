# Publication privacy and operating boundaries

The public source is separated from private development and installed state. The first distribution contains source/build tools and a synthetic demonstration image; it contains no production account, paper, server address, exported project or engine executable.

## Before publishing

From the reviewed source root:

```sh
python3 -B deployment/privacy-audit.py
# Review/stage the intended public files, then check the actual staged bytes:
python3 -B deployment/privacy-audit.py --git-index
python3 -B deployment/release.py --output /tmp/rtex-reviewed-release --version 0.1.0-alpha.2
python3 -B deployment/privacy-audit.py --git-index --archive /tmp/rtex-reviewed-release
```

The output directory must be new. The checks are local and do not send code, diagnostics or credentials to an external scanning service.

The source packager checks an explicit path allowlist, sensitive-pattern rules, personal workstation paths, key/token patterns and literal credential assignments. It excludes generated output, private configurations and caches and rejects source symlinks. The demonstration PNG must have no textual/EXIF metadata. Its pixels were reviewed as synthetic content; metadata checks do not inspect arbitrary image content.

The additional Git-index gate rejects any tracked path outside the publication allowlist, symlink/submodule/unmerged entries, inventory differences and staged bytes that differ from the inspected working source. It therefore catches a staged `.env` even though the source archiver would omit that file. The matching-archive check verifies its exact inventory/checksums against the reviewed source and bounds archive decompression.

Maintainer-specific identifiers and their derived fingerprints are not embedded in the public tool. An optional local-only JSON denylist can contain `terms` and `tokenSHA256` arrays. Keep it outside the public checkout, in an owned regular nonsymlink mode-0600 file, and pass its absolute canonical path locally with `--denylist`. Its values are not printed or sent to CI. The gate also refuses private-network literals and credential-bearing service URLs for manual review.

```sh
# PRIVATE_RULE_FILE is the path to your separately protected local file.
python3 -B deployment/privacy-audit.py --git-index --denylist "$PRIVATE_RULE_FILE"
```

Review the whole initial publication tree and all history that would be pushed. `.gitignore` does not remove already tracked files or past commits. CI can detect a problem after a push but cannot retract a disclosure; run the local gate first. This release starts from a new Git directory without the private development history.

The supplied workflow uses read-only repository permissions, does not persist checkout credentials, and runs the Git-index gate. It contains no deployment or automatic upload step. Its remote execution remains unverified until actually run on GitHub.

## Data that stays private

Do not publish:

- Real manuscripts, project ZIP exports, bibliography/resource collections, screenshots or videos from personal writing.
- Login/session cookies, passwords, invite secrets, API keys, bearer tokens, SSH keys or browser authentication data.
- Raw diagnostic JSON, service/configuration backups, process/checkpoint inventories or database/VM/volume exports.
- Private hostnames, addresses, project/document IDs, personal absolute paths, development history or unreviewed logs.

Source IDs in the public tests are deliberate fixed synthetic fixtures. Email addresses in original upstream license notices remain as required attribution; they are not the maintainer's private account information. Other sample addresses use example domains. Do not replace these fixtures with real project identities.

The current diagnostics UI is intended to omit document bodies, but that does not certify every diagnostic field or older diagnostic format as anonymous. Use a small synthetic reproduction, review keys/values and filenames, remove identifiers/addresses/paths/tokens, and share only the minimal redacted excerpt. Never post raw private diagnostics in a public issue.

## Runtime boundaries

- The local debug page and default bridge bind to loopback. The Compose example publishes only `127.0.0.1:18080`; MongoDB/Redis have no host port mappings and are for the dedicated trusted network.
- The internal database/cache example is not an authenticated multi-tenant database service. Do not add public database/cache port mappings or attach untrusted containers to its network.
- Preview routes require project authorization and strict origin/host checks. Those checks do not make untrusted TeX safe to execute. The alpha is for a trusted copied project and one controlling editor, not a multi-tenant TeX sandbox.
- Keep installed state/credentials private. Fresh generated secret files use mode 0600; private installed state uses 0700, and process ownership/identity and source bindings are checked before lifecycle operations.
- Use the guarded route-first rollback and snapshot refresh procedure. Do not disable source checks, replace canonical text with an old ZIP, or kill processes by generic names to bypass a refusal.

## Review limits and response to a suspected leak

Pattern checks do not prove the absence of every secret, private paragraph, dependency vulnerability or future mistake. Local directory permissions restrict other ordinary OS users; they do not protect against programs running as the same account, administrators, cloud-sync/backup tools or accidental sharing by the owner. No unrelated backup/sync service or live NAS configuration was audited here.

If a credential is actually disclosed, stop sharing the affected artifact and revoke/rotate that specific credential at its issuer. Removing a file from the newest commit alone does not remove copies or history. Do not paste the exposed value into an issue or chat to report it. This local review found no production credential in the reviewed source artifacts and did not rotate production credentials.
