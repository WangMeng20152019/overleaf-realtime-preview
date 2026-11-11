# Compatibility and alpha acceptance

The source-first alpha targets **one copied project in one pinned Overleaf CE environment**. Follow the [installation procedure](installation/README.md) to build the engine and frontend and prepare, activate or roll back the integration. The local synthetic preview page remains a contributor tool.

## Supported input profile

| Component | Exact input or requirement | Current evidence |
|---|---|---|
| Overleaf CE | `sharelatex/sharelatex@sha256:a745d0fa67c0d05d8c29bb68502aac52416d92f5631fd6876334314658e1e19e`, Linux amd64; CE 6.2.2 image label | Official registry image inspected. Required four editor files match upstream `93a4f0c88a1aa3217db8773993ff178edff208d9` byte-for-byte; this is not a claim that the entire hotfixed image equals that Git tree. |
| Engine | realtime-tex v0.0.6, commit `98b40be29ef517918ce707869e6fe0316685b3dd`, with the reviewed downstream patch | Fresh static musl build executed in the pinned Linux image; synthetic Chinese text and four formula recovery forms passed. See [engine validation](../engine/validation-linux.json). |
| Engine build | Rust 1.99.1, locked dependencies, `x86_64-unknown-linux-musl`, exact matching ten-file support tree | Source/support/build manifests and dependency notices verified by build/package tools. Historical development binary hashes are not used to relabel fresh builds. |
| TeX | LuaLaTeX plus `luatexbase`; fixture also needs `ctex` and Fandol | Required packages installed and exercised in the isolated CE image. Other templates and fonts need their own package checks. |
| Frontend | Exact identity/native source profile, isolated pinned Yarn installation and production build | Preparation, dependency install and full build passed. Successful compile: about 102 seconds on a 4-CPU, 8-GB VM with 4-GB swap, application backends paused. An earlier build with backends active ran out of memory. |
| Lifecycle | Container root; stock verified runit link chain; Python 3.12/Linux pidfd support; immutable runtime manifest | Real installer preparation, activation, route-first rollback and reactivation passed. Private current-source checkpoints and exact process identities are used. Fresh startup, active VFS edits, repeat activation, route-first rollback/reactivation and a full container restart passed with current source preserved. |
| HTTP proxy | nginx with project authorization, fixed `/rtex-test/`, exact browser origin including port | Actual nginx tests preserved host and forwarded-host across auth/bridge/socket/project routes for port 18080 and a default HTTPS authority. Server host/origin guards remain strict. |
| Project input | Fresh user-downloaded ZIP plus administrator-exported complete entity metadata for the same copied project | Normal browser sign-in, ZIP download, metadata export and current-source parity checks succeeded in the test instance. |
| Browser | Traditional PDF/LuaLaTeX mode switch in Overleaf's existing right preview pane | Traditional two-page PDF and live mode displayed in the real editor. Chinese paragraph insertion, incomplete-math hold/recovery, pagination, distant edits, multi-paragraph deletion, included-file edits, ordinary-body following and the English forward button passed. Real operating-system IME is not covered. |
| Compose example | Pinned CE/MongoDB/Redis images; persistent base64 secret; loopback `127.0.0.1:18080` binding | [Example](../examples/compose.yml) booted from fresh volumes in a full x86 Linux QEMU VM; browser sign-in/export/editor access and container-restart source/routing recovery passed. |

## Boundaries

- One explicitly bound copied project and one controlling editor session. This is an administrator-installed integration for trusted TeX content, not a multi-tenant TeX sandbox.
- Realtime preview runs LuaLaTeX. Formal PDF compilation continues through Overleaf's existing compiler configuration; XeLaTeX templates may differ in fonts and layout.
- Repeated local paragraph edits can use incremental output. New structures, global dependencies and page breaks can require complete layout; there is no universal latency or 2-ms guarantee.
- Only the pinned source profile is accepted. An image tag, a similar CE release or a matching single file does not authorize unrelated frontend sources.
- Rollback removes scoped routing before stopping the owned service and preserves current project text. Unknown routing/process/file state is refused rather than overwritten. Private backups and generated assets remain after rollback.
- Full installed acceptance used an x86 Linux QEMU VM on an ARM Mac. The earlier Rosetta environment failed an independent process-inspection probe and is not a supported runtime for this release. These emulated timings are functional evidence, not a native-amd64 performance benchmark.
- The example Compose volume covers Overleaf application data. This procedure also creates helpers/runtime, frontend assets, runit entries and state elsewhere inside the CE container. Container recreation or an image upgrade needs a deliberate reinstallation/persistence plan; it is not established merely by restarting the current container.

## Session workflow

Realtime-mode exit drains and stops the source adapter. Traditional/offline/other-session edits can therefore make service memory stale. Reopening then pauses on snapshot mismatch. Administrator route-first rollback/reactivation refreshes from current canonical text, followed by editor reload; this recovery was tested. Automatic off-mode source takeover is not implemented. See [refresh instructions](installation/README.md#refreshing-a-stale-preview).

## Navigation and remaining validation

Position following uses the engine's available unit placements. Ordinary Body units and the English forward button were observed working. A source-end proof can select the last **available** displayed fragment of a Body or Env unit; it cannot create missing source/placement information. A coalesced Env containing subsequent text can still map to its first page even at its source endpoint. Included-file editing was observed, but its automatic position following is not certified. Exact character-level SyncTeX is not implemented; use traditional PDF when precise navigation is needed.

The alpha's installed synthetic scenarios are recorded in [VALIDATION.md](VALIDATION.md). Further work includes real operating-system pinyin/IME operation, sustained high-frequency typing, more templates and large projects, unsupported source profiles, detailed reconnect/stale-session matrices, reverse-navigation UI acceptance and multiple concurrent editors. These are not inferred from unit tests or historical private-server reports.

Container **restart** of the installed instance passed. Container **recreation** or image upgrade still needs the deliberate reinstallation/persistence plan described above. No universal installer or compatibility with arbitrary CE releases is claimed.
