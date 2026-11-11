# Build the patched realtime-tex engine

This integration requires the reviewed downstream engine patch. An unmodified upstream binary is not interchangeable: it lacks the source/revision and superseded-capture guards that prevent an older background compile from replacing a newer preview.

The build tool fetches upstream realtime-tex **v0.0.6**, immutable commit `98b40be29ef517918ce707869e6fe0316685b3dd`, applies `overleaf-v0.0.6.patch`, and verifies the exact resulting Git diff, pinned source files, lockfile, and all ten TeX support files. It builds a runtime directory containing the executable, its matching support tree, upstream MIT license, and a machine-readable build manifest. It does not contact or modify an Overleaf installation.

## Requirements

- Python 3.10+, Git, and a [rustup](https://rustup.rs/) installation with Cargo.
- Rust **1.99.1**, the compiler used for the reviewed candidate. The script does not silently change the system default compiler.
- A C compiler/linker for a native build. The Linux x86-64 static build uses Rust's bundled `rust-lld` linker instead.
- To run the engine: TeX Live with LuaLaTeX and the packages/fonts required by the user's project. Building the Rust executable does not install TeX Live or fonts.

```sh
rustup toolchain install 1.99.1 --profile minimal
python3 engine/build.py prepare --workdir .local/engine-build
python3 engine/build.py verify --workdir .local/engine-build
```

If Git's HTTPS transport is unavailable, the official source archive has an independently pinned SHA256 and full Git tree hash in `upstream-source.json`:

```sh
python3 engine/build.py prepare --workdir .local/engine-build-archive --download-archive
# Or provide an already downloaded official archive:
python3 engine/build.py prepare --workdir .local/engine-build-offline --archive /path/to/realtime-tex.tar.gz
```

The archive path verifies every original file through the exact upstream Git tree before applying the same reviewed patch; it does not skip the source, lockfile or support checks. A locally created Git baseline records this verified file tree, rather than claiming that its synthetic commit has the upstream commit ID.

`prepare` requires a new directory. To prepare without GitHub access, provide `--repository /path/to/local/upstream-mirror`; the same immutable commit and byte-level checks remain mandatory. A failed preparation leaves its work directory for inspection; choose another path or remove that failed directory explicitly before retrying.

## Linux x86-64 runtime

This is the supported portable engine target for an amd64 Overleaf container. It can be built on a Linux x86-64 host or cross-built on macOS with the pinned Rust toolchain:

```sh
rustup target add --toolchain 1.99.1 x86_64-unknown-linux-musl
python3 engine/build.py build --workdir .local/engine-build --target x86_64-unknown-linux-musl
```

Output:

```text
.local/engine-build/runtime-x86_64-unknown-linux-musl/
  bin/rtex
  tex/                       # Matching upstream support files
  LICENSE.rtex
  build-manifest.json
  notices/                   # Pinned dependency notices and audit manifest
```

The static Rust executable still launches external TeX tools. It must execute on Linux x86-64; a successful cross-build on macOS is not proof that target-side TeX compilation works. Test the complete runtime in an isolated Linux container before activating it in Overleaf. The official Overleaf image selected by this candidate is amd64; an ARM host therefore also needs an appropriate amd64 VM/emulator to validate that image.

## Native development runtime

```sh
python3 engine/build.py build --workdir .local/engine-build --target native
```

This produces `runtime-<Rust-host-triple>/`. Native macOS output is for local development and cannot run inside a Linux container. Native Linux output may depend on the host's libc and linker; use the static musl target for the portable amd64 container runtime.

The stock pinned Overleaf CE 6.2.2 image used in the isolated validation has LuaLaTeX but lacks `luatexbase`, which the capture layer requires. For the synthetic Chinese article it also needs `ctex` and the Fandol fonts. Inside a disposable test container, the verified setup was:

```sh
tlmgr --repository https://mirror.ctan.org/systems/texlive/tlnet update --self
tlmgr --repository https://mirror.ctan.org/systems/texlive/tlnet install luatexbase ctex fandol
```

These commands change that container's TeX installation; they are not run automatically by the build tool. Use a TeX Live repository matching the installed TeX Live year. Additional template packages remain the user's responsibility.

Set `RTEX_BIN` to the packaged `bin/rtex` and `RTEX_TEXDIR` to that same package's `tex` directory. If TeX tools are outside PATH, set `RTEX_TEXLIVE_BIN` to their directory. Run the engine's `doctor` command in the target environment before enabling the bridge; TeX packages and fonts remain project-specific.

## Build verification and distribution

`candidate-pins.json` records the reviewed source/support pins and historical development binaries/tests. A fresh build writes its own `build-manifest.json` with compiler, target, binary SHA256 and byte size. The historical binary SHA256 does not automatically certify a newly built executable, and matching source inputs are not a promise of byte-identical builds across machines. Do not relabel a fresh binary with a historical hash or weaken the deployment check to accept it. Review and validate the fresh runtime, then create its explicit deployment profile.

Rust diagnostic paths are remapped to neutral source/cache/sysroot prefixes. Upstream also embeds its build source directory as a fallback for support discovery, so choose a neutral absolute work directory (for example `/tmp/rtex-public-engine-build`) when building an artifact intended for redistribution. The validated Linux artifact used a neutral temporary directory; its bytes were scanned for private workstation paths before packaging.

[validation-linux.json](validation-linux.json) records successful execution of that fresh Linux static build inside the exact official amd64 image: installation check, Chinese text, `$`, `$$`, `\[`, and nested equation/aligned recovery. This synthetic engine acceptance does not establish browser/IME behavior or interactive latency.

The build checks the reviewed source before and after Cargo, uses `--locked`, and refuses to overwrite an existing runtime package. Keep `LICENSE.rtex` with redistributed binaries. The Overleaf integration's license does not replace realtime-tex's upstream MIT notices or its dependencies' notices. Upstream source: [HenryXiaoYang/realtime-tex](https://github.com/HenryXiaoYang/realtime-tex/tree/98b40be29ef517918ce707869e6fe0316685b3dd).

## Source publication and compiled runtime notices

The source release contains the integration, reviewed engine patch, provenance pins and build tools. It does not include compiled engine executables, Cargo caches, development artifacts or project data. A user's local build creates a separate runtime package. Redistributing that compiled package requires preserving both `LICENSE.rtex` and the entire generated `notices/` directory.

During a build, `notices.py` selects the exact target/package normal-and-build dependency tree reported by `cargo tree -p rtex-cli --edges normal,build`, including build-time/proc-macro dependencies conservatively. Cargo's workspace-wide metadata alone would incorrectly include optional crates that were not selected for this binary. Every selected registry archive is checked against its Cargo.lock SHA256 before copying its actual LICENSE/NOTICE/COPYING/COPYRIGHT texts. Dependency implementation files are not copied. The matching Rust standard-library copyright bundle and supplied license corpus are also retained.

`notices/THIRD_PARTY.json` records declared license expressions, registry source, archive and manifest hashes, actual notice-text hashes, selected target packages, excluded workspace-optional packages and any `reviewRequired` entries. A missing text or unrecognized expression is reported explicitly; the tool never invents an owner or substitutes a guessed license. Review unresolved entries before distributing a compiled runtime. For the validated Linux build, 116 selected registry crates supplied 252 notice/audit files including Rust library notices, with no unresolved entries. `defmt-parser` is an excluded workspace-optional dependency, not a compiled dependency of this target. This inventory records declared provenance and preserved texts; it does not replace license review for a differently configured build.

To add notices to a pre-existing matching local build without rebuilding its executable:

```sh
python3 engine/build.py notices --workdir /path/to/verified-build --runtime /path/to/its/runtime
```

This explicitly checks the reviewed source tree, source/support pins, compiler and existing executable hash, then adds notices and updates the build manifest. It refuses to overwrite existing notice collections. The executable bytes remain unchanged. New `build` outputs collect notices automatically, and `deployment/package.py` refuses missing or changed notice files.
