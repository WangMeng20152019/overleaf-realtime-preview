# Install the source-first alpha

This procedure adds a traditional-PDF/LuaLaTeX-preview switch to the right pane of **one copied project** in the pinned Overleaf CE environment below. It builds the engine and frontend from source and installs a project-bound service with reversible nginx routing. Start in a separate test instance with trusted project content and one controlling editor session.

The real installer has passed preparation, activation, routing rollback and reactivation in this environment. Browser live connection, regression and full restart acceptance are still being completed; see [compatibility](../COMPATIBILITY.md). This is an alpha for one verified source profile, not an installer for arbitrary Overleaf versions. Realtime preview uses LuaLaTeX; Overleaf's existing compiler settings and formal PDF route remain available. Large structural changes and pagination can still require a complete layout.

## 1. Choose the environment

The tested target is `linux/amd64`:

```text
sharelatex/sharelatex@sha256:a745d0fa67c0d05d8c29bb68502aac52416d92f5631fd6876334314658e1e19e
```

Its label is CE 6.2.2. The four editor source files required by the native observer were independently matched to upstream commit `93a4f0c88a1aa3217db8773993ff178edff208d9`; this does not claim that every hotfix in the image equals that Git commit. The installer checks the exact supported source profile.

You need Docker with an amd64 execution environment, host Node.js 24/npm, Python 3, Git, and rustup. Inside this CE image, the service uses Python 3.12, Linux pidfd signalling, the stock root-owned runit layout, and nginx. All installation commands inside the container run as root. An ARM workstation needs an amd64 VM/emulator for this image.

[examples/compose.yml](../../examples/compose.yml) pins the CE, MongoDB and Redis images and exposes only `127.0.0.1:18080`. From the repository root, generate its persistent secret **once**:

```sh
python3 deployment/demo-env.py --output examples/.env
docker compose --env-file examples/.env -f examples/compose.yml up -d
RTEX_CE_CONTAINER="$(docker compose --env-file examples/.env -f examples/compose.yml ps -q overleaf)"
```

The generator writes a new mode-0600 file containing 32 random bytes encoded with standard base64, matching the [pinned CE initialization guidance](https://github.com/overleaf/overleaf/blob/93a4f0c88a1aa3217db8773993ff178edff208d9/server-ce/init_scripts/000_check_missing_secrets.sh). It prints no secret and refuses existing files or symlink paths. Keep `examples/.env` and the data volumes across restarts; rerunning the command cannot rotate an existing secret. The fresh-Compose browser and container-restart procedure was exercised in a disposable instance of the exact CE image. Complete Overleaf's normal administrator setup before using the integration. Keep this example bound to loopback; an internet-facing instance needs its usual HTTPS deployment and access controls.

## 2. Build the bridge and matching engine

Run these commands in a clean source checkout on the host. Build outputs are local and are not part of the source publication.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:deployment

rustup toolchain install 1.99.1 --profile minimal
rustup target add --toolchain 1.99.1 x86_64-unknown-linux-musl
python3 engine/build.py prepare --workdir /tmp/rtex-public-engine-build --download-archive
python3 engine/build.py build --workdir /tmp/rtex-public-engine-build --target x86_64-unknown-linux-musl
python3 deployment/package.py \
  --engine-runtime /tmp/rtex-public-engine-build/runtime-x86_64-unknown-linux-musl \
  --output .local/rtex-runtime
```

The engine helper verifies the pinned upstream tree, downstream patch, compiler, source files and all ten TeX support files. Its output includes the build manifest and dependency notices. Packaging verifies that manifest and assembles the bridge, browser files, matching engine/support and licenses. Work and output directories must be new; use a fresh path for a deliberate rebuild. See [engine build instructions](../../engine/README.md) for archive/offline alternatives and requirements.

Copy only the public helper sources and assembled runtime into the test container. Do not copy a private development repository, project history, credentials or raw diagnostics.

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" mkdir -p /opt/overleaf-realtime/integration
tar -cf - deployment/*.py deployment/*.cjs integration/source-patch/*.py integration/source-patch/*.ts | \
  docker exec -i -u 0 "$RTEX_CE_CONTAINER" tar -xf - -C /opt/overleaf-realtime
docker cp .local/rtex-runtime "$RTEX_CE_CONTAINER":/opt/overleaf-realtime/runtime
docker exec -u 0 "$RTEX_CE_CONTAINER" chown -R 0:0 /opt/overleaf-realtime
```

`docker cp` can retain host ownership. The explicit ownership step is needed for the private-file and lifecycle guards.

## 3. Correct stock settings, prepare TeX and build the frontend

The pinned image contains an independent stock configuration mismatch: its corrected source template assigns invite-token options to `settings`, but the active `/etc/overleaf/settings.js` copy assigns them to `module.exports` before a later export replaces that object. As a result, sharing-token encryption logs a missing-secret error even when the persistent secret is present. The [official one-line correction](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/server-ce/hotfix/6.2.2/fix_invite_token_secret.patch) fixes that assignment; changing or regenerating the secret does not fix the discarded options.

The helper checks the exact old active file and official corrected source before changing one line. It preserves ownership/mode and creates a new private backup. It refuses custom settings, unexpected files, symlinks and concurrent edits. Run `apply` only when `check` reports `correctionNeeded: true`; if the file is already corrected, skip that apply command.

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/ce-settings.py check
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/ce-settings.py apply \
  --state /var/lib/rtex-ce-settings-backup
docker exec -u 0 "$RTEX_CE_CONTAINER" sv -w 45 restart \
  /etc/service/web-overleaf /etc/service/web-api-overleaf
```

The helper itself does not restart services or print/change the secret. The explicit restart reloads the corrected settings in the test web processes. This is an official stock-image prerequisite, separate from preview routing rollback; its private backup is retained. A custom configuration is outside this exact helper profile and must be reviewed separately rather than overwritten.

The stock image has LuaLaTeX but lacked `luatexbase` required by capture. The synthetic Chinese fixture also needed `ctex` and Fandol. These commands modify only the selected container's TeX installation:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" tlmgr \
  --repository https://mirror.ctan.org/systems/texlive/tlnet update --self
docker exec -u 0 "$RTEX_CE_CONTAINER" tlmgr \
  --repository https://mirror.ctan.org/systems/texlive/tlnet --no-execute-actions install luatexbase ctex fandol
docker exec -u 0 "$RTEX_CE_CONTAINER" mktexlsr
docker exec -u 0 "$RTEX_CE_CONTAINER" env \
  RTEX_TEXDIR=/opt/overleaf-realtime/runtime/deployment/runtime-support/tex \
  /opt/overleaf-realtime/runtime/deployment/runtime-linux/bin/rtex doctor
```

The scoped package command skips unrelated format regeneration; `mktexlsr` refreshes the file database needed by LuaLaTeX. It does not rebuild optional Japanese formats installed as package dependencies. Use a TeX Live repository matching the installed TeX Live year. Additional packages and fonts depend on your template. Keep the packaged support directory paired with its engine.

The frontend build makes a separate copy of `/overleaf`, verifies both source profiles, applies the identity patch followed by the native observer, and uses the source tree's pinned Yarn resolution. It leaves the original Overleaf source files in place.

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/frontend.py \
  --source /overleaf --stage /var/lib/rtex-build --prepare
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/frontend.py \
  --source /overleaf --stage /var/lib/rtex-build --install
```

For this **dedicated test instance only**, the successful low-memory build paused the stock application backends and resumed them afterward. The services matching `*-overleaf` include web, real-time, document-updater, storage, history and related application services; this interrupts the test editor. The shell trap resumes them when the build command exits. Do not apply this command to a shared production instance.

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" /bin/sh -c '
  trap "sv up /etc/service/*-overleaf" EXIT
  sv down /etc/service/*-overleaf
  python3 -B /opt/overleaf-realtime/deployment/frontend.py \
    --source /overleaf --stage /var/lib/rtex-build --build
'
```

Compilation needs substantial memory. The successful run used a 4-CPU, 8-GB VM with 4 GB of swap and the Overleaf application backends paused; compilation took about 102 seconds. An earlier run with the backends active ran out of memory. Allow a maintenance window and restore the stock application services after compilation. The helper limits webpack to two CPUs, a 4096-MB Node heap and parallelism of two. That measured compile time is not an end-to-end installation estimate.

The output consumed by the installer is `/var/lib/rtex-build/frontend-public`, including its generated `manifest.json`. A failed build leaves private logs in the stage directory for inspection. Do not retry preparation into an existing stage or bypass a refused source tuple.

## 4. Export one current copied project

Sign in through the normal Overleaf browser page, create or import a **copy** of the project, and download its project ZIP. Record the 24-character project ID from that copied project's URL. Stop editing while exporting, preparing and first activating it.

On the host, set `RTEX_PROJECT_ID` to that ID and place the downloaded ZIP at `.local/project.zip`. Keep it out of version control. The administrator-side exporter reads only that project's entity IDs/names and main-document identity from the configured Overleaf database; it writes private metadata, not document bodies.

```sh
# Replace this value with the copied project's actual 24-character ID.
RTEX_PROJECT_ID=PASTE_COPIED_PROJECT_ID

docker exec -u 0 "$RTEX_CE_CONTAINER" install -d -m 700 /var/lib/rtex-input
docker cp .local/project.zip "$RTEX_CE_CONTAINER":/var/lib/rtex-input/project.zip
docker exec -u 0 "$RTEX_CE_CONTAINER" chown 0:0 /var/lib/rtex-input/project.zip
docker exec -u 0 "$RTEX_CE_CONTAINER" chmod 600 /var/lib/rtex-input/project.zip
docker exec -u 0 "$RTEX_CE_CONTAINER" node /opt/overleaf-realtime/deployment/export-project.cjs \
  --project-id "$RTEX_PROJECT_ID" --web-root /overleaf/services/web \
  --output /var/lib/rtex-input/project-tree.json
```

The ZIP and metadata must describe the same complete project. Preparation checks all imported resource hashes and current canonical document contents. If it reports that the ZIP is behind the source, export again into new input paths; do not overwrite the authoritative document to match an old ZIP.

## 5. Prepare and activate

The following paths are inside the container. Use a new private state directory and the dedicated new `rtex-app-assets` directory. Keep the private state, immutable runtime, canonical Overleaf source and isolated build separate. Set `--main` to the project's actual main file; the example uses `main.tex`.

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py prepare \
  --state /var/lib/overleaf-realtime \
  --runtime /opt/overleaf-realtime/runtime \
  --source /overleaf \
  --frontend /var/lib/rtex-build/frontend-public \
  --manifest-before /overleaf/services/web/public/manifest.json \
  --assets /overleaf/services/web/public/rtex-app-assets \
  --project-zip /var/lib/rtex-input/project.zip \
  --tree /var/lib/rtex-input/project-tree.json \
  --project-id "$RTEX_PROJECT_ID" \
  --origin http://127.0.0.1:18080 \
  --main main.tex \
  --bridge-port 44175 --web-port 4000 --document-updater-port 3003 --nginx-port 80

docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py activate \
  --state /var/lib/overleaf-realtime
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py status \
  --state /var/lib/overleaf-realtime
```

`--origin` is the exact browser origin, including a non-default port. The bridge binds to loopback; nginx preserves the incoming host/port and authorizes access through Overleaf's project endpoint. The preview prefix is fixed at `/rtex-test/`.

Preparation imports the project into private state, copies only verified frontend assets, attaches the trusted launcher, tests the isolated nginx candidate, and creates a down-marked runit service. Activation starts the foreground supervisor, checkpoints **current canonical** sources into its private mirrors, verifies source parity, and then enables the scoped nginx routes. It preserves the original server configuration and file ownership/modes for rollback. Unknown source profiles, modified runtime inventories, unrelated nginx edits and uncertain process ownership are refused.

Open the copied project's editor and select **LuaLaTeX realtime** in the existing right pane. Traditional PDF remains selectable. Use only the bound project and a single controlling editor session; this alpha does not provide per-user sandboxing for untrusted TeX projects.

## 6. Roll back routing and service

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py rollback \
  --state /var/lib/overleaf-realtime
```

Rollback restores the original nginx route before stopping the owned runit service and its verified children. It keeps current canonical project text and private state; it does not restore an old project snapshot or delete your data. If routing cannot be verified as restored, the installer retains the service and refuses to continue. Do not kill it or delete its private state to force a rollback through that refusal. Inspect the private transaction records and resolve the changed configuration first.

To reactivate the same intact installation, run `activate` again. Repeating activation on a healthy active installation is idempotent. Use the installer/runit lifecycle; direct `service.py start`/`run` stay in the foreground, and standalone `stop` refuses a different live foreground controller. A rollback is not an uninstall: assets, source-build outputs and private backups remain for inspection.

## Refreshing a stale preview

Realtime's adapter drains and stops when you leave realtime mode. If you edit in traditional mode, offline or in another editor session, the saved Overleaf text can move ahead of the preview's memory. Reopening can show `Initial snapshot mismatch` and pause. Clicking realtime again alone does not refresh that old service snapshot. The alpha intentionally refuses unverified replacement.

Stop editing and let Overleaf finish saving. As the administrator, refresh the same intact installation from **current canonical** source:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py rollback \
  --state /var/lib/overleaf-realtime
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py activate \
  --state /var/lib/overleaf-realtime
```

Then reload the editor and enable realtime. The route-first stop and fresh checkpoint preserve saved Overleaf text; they do not reimport an old ZIP. This recovery was exercised after restoring both synthetic files while in traditional mode. A changed project tree/resource binding is a different condition and still requires a reviewed reimport. Keep realtime active while editing if you want continuous preview updates in this alpha.

## Acceptance scope

The pinned synthetic installation passed live display, traditional/live switching, Chinese text, incomplete-math recovery, new paragraphs, pagination, multi-paragraph removal, included-file edits, ordinary-body positioning, repeat activation, route-first rollback/reactivation and current-source-preserving container restart. See [validation](../VALIDATION.md) for the exact scope and environment.

Real operating-system IME, more templates, large documents, detailed stale-session/reconnect cases and concurrent editors remain further validation work. Navigation is limited to available engine unit placements; complex environments and included files may not position accurately. Traditional PDF remains the precise-navigation fallback. Container recreation/image upgrades require reinstalling or deliberately persisting the non-volume installation artifacts.
