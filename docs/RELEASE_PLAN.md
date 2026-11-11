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

## Later GitHub publication

Use a fresh repository rather than importing private development history. Publish the reviewed source snapshot and experimental tag with the same notices, compatibility boundaries and validation record. The user has requested local preparation only; no remote repository, release, or tag is created in this task.

A future binary or container release needs its own complete component and corresponding-source review. It is separate from this source-only alpha.
