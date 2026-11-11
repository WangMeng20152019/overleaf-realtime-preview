# Local publication plan

The first release is a source-first experimental alpha for one explicitly pinned Overleaf CE environment and one copied project. The installation procedure is the primary entry; the synthetic local preview page is a contributor and reproduction tool.

## Prepared locally

- Chinese and English project pages, a development history based on user-reported failures, and explicit upstream and AI-tool attribution.
- Pinned upstream source, reviewed integration patches, a reproducible engine build, dependency notices and runtime assembly.
- Isolated Overleaf frontend build, complete project import/binding, scoped assets, authenticated routing and source-preserving lifecycle controls.
- An exact source allowlist and deterministic archive builder with private-path and credential checks.

## Acceptance and packaging

The [validation record](VALIDATION.md) and [compatibility matrix](COMPATIBILITY.md) govern the actual claims. Component tests and historical private-server experience do not stand in for installed browser/restart acceptance. Record unresolved limitations explicitly in the alpha release notes.

After final acceptance, freeze the source archive, its file manifest and SHA256SUMS. Verify an extracted copy with a fresh dependency installation and the documented build/check commands. Keep generated runtime, TeX/fonts, container images, credentials, private diagnostics and paper content out of the first source publication.

## One complete GitHub release

The reviewed snapshot is now in [overleaf-realtime-preview](https://github.com/WangMeng20152019/overleaf-realtime-preview), with no private development history. Its first GitHub source-check run passed on 2026-11-11.

Publish one experimental release, `v0.1.0-alpha.2`, from this repository. The earlier alpha.1 changelog entry records local preparation; it is not a separate download or installation requirement. The repository contains the full source, installation instructions, synthetic debug page, tests, provenance and known limitations. Attach the matching `source.tar.gz`, `filemanifest.json` and `SHA256SUMS` to that same release. Use the [complete release notes](RELEASE_NOTES.md) for the release page.

Repository visibility and the release Publish button are separate GitHub controls. A private upload is a staging state, not a second edition of the project. Source publication does not imply a prebuilt image or universal one-click installation.

A future binary or container release needs its own complete component and corresponding-source review. It is separate from this source-only alpha.
