# Rust extensions with `tartan-ext`

`sdk/rust/tartan-ext` is the Rust SDK for the `tartan:ext@0.1.0` world. It wraps the bindings wit-bindgen generates
from `packages/contract/wit/tartan.wit`, supplies a default for every export (WIT has no optional exports), and adds
UI builders, an SQL helper and gate decisions.

## A minimal extension

`Cargo.toml`:

```toml
[package]
name = "acme-hello"
version = "0.1.0"
edition = "2021"
license = "MIT"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
tartan-ext = { path = "../../sdk/rust/tartan-ext" }

[profile.release]
opt-level = "s"
lto = true
panic = "abort"
strip = true
```

`src/lib.rs`:

```rust
use tartan_ext::gate::Decision;
use tartan_ext::sql::{self, params};
use tartan_ext::ui::{self, Tone};
use tartan_ext::{export, host, parse_json, Error, Extension, GateDecision, Json, SlotContext};

struct Hello;

impl Extension for Hello {
    fn gate(point: String, input: Json, _ctx: SlotContext) -> Result<GateDecision, Error> {
        let input = parse_json(&input)?;
        let lines = input["addedLines"].as_array().map_or(0, Vec::len);
        if !input["advisory"].as_bool().unwrap_or(false) {
            sql::execute("INSERT INTO runs (point, lines) VALUES (?, ?)", &params![point.as_str(), lines as i64])?;
        }
        Ok(Decision::allow(format!("{lines} added lines")).build())
    }

    fn render(_slot: String, _ctx: SlotContext, _props: Json) -> Result<Json, Error> {
        let runs = sql::first("SELECT COUNT(*) AS n FROM runs", &[])?.and_then(|r| r.int("n")).unwrap_or(0);
        host::debug("rendered");
        Ok(ui::doc(ui::badge(format!("{runs} gate runs"), Tone::Info)).to_string())
    }
}

export!(Hello);
```

Every hook you do not implement answers with its default: `init`, `on_event`, `on_timer` succeed, `echo` returns no
lines, `provide_context` returns `[]`, and `gate`, `render`, `on_action` and `call_tool` answer `not-found` (the host
only calls hooks the manifest declares).

## The modules

| Module       | What                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `tartan_ext` | `Extension`, `export!`, the WIT types (`Event`, `SlotContext`, `GateDecision`, `Error`, …), `parse_json`        |
| `sql`        | `exec`, `execute` (rows written), `query` / `first` (rows by column name), `params![…]`, `Value: From<…>`       |
| `ui`         | `tartan-ui@1` nodes (`doc`, `section`, `stack`, `table`, `kv`, `badge`, `alert`, `link`, `button`, …), `result` |
| `gate`       | `Decision::allow/advise/veto(…).annotate(path, line, text).full_scan(bool).build()`, cut to the kernel's limits |
| `host`       | `log`/`debug`/`info`/`warn`/`error`, `config()` (the installation settings), `now_ms`, `random`, `ulid`         |
| `effects`    | `emit`, `notify`, `contribute_note`, `set_timer` (buffered, applied after an `Ok` export)                       |
| `kv`         | the generated `get`, `put`, `delete`, `list_keys`                                                               |

Only what you call is imported: the build records the component's imports in `imports.json`, and publishing refuses a
package whose imports need a permission the manifest does not grant (`notify`, `notes`).

## Building and testing

```sh
cargo test --manifest-path extensions/<name>/Cargo.toml   # pure logic, natively
deno task build:ext <name>                                 # the component and the package
```

Host imports exist only inside the component (natively they are `unreachable!()`), so keep detection and rendering in
plain functions and unit-test those; drive the component itself through the host with the Deno or workerd tests
described in [README.md](README.md). Each call runs on a fresh component instance, so a panic (`panic = "abort"`, a
trap) fails only that call and no state survives between calls except SQLite and kv.
