# rawkode.issues

Per-repository issues for Tartan, written in **Rust and compiled to a WebAssembly component** (`tartan:ext@0.1.0`). It
is published and installed like any third-party package (`id` outside `tartan.*`, `runtime: "wasm"`, no permissions),
and runs as a Dynamic Worker facet of its installation's own Durable Object, with its own SQLite: `storage.scope:
"repo"`, so each repository has its own database and its own issue numbers (`#1`, `#2`, …).

| Contribution        | Role      | What it does                                                                         |
| ------------------- | --------- | ------------------------------------------------------------------------------------ |
| `repo.tab` `issues` | Reporter  | the Issues page: open and closed counts, the newest 100 issues, a "New issue" form   |
| action `create`     | Reporter  | the form's submit: opens an issue as the viewer, then a toast and a re-render        |
| tool `list`         | Reporter  | `state` (`open` by default, `closed`, `all`), `limit` 1–100 (30); no bodies          |
| tool `get`          | Reporter  | one issue by `number`, with its body                                                 |
| tool `create`       | Reporter  | `title` (one line, ≤ 200 characters), `body` (Markdown, ≤ 20000); the caller authors |
| tool `close`        | Developer | closes an issue by `number`; `changed: false` when it already was closed             |
| tool `reopen`       | Developer | reopens an issue by `number`; `changed: false` when it already was open              |
| `protocol.md`       |           | the MCP protocol card                                                                |

Over MCP the tools are `issues_list`, `issues_get`, `issues_create`, `issues_close` and `issues_reopen`. Opening an
issue is a Reporter action, like commenting: the host applies the tab's role to its form, so the `create` tool has the
same role. Changing an issue's state needs Developer and has no button in the tab yet, since a slot's actions all share
the slot's role. An issue's author is the actor the host gives the call (`kind` and `id`, and `on_behalf_of` for an
agent acting for a user).

Layout: `src/issue.rs` (argument checks, JSON shapes and the tab document; pure), `src/store.rs` (the `issues` table),
`src/lib.rs` (the hooks), `migrations/0001_init.sql`, `protocol.md`, `tartan.json`.

```sh
cargo test --manifest-path extensions/issues/Cargo.toml
deno task build:ext issues      # → extensions/issues/dist/ (never committed)
```

The build needs `wasm-tools` 1.248.0 (`cargo install --locked wasm-tools@1.248.0`, or `WASM_TOOLS`). The authoring guide
is [docs/ext/](../../docs/ext/README.md). License: MIT.
