# acme.no-secrets

A third-party Tartan extension written in **Rust and compiled to a WebAssembly component** (`tartan:ext@0.1.0`). It is
published and installed like any third-party package (`id` outside `tartan.*`, `runtime: "wasm"`, no permissions), and
runs as a Dynamic Worker facet of its installation's own Durable Object, with its own SQLite.

| Contribution                | What it does                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ref.advance` gate          | vetoes an advance that adds AWS access or secret keys, PEM private keys, or a `.env` file; `default: "veto"` |
| `push.accepted` echo        | `remote: [no-secrets] …` lines for the credentials a push adds (the gateway does not deliver echo lines yet) |
| `change.sidebar` `findings` | the change's findings and its last gate decision                                                             |
| `change.gate` `no-secrets`  | the gate chip (pending, clean, n credentials)                                                                |
| `repo.tab` `secrets`        | the repository's recent findings and the gate's record                                                       |
| tool `scan`                 | a change's findings, or a scan of a snippet before it is pushed (`no_secrets_scan` over MCP)                 |
| setting `allow`             | globs of paths that may hold test credentials (`fixtures/**`)                                                |

Findings never hold a credential, only a masked form (`AKIA…MPLE`). Gate replays (`advisory` inputs) record nothing.

Layout: `src/detect.rs` (the detectors, globs and masking; pure), `src/store.rs` (its tables), `src/lib.rs` (the
hooks and panels), `migrations/0001_init.sql`, `tartan.json`.

```sh
cargo test --manifest-path extensions/acme-no-secrets/Cargo.toml
deno task build:ext acme-no-secrets      # → extensions/acme-no-secrets/dist/ (never committed)
```

The authoring guide is [docs/ext/](../../docs/ext/README.md). License: MIT.
