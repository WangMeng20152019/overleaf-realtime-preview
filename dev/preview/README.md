# Synthetic local debugging page

From the repository root, run `npm ci` and `npm run build`. Set RTEX_BIN and RTEX_TEXDIR to the matching patched engine and TeX support tree, optionally RTEX_TEXLIVE_BIN to the TeX executable directory, then run `npm run dev:check` and `npm run dev:preview`. This is a developer tool; the Overleaf installation entry is docs/installation/README.md. `npm run dev:check` builds private scoped client/server/render bundles and exits without starting the server. `npm run dev:preview` starts a bounded local fixture and prints its project URL. Engine and TeX paths are explicit environment settings.

The page uses actual CodeMirror transactions, the native observer, the project-entry adapter, the bridge and the real renderer. Only the Overleaf-specific trackChangesAnnotation import is substituted with a local Annotation. A synthetic local canonical service models saving; this is not a full Overleaf installation.

Controls include capture-retirement regression, retained edits, body-window scenarios, a 14-step location/delete matrix, five Chinese paragraphs, staged formula input, source navigation, and downloadable JSON receipts. Test text is synthetic. Matrices check editor/canonical/mirror source parity and return to baseline. Do not overlap controls or replace fixture source with private documents.

A passing matrix is not proof of remote performance, OS IME behavior, all visible glyphs, or production Overleaf compatibility. Visual inspection and full source checks complement automatic receipts. Engine errors and missing resources must be reported honestly.

Default lifetime15minutes, maximum30minutes via --duration-ms; Ctrl+C cleans up owned services and synthetic project. Do not kill processes by name. Generated state, scoped bundles, synthetic projects and logs must stay untracked.

See the [environment/test map](../../docs/ENVIRONMENT_AND_TESTS.md) and [privacy policy](../../docs/SECURITY_AND_PRIVACY.md). Generated state, logs and downloaded diagnostic receipts are local-only even when their document text is synthetic.
