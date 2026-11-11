# Environment, source and test map

Prepared for the local source release on 2026-11-11. This map describes the reproducible public inputs and the completed local acceptance environment. It does not inventory a live private NAS deployment.

## Environment layers

| Layer | Inputs and role | Persistence / publication |
|---|---|---|
| Source development | Node 24.22.1, npm 10.9.4; `package-lock.json`; Python 3 used for deployment tooling | Publish source and lockfile; rebuild dependencies and generated assets |
| Engine build | realtime-tex v0.0.6, exact source/archive and patch pins; Rust 1.99.1; `x86_64-unknown-linux-musl` | Publish patch/build tools; generate the engine, matching ten-file support tree and notices locally |
| Isolated CE | Official Linux amd64 CE 6.2.2 image pinned in `examples/compose.yml`; required editor files match the documented source tuple | Pull the official image; a custom image is not part of this source release |
| Services | Pinned MongoDB replica set and Redis images; Node 22.22.3/Python 3.12 inside the inspected CE image | Dedicated Compose network and volumes; only the CE web port is published, to loopback |
| TeX | LuaHBTeX 1.24 / TeX Live 2026 in the inspected image; `luatexbase`, `ctex`, Fandol for the synthetic Chinese fixture | Install packages from a repository matching the TeX Live year; fonts and TeX caches are not bundled here |
| Frontend | Separate copy of the pinned CE source, identity/native observer patches, pinned Yarn installation and production build | Never replace an unrecognized source tuple; generated frontend assets stay out of source Git |
| Preview | Bound project mirror, settings observer, bridge, rtex, project-authorized nginx routes and runit supervisor | Private state and immutable runtime in the CE container; authoritative Overleaf text is preserved |
| Acceptance host | ARM Mac; full x86 Linux QEMU VM, 4 CPUs / 8 GB RAM; separate disposable account and two-file project | Emulated functional validation, not native-server latency data; both task VMs were stopped after acceptance |

The exact image/commit digests and operational requirements are in [compatibility](COMPATIBILITY.md), [engine pins](../engine/candidate-pins.json) and [installation](installation/README.md). Homebrew/Colima/Lima/QEMU were local verification tools, not requirements to run this integration on an existing Linux amd64 Docker host.

The earlier ARM/Rosetta VM reproduced a process-inspection runtime failure outside the project and is not certified for this release. The full x86 Linux VM replaced it for installed acceptance.

## Source ownership and data flow

| Location | Responsibility |
|---|---|
| `src/` | Bridge, rendering, version coordination, capture/recovery and source/placement checks |
| `integration/` | Editor adapter, native events, preview mode lifecycle and mapped navigation |
| `integration/source-patch/` | Exact-profile changes applied to a separate Overleaf frontend copy |
| `engine/` | Pinned upstream source, downstream patch, build/support verification and generated-runtime notices |
| `deployment/` | Import/binding, isolated build, guarded stock-settings correction, packaging, lifecycle, proxy transaction and publication checks |
| `vendor/` | Attributed upstream renderer sources; see the provenance and license inventory |
| `dev/preview/` | Synthetic local debugging page with actual adapter/server/renderer code |
| `tests/` | Public synthetic regression tests and disposable CE fixture creation |
| `docs/` / `examples/` | Instructions, evidence boundaries, source/privacy policy and pinned isolated Compose example |

Editing flows from the real editor/native transactions to the project-bound bridge, then the engine VFS and versioned preview. Canonical Overleaf text remains the authority. A private sealed disk checkpoint records startup inputs; it is not incorrectly required to follow every live VFS edit. Reopening after off-mode edits can require the administrator [snapshot refresh](installation/README.md#refreshing-a-stale-preview).

## Tests and evidence

| Entry | What it verifies | What it does not establish |
|---|---|---|
| `npm test` | 32 JavaScript regressions, including transaction lineage, recovery and mapped navigation/control behavior | OS input-method behavior or complete visual correctness |
| `npm run test:deployment` | 157 Python checks after the added privacy gate: import, pins, ownership/lifecycle, configuration, proxy transactions, package/archive/index checks | That every template or deployment is supported |
| `npm run dev:check` | Scoped debugging-page/server/renderer build, without starting a service | Browser execution or engine output |
| `npm run dev:preview` | Loopback-only synthetic editor/canonical/bridge/renderer fixture; bounded lifetime and owned cleanup | A full Overleaf instance; real papers must not replace the fixture |
| `dev/preview/run.mjs --self-test` | When supplied with the matching engine and TeX: protocol, resources, source parity and engine output checks | Manual canvas acceptance or real pinyin input |
| `tests/overleaf-fixture.mjs` | Explicit disposable CE account/project; run inside the pinned CE container with web-service working directory | Production user/project creation or migration |
| `deployment/privacy-audit.py` | Read-only allowlisted source, optional exact Git index, optional matching source archive | Full vulnerability analysis or semantic detection of all private prose |
| Installed CE browser/lifecycle run | Chinese text, partial math/recovery, new paragraphs/deletion, included-file edits, pagination, two modes, access rejection, source-preserving restart and rollback | Precise SyncTeX in coarse environments, arbitrary templates, real OS IME or concurrent editors |

See [validation](VALIDATION.md) for completed checks and observed limitations. The initial uploaded commit passed GitHub source checks on 2026-11-11; the linked validation record identifies that exact run. Remote CI does not replace installed editor acceptance.

## Public inputs versus local-only artifacts

Publish only the reviewed source snapshot. Keep working copies, VM disks, installed dependencies, compiled binaries/frontend output, `.env`, state/checkpoints, logs, browser downloads, exported project ZIPs, raw diagnostics, credentials and private papers local. A generated checksum proves byte identity, not that an arbitrary directory is safe to publish. The matching source and staged Git index must also pass the [privacy gate](SECURITY_AND_PRIVACY.md).
