# Overleaf Realtime Preview

[中文](README.md)

Connect [realtime-tex](https://github.com/HenryXiaoYang/realtime-tex) to self-hosted [Overleaf CE](https://github.com/overleaf/overleaf), with traditional PDF and LuaLaTeX realtime modes in the existing right-hand preview pane.

> **Experimental source release · 0.1.0-alpha.2**  
> This source release includes build tools and has been exercised in one pinned installation with synthetic browser editing, rollback and container restart. See the [compatibility matrix](docs/COMPATIBILITY.md) and [validation record](docs/VALIDATION.md) for current evidence.

This started with a practical wish while writing a Chinese thesis: keep the familiar Overleaf editor and spend less time waiting for complete compilations. The integration grew through repeated use and reports of slow first edits, incomplete formulas, disappearing content and deleted text returning. We are sharing that work so others with similar needs can try it, reproduce problems and improve it.

## Built on upstream work

The foundation comes from **[realtime-tex](https://github.com/HenryXiaoYang/realtime-tex), [Overleaf CE](https://github.com/overleaf/overleaf), and [realtime-tex-vsc-plugin](https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin)**: the typesetting engine, editing platform and browser rendering components. This repository contributes integration, downstream patches, state coordination, navigation, recovery and deployment tooling. Original authorship and license notices are preserved.

**Most implementation, debugging and test construction was done with ChatGPT/Codex.** The human project initiator supplied the goals, used the result in real Chinese writing, reported failures and checked the changes in practice. Tests and usage boundaries are recorded separately. See [development and attribution](docs/DEVELOPMENT.md).

![Synthetic document in the disposable Overleaf instance](docs/images/preview.png)

The screenshot contains a synthetic document, not a private manuscript.

## What is implemented

- A traditional-PDF/LuaLaTeX switch in Overleaf's existing preview pane.
- Local updates for eligible paragraph edits while full layout continues in the background.
- Editor events and source maps for preview positioning and navigation.
- Consistency and recovery checks around new paragraphs, partial formulas, repeated edits, deletion and background captures.
- Pinned engine builds, isolated frontend builds, project binding, service lifecycle and proxy rollback tools.

Realtime preview uses **LuaLaTeX**. Formal PDF compilation keeps Overleaf's existing compiler settings. XeLaTeX templates need font and layout checks. Structural changes, pagination and global dependencies can require a complete layout. There is no fixed latency, arbitrary-template or arbitrary-Overleaf-version compatibility guarantee.

Position following uses engine-mapped units. Ordinary text can follow the caret; complex multi-page environments and some included-file mappings remain coarse or incomplete, including some source endpoints. This is not character-level SyncTeX. Traditional PDF remains available for precise positioning. Real operating-system IME input, additional templates and multi-user concurrency need further validation.

Keep realtime mode active while editing in this alpha. Edits made in traditional mode, while disconnected, or in another session may pause realtime startup because its snapshot differs. An administrator must [refresh from current canonical text](docs/installation/README.md#refreshing-a-stale-preview); automatic takeover of those edits is not implemented.

[Environment and tests](docs/ENVIRONMENT_AND_TESTS.md) · [Privacy and publication checks](docs/SECURITY_AND_PRIVACY.md)

## Getting started

Read the [installation and acceptance procedure](docs/installation/README.md) first and use a copied project in a separate test instance. The first release targets **Linux amd64, one pinned Overleaf source/image profile, one bound project and one controlling editor session**. The documentation lists the exact image digest, TeX requirements, operational prerequisites and validation boundaries.

Fresh validation covers the engine build, Chinese text and four formula-recovery forms, actual installation and route rollback, synthetic browser editing and mode switching, and source-preserving container restart. The validation record distinguishes these checks from broader untested scenarios and historical private-server reports.

The source archive contains integration code, the engine patch, notices and build tools. Runtime files are built locally; private documents, development caches, engine executables and TeX fonts are excluded. To check the integration source build:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:deployment
```

These commands build and test this repository. Continue with the [installation guide](docs/installation/README.md) for the engine, frontend and service. The [engine guide](engine/README.md) includes checksum-verified official archive downloads, matching support files and dependency-notice collection.

## Feedback and contributions

Reports that reproduce a failure with a small synthetic document are especially useful. Include the sequence of edits, compiler/template and the final observed state. Remove private manuscript content, account information, access tokens and sensitive diagnostic data before sharing.

The [bug history](docs/BUG_HISTORY.md) describes the feedback that shaped this work. Contributors can begin with the [synthetic preview page](dev/preview/README.md), which exercises real editor transactions, bridge and renderer code. It complements installed-Overleaf acceptance.

[Attribution](docs/DEVELOPMENT.md) · [Validation](docs/VALIDATION.md) · [Compatibility](docs/COMPATIBILITY.md) · [Changelog](CHANGELOG.md) · [Release plan](docs/RELEASE_PLAN.md)

## License

The integration is provided under **AGPL-3.0-only**; see [COPYING](COPYING). Third-party components retain their original licenses and credits; see [THIRD_PARTY.md](THIRD_PARTY.md). The first public distribution is source-only. Redistributing a compiled runtime also requires preserving its generated component licenses and notices.
