# Writing a Tartan extension

A third-party extension gets the same contract as the first-party ones: a manifest (`tartan.json`), events, gates,
echo hooks, slots, tools and its own SQLite. It runs on one of two runtimes:

- **wasm**: a WebAssembly component on the `tartan:ext@0.1.0` WIT world (`packages/contract/wit/tartan.wit`), written
  in Rust with the `tartan-ext` SDK ([rust.md](rust.md)). The demo is `extensions/acme-no-secrets`, a credential
  scanner that vetoes advances.
- **js**: one ES module (bundled, no imports) whose default export implements the hooks of `ExtensionModule`
  (`@tartan/ext-api`'s `defineExtension`).

Both run as a Dynamic Worker **facet** of the installation's own Durable Object (the ExtensionDO): one Dynamic Worker
per installation and package version, no network (`globalOutbound: null`), an empty `env`, and a database of its own.
Capabilities (`KernelCaps`) are handed to each call and stop working when it returns.

## The package

| File                        | What                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tartan.json`               | the manifest: id (not `tartan.*`), version, `runtime`, `entry`, storage, permissions, hooks, slots, tools |
| `ext.js` + `ext.core*.wasm` | wasm: the jco glue (`--instantiation sync`, no JSPI) and its core modules                                 |
| `main.js`                   | js: the module                                                                                            |
| `migrations/NNNN_name.sql`  | forward-only migrations of the extension's own tables, applied in its facet before `init`                 |
| `imports.json`              | wasm: the functions the component imports (`<interface>#<function>`), written by the build                |
| `protocol.md`, schemas      | optional: the MCP protocol card (≤ 2 KB), tool input and settings JSON Schemas                            |

`deno task build:ext <name>` builds `extensions/<name>/` into `extensions/<name>/dist/`:

- wasm: `cargo build --release --target wasm32-unknown-unknown`, `wasm-tools component new`, `jco transpile
  --instantiation sync --no-typescript`; then the import record from the core modules, checked against the manifest's
  permissions;
- js: one esbuild bundle of `src/index.ts`.

It writes the package files, `publish.json` (the `PUT /-/api/packages` body, already validated by the kernel's own
check, which also gives the package sha256) and, for wasm, `bundled.js` (the `wasm-bundled` registration a deploy can
bundle into the Worker). It needs `cargo` with the `wasm32-unknown-unknown` target, `wasm-tools`, and jco
(`node_modules/.bin/jco`, or `JCO=<path>`); `CARGO_TARGET_DIR` is honoured.

## Publish, install, shadow, replay, promote

1. **Publish** (forge admin; a token needs the `admin` scope): `PUT /-/api/packages` with `dist/publish.json`. The
   kernel validates the manifest and its policy, the bundle (≤ 10 MiB, safe paths, every named file present) and, for
   wasm, the imports: every import of the core modules must be a function of the `tartan:ext@0.1.0` world, `notify`
   needs the `notify` permission and `contribute-note` the `notes` permission, and `imports.json` must equal what the
   modules import. The files go to R2 under `ext/<id>/<version>/<sha256>/`; versions are immutable.
2. **Install** at a node (`POST /-/api/installations`, Maintainer there; Owner for the cases on the install sheet),
   usually with `"mode": "shadow"` for a gate: a shadow gate is called beside the enforced ones, its decision is
   recorded, and it never blocks.
3. **Replay** the gate over real history: `POST /-/api/installations/<id>/replay` with `{"repo": "<path>", "n": 41}`
   rebuilds the `ref.advance` input of each of the repository's last `n` (≤ 50) advances (changed paths and added
   lines of `expectOld..newSha`, marked `advisory`), calls the gate and answers, for example, `{"summary": {"vetoed":
   2, "of": 41}}`: "would have vetoed 2 of the last 41 advances". A gate must not record anything for an `advisory`
   input.
4. **Promote**: `POST /-/api/installations/<id>/promote` makes the shadow installation the enforced one and disables
   the previous enforced copy of the same extension at that node, atomically.

## What a call sees

- **sql**: the extension's own database, synchronous. DML and DDL only; names starting with `_`, `sqlite_` or
  `pragma_` are reserved (pass such values as bindings); in `render` and context hooks only one `SELECT`/`WITH … SELECT`
  /`VALUES` runs, and a statement that wrote anyway is rolled back with `denied("read-only")`; above `storage.quotaMB`
  growth is `denied("quota")`.
- **kv**: the extension's own synchronous kv (`Uint8Array` values), read-only in render.
- **effects** (wasm): `emit`, `notify`, `contribute-note` and `set-timer` are buffered and applied through the kernel's
  capabilities only after the export returned `Ok`. Read-only calls, missing grants and shadow notices are refused at
  once; the event type and the recipient are checked when the buffer is applied, and a refusal there fails the call.
- **capabilities** (js): `x.caps.<namespace>.<method>(…)` runs on the kernel for this call only, with the installation's
  grants, the acting principal, read-only and shadow rules and the subtree confinement; `clock.now()` and `ids.ulid()`
  answer locally. A capability kept past its call fails with `unavailable`.
- **inputs**: gates and echo get their inputs prefetched (`added-lines`, …; `truncated: true` when they overflow the
  caps). A `ref.advance` gate that did not see the whole change leaves the decision to its `onTruncated` (veto by
  default) unless it answers `fullScan: true`.

## Limits and failure

Every call has a host-side wall-clock budget (render 1 s, events and actions 5 s, tools 10 s, gates per manifest). A
call that overruns is aborted (`facets.abort`) and counts as a strike; so does a call the platform kills (a CPU or
memory limit, a reset), after which the installation moves to a fresh Dynamic Worker. Three strikes in ten minutes open
the installation's circuit breaker: gates return their declared `default` (a security gate should declare
`"default": "veto"`), renders show an error chip, events wait, and an Owner is notified; after 15 minutes one call is
let through. Manifest `limits` (CPU per hook) are passed to the facet as defence in depth only.

## Testing

- Rust: `cargo test` for the pure logic (the SDK's types work natively; host imports only exist in the component).
- The component itself, end to end in Deno: `src/kernel/exthost/host/facet/wasm.test.ts` builds the Worker code the
  host would load (shim, glue, core modules) from `extensions/acme-no-secrets/dist/` and drives it through the real host
  (gates, echo, renders, tools, migrations, replay); it is skipped until the package is built.
- On workerd: `deno task test:workers --project exthost` runs a js package and the built component as real Dynamic
  Worker facets (Worker Loader, R2, the capability bridge).
