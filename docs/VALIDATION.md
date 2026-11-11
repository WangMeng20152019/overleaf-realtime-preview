# Validation record — 2026-11-10

## Clean source build

The source archive was extracted outside the development repository and its ancestors, without sibling dependency directories. With Node 24.22.1 and npm 10.9.4 on macOS arm64:

| Check | Result |
|---|---|
| Fresh `npm ci --ignore-scripts` | Passed; lockfile unchanged |
| Application/server/integration build | Passed |
| JavaScript regression tests | 32 passed, zero failed/skipped |
| Python deployment/package/release tests | 144 passed, zero failed/skipped |
| Scoped synthetic preview build | Passed |
| Local documentation links | 57 checked, no missing targets at review |

The final executable-source snapshot was cleanly extracted and verified after the VFS checkpoint and navigation changes. Later documentation/demo-image updates have their own final archive manifest and checksums. GitHub execution is recorded separately below.

## Fresh engine and component installation

- Official realtime-tex v0.0.6 source was verified by archive checksum and Git tree, patched, and freshly built as static `x86_64-unknown-linux-musl` using Rust 1.99.1 and locked dependencies.
- Engine SHA256: `29b917aca250344f720484771090aabd97ac3bfd04a6e98996f692dda6614206`. Its exact matching support tree and selected dependency notices were verified before runtime assembly.
- The engine doctor and real Chinese-text formula recovery tests passed for `$`, `$$`, `\[`, and `equation` with `aligned`: incomplete input, completed formula, a subsequent edit, and source restoration. See [machine-readable engine evidence](../engine/validation-linux.json).
- The immutable official CE image and its four required editor files were inspected and matched to the source profile in [COMPATIBILITY.md](COMPATIBILITY.md).
- Identity and native-observer patches were applied to a separate frontend copy. Pinned dependency installation and full production build passed. The successful compile took about 102 seconds with application backends paused on a 4-CPU, 8-GB VM with 4 GB swap; an earlier concurrent build exhausted memory.
- A synthetic project was created in the disposable CE instance. Normal browser sign-in, actual project ZIP download, administrator metadata export, full binding and current canonical-source parity passed.
- Actual installer preparation, activation, route-first rollback and reactivation passed in that component instance. This does not establish full editor acceptance.
- Actual nginx tests covered isolated candidate/rollback configuration checks, ordinary and supported symlink layouts, and port-preserving Host/forwarded-host on project, bridge, auth and socket routes.

## Fresh installed editor and lifecycle acceptance

The complete x86 Linux QEMU VM used 4 CPUs and 8 GB RAM on an ARM Mac. Fresh Compose volumes were created from the pinned example. The MongoDB health check was extended to allow slow-machine shell startup while retaining a real database ping. This is functional acceptance under emulation, not a native-server latency benchmark.

| Actual check | Observed result |
|---|---|
| Normal browser sign-in, project list and ZIP export | Passed with a disposable account and synthetic two-file project |
| Traditional PDF | Two pages displayed, including Chinese and equation/aligned content |
| Existing right-pane traditional/live switch | Both modes displayed; live mode reopened after refresh |
| New Chinese paragraph | Correct visible placement after full layout |
| Partial `$\mathbb`, completion and subsequent text | Input hold preserved the last good preview; completion recovered |
| Reflow/page crossing | The synthetic document grew from two to three pages and settled without dropping retained text |
| Distant edits plus included-file edit | Current text retained across locations; included-file change was visibly present in the preview |
| Select/delete several newly added paragraphs and formula | Removed content disappeared; distant and included-file edits were retained |
| Ordinary Body follow and English forward button | Editing followed to the mapped page; after manual scrolling, the native button moved the preview scroll position from 0 to 711 in that viewport |
| Actual authenticated access checks | Authorized project 200; anonymous backend/proxy/resource 401; wrong host/origin/project/document 403 |
| Edited source then repeat activation | Healthy and idempotent after the VFS checkpoint correction |
| Route-first rollback/reactivation | Routing restored before the owned service stopped; current canonical source was preserved |
| Full container restart | Service and scoped routing recovered; both edited canonical-source hashes were preserved and checkpointed anew |
| Traditional-mode edits then realtime reopening | Snapshot mismatch paused as designed; administrator rollback/reactivation reloaded current canonical text without reimporting the old ZIP |

### Corrections found during acceptance

- The first ARM/Rosetta run hit a runtime assertion and SIGTRAP in process inspection. A separate Python probe reproduced it outside this project. Exact ownership checks were retained; the full x86 Linux VM replaced that environment.
- The pinned CE image had an official corrected settings template but a stale active copy. The guarded one-line helper was applied with a private backup; effective invite-encryption options loaded after the controlled web restart. No secret rotation was needed.
- The engine keeps edits in VFS memory, so current source must be checked against bridge memory. Its startup disk files are now independently sealed; they are not incorrectly required to track every live edit. The corrected health/idempotence path was exercised after real browser changes.
- English native navigation labels were previously missed. Exact English/Chinese routing and endpoint tests were added, with the English forward action observed in the real UI.

### Limits observed, not hidden by the tests

Off-mode edits are not continuously synchronized: leaving realtime drains/stops its adapter. Traditional/offline/other-session edits can require the administrator refresh procedure. This was observed during synthetic cleanup and is a published alpha workflow restriction.

A coalesced Env can cover following source text while available placements describe only its earlier content. Its source endpoint can therefore still resolve to the first page. Interior complex-environment and included-file positioning are not certified as exact; the implementation selects available fragments and does not invent coordinates. Traditional PDF provides the precise-navigation alternative.

The actual browser scenario used committed Chinese input/paste and keyboard actions. It is not a real macOS pinyin/IME test. Sustained typing, arbitrary templates, large documents, reverse-navigation UI, detailed stale-session/reconnect cases and multiple controlling editors remain further work. A browser diagnostic Blob download was not verified in the in-app automation surface; no result from that attempt is counted as passed.

## Earlier private development

Earlier NAS work recorded 620 bridge tests, 108 engine tests and a long Chinese thesis preview. Those are historical reports, not tests performed on this cleaned public snapshot. Private papers, raw diagnostics, accounts, server configuration and screenshots are excluded from the source package.

No production/NAS files were changed during this local release preparation. Subsequent GitHub publication checks are recorded below.

## Privacy follow-up — 2026-11-11

The alpha.2 update adds publication tooling, CI configuration and environment/privacy documentation. It does not change the engine, bridge, editor integration or renderer used in the installed Nov 10 acceptance. Thirteen additional privacy-gate tests cover staged excluded files, changed index bytes, unreviewed source, symlinks, credential patterns, mismatched/tampered archives and an incorrect repository root. The current Python suite totals 157 tests.

The prior release's exact bytes were rechecked: no maintainer account name, private NAS label or RFC1918 address was found in its public files. Mongo-shaped IDs were synthetic repeated-character/sequence fixtures; email matches were upstream license attribution or example-domain fixtures. Source image pixels were the previously reviewed synthetic document and its metadata remained stripped. Maintainer-specific fingerprint constants were moved to a protected local denylist rather than included in public source. These are scoped checks, not an external security audit.

## GitHub source checks — 2026-11-11

The first uploaded commit, `853967170f1c45ba74fafca445a6bef9f11c538f`, passed the [source checks workflow](https://github.com/WangMeng20152019/overleaf-realtime-preview/actions/runs/42985756033). The workflow performs dependency installation, build, JavaScript tests, Python tests, scoped debug-page checking and the staged-source privacy gate on Ubuntu with Node 24. This is remote source/build verification; it does not add installed Overleaf, performance or real-IME acceptance. Later documentation changes must pass their own workflow run.
